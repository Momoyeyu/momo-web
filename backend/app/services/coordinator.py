"""One brain, ordered durable inbox, server-owned attention and expiring execution epochs."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
import json
import threading
import time
import uuid
import os

from ..core import db, state
from ..core.instance_lock import InstanceLock
from ..core.plugin_host import PluginHost, HostError

LEASE_SECONDS = 15
STOP_SECONDS = 5
current_run: ContextVar[str] = ContextVar("coordinator_run", default="")


class CoordinationError(RuntimeError):
    pass


class Coordinator:
    def __init__(self):
        self.condition = threading.Condition(threading.RLock())
        self.started = False
        self.core_id = uuid.uuid4().hex
        self.epoch = 0
        self.mode = "daily"
        self.owner = None
        self.active = None
        self.queue = []
        self.host = None
        self.lock = None
        self.closed = threading.Event()
        self.restoring = False
        self.transition = threading.Lock()
        self.virtual_enabled = os.environ.get("MOMO_TEST_VIRTUAL") == "1"
        self.worker_thread = None

    def schema(self):
        with db.tx() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS inbox (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
                source TEXT NOT NULL, account_id TEXT NOT NULL, external_id TEXT NOT NULL,
                text TEXT NOT NULL, status TEXT NOT NULL, run_id TEXT NOT NULL,
                at TEXT NOT NULL, UNIQUE(source,account_id,external_id))""")
            c.execute("""CREATE TABLE IF NOT EXISTS outbox (
                command_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, epoch INTEGER NOT NULL,
                status TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT, at TEXT NOT NULL)""")

    def start(self):
        if self.started:
            raise CoordinationError("Coordinator is already started")
        self.core_id = uuid.uuid4().hex
        self.closed = threading.Event()
        self.mode = "daily"
        self.owner = None
        self.active = None
        self.queue = []
        self.lock = InstanceLock(state.DATA_DIR).acquire()
        try:
            self.schema()
            with db.tx() as c:
                c.execute(
                    "UPDATE inbox SET status='interrupted' WHERE status IN ('processing','queued')"
                )
                c.execute(
                    "UPDATE outbox SET status='unknown' WHERE status IN ('pending','executing')"
                )
            self.host = PluginHost(self.core_id, self.event, lambda: self.epoch)
            self.host.start()
            self.started = True
            self.worker_thread = threading.Thread(
                target=self._worker, name="momo-inbox", daemon=True
            )
            self.worker_thread.start()
        except Exception:
            if self.host:
                self.host.close()
            self.lock.close()
            self.lock = None
            raise

    def close(self):
        self.closed.set()
        with self.condition:
            self.mode = "paused"
            self.epoch += 1
            self._cancel_generation()
            self.condition.notify_all()
        if self.host:
            self.host.close()
        if self.worker_thread and self.worker_thread is not threading.current_thread():
            self.worker_thread.join(timeout=STOP_SECONDS)
        with self.condition:
            self.condition.wait_for(lambda: self.active is None, timeout=STOP_SECONDS)
        if self.lock:
            self.lock.close()
        self.started = False

    def event(self, name, data):
        # Reader thread must never synchronously call the host (it owns replies).
        if name == "receipt":
            self.record_receipt(data)
        elif name == "inbox":
            self.enqueue(
                data.get("source", "virtual"),
                data.get("accountId", "default"),
                data.get("externalMessageId")
                or data.get("messageId")
                or uuid.uuid4().hex,
                data.get("text", ""),
            )
        elif name == "host.paused":
            with self.condition:
                if self.started:
                    self.mode = "paused"
                    self.owner = None
                    self.epoch += 1
                    self._cancel_generation()
                    self.condition.notify_all()

    def enqueue(self, source, account, external_id, text):
        self.schema()
        with db.tx() as c:
            rid = uuid.uuid4().hex
            inserted = c.execute(
                "INSERT OR IGNORE INTO inbox(id,source,account_id,external_id,text,status,run_id,at) VALUES(?,?,?,?,?,?,?,?)",
                (
                    uuid.uuid4().hex,
                    source,
                    account,
                    external_id,
                    text,
                    "queued",
                    rid,
                    db.now_iso(),
                ),
            )
            row = c.execute(
                "SELECT * FROM inbox WHERE source=? AND account_id=? AND external_id=?",
                (source, account, external_id),
            ).fetchone()
        with self.condition:
            self.condition.notify_all()
        return dict(row) | {"acceptedNew": inserted.rowcount == 1}

    def inbox_status(self, inbox_id, status):
        with db.tx() as c:
            c.execute("UPDATE inbox SET status=? WHERE id=?", (status, inbox_id))

    def record_receipt(self, receipt):
        if not receipt.get("commandId"):
            return
        self.schema()
        # A late actual receipt is a historical fact, never permission for a new action.
        with db.tx() as c:
            c.execute(
                "UPDATE outbox SET status=?,receipt=? WHERE command_id=?",
                (
                    receipt.get("status", "unknown"),
                    json.dumps(receipt, ensure_ascii=False),
                    receipt["commandId"],
                ),
            )

    def _cancel_generation(self):
        with db.tx() as c:
            c.execute("UPDATE sessions SET generation=generation+1 WHERE id='live'")
        from . import onboarding

        onboarding.rebind_after_interrupt()

    def _revoke(self, reason):
        from contextlib import nullcontext

        with self.host.control if self.host else nullcontext():
            return self._revoke_locked(reason)

    def _revoke_locked(self, reason):
        with self.condition:
            self.epoch += 1
            epoch = self.epoch
            self._cancel_generation()
            self.condition.notify_all()
        if self.host:
            result = self.host.request(
                "revoke",
                {"activityEpoch": epoch, "reason": reason},
                timeout=STOP_SECONDS + 2,
            )
            if not result.get("stopped"):
                raise CoordinationError(
                    "Activity stop could not be confirmed; momo is paused"
                )
        with self.condition:
            if not self.condition.wait_for(
                lambda: self.active is None, timeout=STOP_SECONDS
            ):
                raise CoordinationError(
                    "The previous turn has not stopped; momo is paused"
                )

    def _grant(self):
        if self.host:
            self.host.request("grant", {"activityEpoch": self.epoch})

    def enter(self, client, lease=None):
        if not self.transition.acquire(blocking=False):
            raise CoordinationError(
                "An attention transition is in progress; retry shortly"
            )
        try:
            return self._enter(client, lease)
        finally:
            self.transition.release()

    def _enter(self, client, lease=None):
        with self.condition:
            if self.restoring:
                raise CoordinationError("Data maintenance is in progress")
            self._expire()
            if (
                self.owner
                and self.owner["clientId"] == client
                and self.owner["leaseId"] == lease
            ):
                pass  # Refresh rotates the capability and invalidates the old tab.
            elif self.owner:
                raise CoordinationError(
                    "Another window is meeting momo; return there or leave it first"
                )
            self.mode = "stopping"
        try:
            self._revoke("meeting")
            self._grant()
            with self.condition:
                self.mode = "meeting"
                self.owner = {
                    "clientId": client,
                    "leaseId": uuid.uuid4().hex,
                    "expiresAt": time.monotonic() + LEASE_SECONDS,
                }
                return self._lease()
        except (HostError, CoordinationError):
            with self.condition:
                self.mode = "paused"
                self.owner = None
            raise CoordinationError(
                "Could not stop the previous activity; momo is paused"
            )

    def _lease(self):
        return {
            "leaseId": self.owner["leaseId"],
            "epoch": self.epoch,
            "expiresIn": LEASE_SECONDS,
            "mode": self.mode,
        }

    def _expire(self):
        if self.owner and self.owner["expiresAt"] < time.monotonic():
            self.owner = None
            self.mode = "paused"
            self.epoch += 1
            self._cancel_generation()
            expired_epoch = self.epoch

            def stop_expired():
                try:
                    with self.transition:
                        with self.condition:
                            if (
                                self.owner is not None
                                or self.mode != "paused"
                                or self.epoch != expired_epoch
                            ):
                                return
                        self._revoke("meeting_lease_expired")
                except (HostError, CoordinationError):
                    pass

            threading.Thread(
                target=stop_expired, name="momo-expired-lease", daemon=True
            ).start()

    def heartbeat(self, client, lease):
        with self.condition:
            self.require_meeting(client, lease)
            self.owner["expiresAt"] = time.monotonic() + LEASE_SECONDS
            return self._lease()

    def require_meeting(self, client, lease):
        with self.condition:
            self._expire()
            if self.started and (
                self.mode != "meeting"
                or not self.owner
                or self.owner["clientId"] != client
                or self.owner["leaseId"] != lease
            ):
                raise CoordinationError(
                    "Meeting lease expired or belongs to another window"
                )

    def leave(self, client, lease):
        if not self.transition.acquire(blocking=False):
            raise CoordinationError("An attention transition is in progress")
        try:
            return self._leave(client, lease)
        finally:
            self.transition.release()

    def _leave(self, client, lease):
        with self.condition:
            self.require_meeting(client, lease)
            self.mode = "stopping"
        try:
            self._revoke("leave_meeting")
            self._grant()
            with self.condition:
                self.owner = None
                self.mode = "daily"
                self.condition.notify_all()
        except (HostError, CoordinationError):
            with self.condition:
                self.mode = "paused"
                self.owner = None
            raise CoordinationError("Could not stop the active turn; momo is paused")

    @contextmanager
    def run(self, run_id, source="meeting", client=None, lease=None):
        with self.condition:
            if source == "meeting":
                self.require_meeting(client, lease)
            self.queue.append(run_id)
            try:
                while self.active or self.queue[0] != run_id:
                    self.condition.wait(0.2)
                    if source == "meeting":
                        self.require_meeting(client, lease)
                    elif self.mode != "daily":
                        raise CoordinationError("Background activity is paused")
                if self.restoring:
                    raise CoordinationError("Data maintenance is in progress")
                if source == "meeting":
                    self.require_meeting(client, lease)
                if source != "meeting" and self.mode != "daily":
                    raise CoordinationError("Background activity is paused")
                self.queue.remove(run_id)
                self.active = run_id
            except BaseException:
                if run_id in self.queue:
                    self.queue.remove(run_id)
                self.condition.notify_all()
                raise
        try:
            yield
        finally:
            with self.condition:
                self.active = None
                self.condition.notify_all()

    def valid_run(self, run_id):
        with self.condition:
            self._expire()
            return not self.started or (
                not self.restoring
                and self.active == run_id
                and self.mode in {"meeting", "daily"}
            )

    def command(self, method, params, run_id=None):
        run_id = run_id or current_run.get()
        with self.condition:
            if not self.valid_run(run_id):
                raise CoordinationError("Stale execution")
            if self.mode == "meeting" and method not in {"plugins.callTool"}:
                raise CoordinationError(
                    "External activity is unavailable during a meeting"
                )
            permit = self.host.permit(run_id)
        with db.tx() as c:
            c.execute(
                "INSERT INTO outbox(command_id,run_id,epoch,status,payload,at) VALUES(?,?,?,?,?,?)",
                (
                    permit["commandId"],
                    run_id,
                    permit["activityEpoch"],
                    "pending",
                    json.dumps({"method": method}),
                    db.now_iso(),
                ),
            )
        try:
            result = self.host.request(method, {**params, "permit": permit}, timeout=35)
            receipt = result.get("receipt", result) if isinstance(result, dict) else {}
            if receipt.get("commandId"):
                self.record_receipt(receipt)
            return result
        except HostError:
            with db.tx() as c:
                c.execute(
                    "UPDATE outbox SET status='unknown' WHERE command_id=?",
                    (permit["commandId"],),
                )
            raise

    @contextmanager
    def maintenance(self):
        with self.transition:
            with self._maintenance_locked():
                yield

    @contextmanager
    def _maintenance_locked(self):
        with self.condition:
            self.restoring = True
            self.mode = "stopping"
        try:
            self._revoke("data_maintenance")
            yield
        finally:
            # Restored credentials/cursors never authorize replay of pre-restore commands.
            self.schema()
            with db.tx() as c:
                c.execute(
                    "UPDATE inbox SET status='interrupted' WHERE status IN ('processing','queued')"
                )
                c.execute(
                    "UPDATE outbox SET status='unknown' WHERE status IN ('pending','executing')"
                )
            with self.condition:
                self.restoring = False
                self.mode = "paused"
                self.owner = None
                self.condition.notify_all()

    def _worker(self):
        while not self.closed.wait(0.2):
            with self.condition:
                self._expire()
                if self.mode != "daily" or self.restoring or self.active:
                    continue
            rows = db.query(
                "SELECT * FROM inbox WHERE status='queued' AND source!='meeting' ORDER BY seq LIMIT 64"
            )
            if not rows:
                continue
            # Combine unread for one source/account instead of generating stale individual replies.
            first = rows[0]
            batch = []
            for row in rows:
                if (
                    row["source"] != first["source"]
                    or row["account_id"] != first["account_id"]
                ):
                    break
                batch.append(row)
            rid = first["run_id"]
            try:
                with self.run(rid, first["source"]):
                    with db.tx() as c:
                        for item in batch:
                            c.execute(
                                "UPDATE inbox SET status='processing' WHERE id=?",
                                (item["id"],),
                            )
                    from . import turn, checkpoint

                    text = "\n".join(r["text"] for r in batch)
                    token = current_run.set(rid)
                    external_key = json.dumps(
                        [first["account_id"], first["external_id"]],
                        separators=(",", ":"),
                    )
                    try:
                        events = list(
                            turn.run_turn(
                                text,
                                run_id=rid,
                                source=first["source"],
                                external_message_id=external_key,
                            )
                        )
                    finally:
                        current_run.reset(token)
                    reply = "".join(
                        e.get("text", "") for e in events if e["t"] == "sentence"
                    )
                    if reply and self.valid_run(rid):
                        receipt = self.command(
                            "virtual.deliver",
                            {"text": reply, "accountId": first["account_id"]},
                            rid,
                        )
                        if receipt.get("status") in {"delivered", "completed"}:
                            gen = next(
                                e["generation"] for e in events if e["t"] == "sentence"
                            )
                            checkpoint.acknowledge(rid, reply, gen)
                    with db.tx() as c:
                        for item in batch:
                            c.execute(
                                "UPDATE inbox SET status=? WHERE id=?",
                                ("completed" if reply else "failed", item["id"]),
                            )
            except Exception:
                with db.tx() as c:
                    for item in batch:
                        c.execute(
                            "UPDATE inbox SET status='interrupted' WHERE id=?",
                            (item["id"],),
                        )


runtime = Coordinator()
