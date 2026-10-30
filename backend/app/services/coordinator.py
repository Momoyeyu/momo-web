"""One activated brain, durable ingress, and server-owned presentation attention."""
from __future__ import annotations

from contextlib import contextmanager, nullcontext
from contextvars import ContextVar
import hashlib
import json
import os
import threading
import time
import uuid

from ..core import db, state
from ..core.instance_lock import InstanceLock
from ..core.plugin_host import PluginHost, HostError

LEASE_SECONDS = 15
STOP_SECONDS = 5
QQ_RESTORE_SECONDS = 35
QQ_RESTORE_POLL_SECONDS = .2
RETIRED_CHANNEL_PLUGINS = {"momo-wechat": "wechat"}
current_run: ContextVar[str] = ContextVar("coordinator_run", default="")


class CoordinationError(RuntimeError):
    pass


class Coordinator:
    def __init__(self):
        self.condition = threading.Condition(threading.RLock())
        self.transition = threading.Lock()
        # A stream may be resumed by a different ASGI worker thread; Lock,
        # unlike RLock, can be released after that synchronous generator resumes.
        self.reasoning_lock = threading.Lock()
        self.started = False
        self.core_id = uuid.uuid4().hex
        self.epoch = 0
        self.mode = "dormant"
        self.owner = None
        self.active = None
        self.activity = None
        self.last_phone_activity = None
        self.presentation = None
        self.paused_presentations = {}
        self.focus = False
        self.phone_paused = False
        self.interrupt_hold = False
        self.queue = []
        self.host = None
        self.lock = None
        self.closed = threading.Event()
        self.restoring = False
        self.rebinding = False
        self.virtual_enabled = os.environ.get("MOMO_TEST_VIRTUAL") == "1"
        self.worker_thread = None
        self.controls = {}
        self.mcp_configs = []
        self.mcp_revision = -1
        self.host_config_revision = 0
        self.configuration_lock = threading.Lock()
        self.qq_restore_thread = None
        self.qq_restore_pending = None
        self.qq_restore_owner = None
        self.qq_recovery_thread = None
        self.qq_recovery_owner = None

    def schema(self):
        with db.tx() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS inbox (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
                source TEXT NOT NULL, account_id TEXT NOT NULL, external_id TEXT NOT NULL,
                text TEXT NOT NULL, status TEXT NOT NULL, run_id TEXT NOT NULL,
                at TEXT NOT NULL, UNIQUE(source,account_id,external_id))""")
            additions = {"peer_id": "TEXT NOT NULL DEFAULT ''", "sender_id": "TEXT NOT NULL DEFAULT ''", "self_id": "TEXT NOT NULL DEFAULT ''", "audience": "TEXT NOT NULL DEFAULT 'owner'", "policy_revision": "TEXT NOT NULL DEFAULT ''", "raw_external_id": "TEXT NOT NULL DEFAULT ''", "retry_of": "TEXT NOT NULL DEFAULT ''"}
            columns = {r["name"] for r in c.execute("PRAGMA table_info(inbox)")}
            for name, declaration in additions.items():
                if name not in columns:
                    c.execute(f"ALTER TABLE inbox ADD COLUMN {name} {declaration}")
            c.execute("""CREATE TABLE IF NOT EXISTS outbox (
                command_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, epoch INTEGER NOT NULL,
                status TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT, at TEXT NOT NULL)""")
            c.execute("CREATE TABLE IF NOT EXISTS command_receipts(id INTEGER PRIMARY KEY AUTOINCREMENT,command_id TEXT NOT NULL,receipt TEXT NOT NULL,at TEXT NOT NULL)")

    def start(self):
        if self.started:
            raise CoordinationError("Coordinator is already started")
        self.core_id = uuid.uuid4().hex
        self.closed = threading.Event()
        self.mode, self.owner, self.active, self.activity = "dormant", None, None, None
        self.presentation, self.queue = None, []
        self.focus = self.phone_paused = self.interrupt_hold = False
        self.lock = InstanceLock(state.DATA_DIR).acquire()
        try:
            self.schema()
            try:
                policy = json.loads(db.meta_get("attention_policy", "{}"))
            except (ValueError, TypeError):
                policy = {}
            # Focus belongs to the current human meeting. A process restart
            # begins dormant, while the independent phone pause survives it.
            self.focus = False
            self.phone_paused = policy.get("phonePaused") is True
            if policy.get("focus") is True:
                self._persist_attention_policy()
            with db.tx() as c:
                # Unclaimed accepted work survives a process restart. In-flight
                # inference does not replay its potentially dispatched side effect.
                c.execute("UPDATE inbox SET status='interrupted' WHERE status='processing'")
                c.execute("UPDATE inbox SET status='held_inactive' WHERE status IN ('queued','held_focus','held_interrupt','held_paused') AND source!='meeting'")
                c.execute("UPDATE inbox SET status='interrupted' WHERE source='meeting' AND status='queued'")
                c.execute("UPDATE outbox SET status='unknown' WHERE status IN ('pending','executing')")
            self.host = PluginHost(self.core_id, self.event, lambda: self.epoch)
            self.host.start()
            if self._unresolved_commands():
                self.mode = "paused"
            self.started = True
            self.worker_thread = threading.Thread(target=self._worker, name="momo-inbox", daemon=True)
            self.worker_thread.start()
            self._schedule_qq_recovery()
        except Exception:
            if self.host:
                self.host.close()
            self.lock.close()
            self.lock = None
            raise

    def close(self):
        self.closed.set()
        with self.condition:
            self.qq_restore_pending = None
            self.qq_restore_owner = None
            self.qq_recovery_owner = None
            self.mode = "paused"
            self.owner = None
            self.presentation = None
            self.epoch += 1
            self._cancel_generation()
            self.condition.notify_all()
        if self.host:
            self.host.close()
        restore_thread = self.qq_restore_thread
        if restore_thread and restore_thread is not threading.current_thread():
            restore_thread.join(timeout=STOP_SECONDS)
        recovery_thread = self.qq_recovery_thread
        if recovery_thread and recovery_thread is not threading.current_thread():
            recovery_thread.join(timeout=STOP_SECONDS)
        if self.worker_thread and self.worker_thread is not threading.current_thread():
            self.worker_thread.join(timeout=STOP_SECONDS)
        with self.condition:
            self.condition.wait_for(lambda: self.active is None, timeout=STOP_SECONDS)
        if self.lock:
            self.lock.close()
        self.started = False

    def _persist_attention_policy(self):
        with db.tx() as c:
            c.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('attention_policy',?)", (json.dumps({"focus": self.focus, "phonePaused": self.phone_paused}),))

    def configure_host_plugins(self, configs, *, tolerate_errors=True, revision=None, guard=None, timeout=35):
        from .social import social
        with self.configuration_lock:
            if guard and not guard():
                return {"stale": True}
            if revision is not None and revision < self.mcp_revision:
                return {"stale": True}
            if configs is not None:
                self.mcp_configs = list(configs)
            if revision is not None:
                self.mcp_revision = revision
            # MCP and social configuration share one monotonic host revision.
            # Capturing under a lock prevents a delayed social refresh or stale
            # tool reconciliation from reviving withdrawn connections.
            plugins = self.mcp_configs + social.host_configs()
            self.host_config_revision += 1
            params = {"plugins": plugins, "tolerateErrors": tolerate_errors, "configurationRevision": self.host_config_revision}
            host = self.host
        if host and (not guard or guard()):
            return host.request("plugins.configure", params, timeout=timeout)
        return {}

    def refresh_social_plugins(self):
        return self.configure_host_plugins(None)

    def _schedule_qq_restore(self):
        """Coalesce explicit Boot intents into one bounded, owned restore task."""
        from .social import social
        try:
            binding = social.native_restore_binding()
        except Exception:
            return
        with self.condition:
            host_instance = getattr(self.host, "host_instance", None)
            if (not self.started or self.closed.is_set() or not self.host
                or not isinstance(host_instance, str) or not host_instance):
                return
            self.qq_restore_pending = ({"binding": binding, "host": self.host,
                "hostInstance": host_instance, "coreId": self.core_id,
                "closed": self.closed, "deadline": time.monotonic() + QQ_RESTORE_SECONDS}
                if binding else None)
            if not self.qq_restore_pending:
                return
            if (self.qq_restore_thread and self.qq_restore_thread.is_alive()
                and self._qq_restore_owner_current(self.qq_restore_owner)):
                return
            owner = {"closed": self.closed, "coreId": self.core_id,
                     "host": self.host, "hostInstance": host_instance}
            self.qq_restore_owner = owner
            self.qq_restore_thread = threading.Thread(target=self._restore_qq_worker,
                                                     args=(owner,), name="momo-qq-restore", daemon=True)
            self.qq_restore_thread.start()

    def _qq_restore_owner_current(self, owner):
        return bool(owner and self.qq_restore_owner is owner
            and self.closed is owner["closed"] and not owner["closed"].is_set()
            and self.core_id == owner["coreId"] and self.host is owner["host"]
            and getattr(self.host, "host_instance", None) == owner["hostInstance"])

    def _restore_qq_worker(self, owner):
        while True:
            with self.condition:
                # An old RPC may unwind after this Coordinator/host is reused.
                # It owns neither the new lifetime's intent nor its thread slot.
                if not self._qq_restore_owner_current(owner):
                    return
                pending, self.qq_restore_pending = self.qq_restore_pending, None
                if pending is None:
                    if self.qq_restore_thread is threading.current_thread():
                        self.qq_restore_thread = None
                        self.qq_restore_owner = None
                    return
            try:
                self._restore_qq_account(pending)
            except Exception:
                # Authentication failures are explained in plugin settings;
                # they cannot block chat, grant authority or restart a loop.
                pass

    def _restore_qq_account(self, pending):
        from .social import social, _public_qq_runtime_status
        host, binding, closed = pending["host"], pending["binding"], pending["closed"]

        def current():
            with self.condition:
                if (not self.started or closed.is_set() or self.closed is not closed
                    or self.host is not host or self.core_id != pending["coreId"]
                    or host.host_instance != pending["hostInstance"]
                    or self.restoring or time.monotonic() >= pending["deadline"]
                    or self._unresolved_commands()):
                    return False
            return social.native_restore_binding() == binding

        def request(method, params):
            remaining = pending["deadline"] - time.monotonic()
            if remaining <= 0 or not current():
                raise CoordinationError("QQ restoration was withdrawn")
            raw = host.request(method, params, timeout=min(3, remaining))
            if not current():
                raise CoordinationError("QQ restoration was withdrawn")
            status = _public_qq_runtime_status(raw)
            revision = raw.get("loginRevision")
            if type(revision) is not int or revision < 0:
                raise CoordinationError("QQ restoration status is unavailable")
            return {**status, "loginRevision": revision}

        status = request("qq.runtime.status", {"restoreDetail": True})
        if not status["connected"]:
            # Do not replace a login/QR chosen by the account owner.
            if status["running"] or not status["executorQuiescent"]:
                return
            initial_revision = status["loginRevision"]
            try:
                status = request("qq.runtime.restore", {"ownerAction": True,
                    "expectedSelfId": binding["expectedSelfId"],
                    "expectedAttemptId": status["attemptId"],
                    "expectedLoginRevision": initial_revision})
            except HostError as error:
                if str(error) != "Plugin host timed out":
                    return
                # A bounded control timeout does not replay the request. The
                # private revision identifies only the one reserved attempt.
                status = request("qq.runtime.status", {"restoreDetail": True})
            if status["loginRevision"] != initial_revision + 1:
                return
        attempt, revision = status["attemptId"], status["loginRevision"]
        if not attempt:
            return
        while current() and time.monotonic() < pending["deadline"]:
            if status["attemptId"] != attempt or status["loginRevision"] != revision:
                return
            if status["connected"]:
                if status["actualSelfId"] != binding["expectedSelfId"]:
                    return
                # Recheck the private attempt immediately before rebuilding
                # business bindings. Existing policy is never enabled/rewritten.
                fresh = request("qq.runtime.status", {"restoreDetail": True})
                if (not fresh["connected"] or fresh["actualSelfId"] != binding["expectedSelfId"]
                    or fresh["attemptId"] != attempt or fresh["loginRevision"] != revision):
                    return
                self.configure_host_plugins(None, guard=current,
                    timeout=max(.01, min(3, pending["deadline"] - time.monotonic())))
                return
            if status["status"] not in {"preparing", "connecting", "verifying"}:
                return
            if closed.wait(min(QQ_RESTORE_POLL_SECONDS, max(0, pending["deadline"] - time.monotonic()))):
                return
            status = request("qq.runtime.status", {"restoreDetail": True})

    def configure_extensions(self, extensions):
        from ..core.mcp import hub
        hub.bind(self)
        return hub.configure(extensions)

    def event(self, name, data):
        # Never await the host on its reader thread (it owns RPC replies).
        if name == "receipt":
            self.record_receipt(data)
        elif name == "inbox":
            if data.get("source") in {"qq"}:
                from .social import social
                normalized = social.authorize_event(data)
                if normalized:
                    self.enqueue(normalized["source"], normalized["accountId"], normalized["externalMessageId"], normalized["text"], peer_id=normalized["peerId"], sender_id=normalized["senderId"], self_id=normalized["selfId"], audience=normalized["audience"], policy_revision=str(normalized["policyRevision"]))
                if data.get("inboxId") and self.host:
                    def ack():
                        try:
                            self.host.request("channels.ack", {key: data[key] for key in ("pluginId", "accountId", "inboxId")})
                        except (HostError, KeyError):
                            pass
                    threading.Thread(target=ack, name="momo-ingress-ack", daemon=True).start()
            elif self.virtual_enabled and data.get("source") == "virtual":
                self.enqueue("virtual", data.get("accountId", "default"), data.get("externalMessageId") or data.get("messageId") or uuid.uuid4().hex, data.get("text", ""))
        elif name == "host.paused":
            with self.condition:
                if self.started:
                    self.mode = "paused"
                    self.owner = None
                    self.presentation = None
                    self.epoch += 1
                    self._cancel_generation()
                    self.condition.notify_all()

    def _pending_status(self, source):
        if source == "meeting":
            return "queued"
        if self.mode != "meeting":
            return "held_inactive"
        from . import intro
        if self.focus or intro.restricted():
            return "held_focus"
        if self.phone_paused:
            return "held_paused"
        if self.interrupt_hold:
            return "held_interrupt"
        return "queued"

    def enqueue(self, source, account, external_id, text, *, peer_id="", sender_id="", self_id="", audience="owner", policy_revision=""):
        if source not in {"meeting", "qq", "virtual"}:
            raise CoordinationError("Unsupported message source")
        if len(str(text).encode('utf-8')) > 262144:
            raise CoordinationError("Message exceeds the input limit")
        self.schema()
        # Provider ids are local to an account AND peer, never globally unique.
        canonical = json.dumps([self_id, peer_id, external_id], ensure_ascii=False, separators=(",", ":")) if peer_id else str(external_id)
        with self.condition:
            pending_status = self._pending_status(source)
            with db.tx() as c:
                duplicate = c.execute("SELECT id FROM inbox WHERE source=? AND account_id=? AND external_id=?", (source, account, canonical)).fetchone()
                pending = c.execute("SELECT COUNT(*), COALESCE(SUM(length(CAST(text AS BLOB))),0) FROM inbox WHERE status IN ('queued','processing','held_inactive','held_focus','held_paused','held_interrupt')").fetchone()
                if not duplicate and (pending[0] >= 128 or pending[1] + len(str(text).encode('utf-8')) > 2097152):
                    raise CoordinationError("Message inbox is full; please retry later")
                inserted = c.execute("INSERT OR IGNORE INTO inbox(id,source,account_id,external_id,text,status,run_id,at,peer_id,sender_id,self_id,audience,policy_revision,raw_external_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (uuid.uuid4().hex, source, account, canonical, text, pending_status, uuid.uuid4().hex, db.now_iso(), peer_id, sender_id, self_id, audience, str(policy_revision), str(external_id)))
                row = c.execute("SELECT * FROM inbox WHERE source=? AND account_id=? AND external_id=?", (source, account, canonical)).fetchone()
            self.condition.notify_all()
        return dict(row) | {"acceptedNew": inserted.rowcount == 1}

    def inbox_status(self, inbox_id, status):
        with db.tx() as c:
            c.execute("UPDATE inbox SET status=? WHERE id=?", (status, inbox_id))

    def _release_held(self):
        self.schema()
        with db.tx() as c:
            c.execute("UPDATE inbox SET status=? WHERE status IN ('queued','held_inactive','held_focus','held_paused','held_interrupt') AND source IN ('qq','virtual')", (self._pending_status("qq"),))

    def record_receipt(self, receipt):
        if not receipt.get("commandId") or receipt.get("status") not in {"unknown", "started", "stopped", "completed", "delivered", "failed", "closed_unknown"}:
            return
        self.schema()
        with db.tx() as c:
            row = c.execute("SELECT * FROM outbox WHERE command_id=?", (receipt["commandId"],)).fetchone()
            if row is None:
                # A restored backup may predate a real dispatch. The private,
                # authenticated host pipe may still report its original fact;
                # recording it never manufactures a new execution permit.
                c.execute("INSERT INTO outbox VALUES(?,?,?,?,?,?,?)", (receipt["commandId"], str(receipt.get("runId") or "unattributed"), int(receipt.get("activityEpoch") or 0), "unknown", '{"origin":"recovered-receipt"}', None, db.now_iso()))
                row = c.execute("SELECT * FROM outbox WHERE command_id=?", (receipt["commandId"],)).fetchone()
            if receipt.get("runId") and receipt["runId"] != row["run_id"]:
                return
            payload = json.loads(row["payload"])
            if any(receipt.get(k) is not None and payload.get(k) is not None and str(receipt[k]) != str(payload[k]) for k in ("accountId", "peerId", "pluginId")):
                return
            encoded = json.dumps(receipt, ensure_ascii=False)
            c.execute("INSERT INTO command_receipts(command_id,receipt,at) VALUES(?,?,?)", (receipt["commandId"], encoded, db.now_iso()))
            old = row["status"]
            # Late started/unknown receipts never downgrade a terminal fact.
            if old not in {"completed", "delivered", "failed", "closed_unknown"} or receipt["status"] in {"completed", "delivered"}:
                c.execute("UPDATE outbox SET status=?,receipt=? WHERE command_id=?", (receipt["status"], encoded, receipt["commandId"]))
        if payload.get("method") == "channels.send" and receipt["status"] in {"completed", "delivered"}:
            from . import checkpoint
            checkpoint.acknowledge_external(row["run_id"], checkpoint.generated_reply(row["run_id"]), receipt["commandId"])
        params = payload.get("params", payload)
        if payload.get("method") == "channels.action" and params.get("proactive") is True and receipt["status"] in {"completed","unknown"}:
            from .social import social
            with social.lock:
                data=social._read();account=data.get("qq")
                if account and account.get("accountId")==params.get("accountId") and account.get("expectedSelfId")==params.get("selfId"):
                    # Provider/unknown receipt happens after the possible SDK
                    # dispatch. Retain a conservative interval across restarts.
                    account["lastProactiveAttemptAt"]=max(float(account.get("lastProactiveAttemptAt",0)),time.time())
                    data["qq"]=account;social._write(data)
        if (old in {"pending", "executing", "unknown"} and (payload.get("method") == "channels.send" or payload.get("method") == "channels.action" and params.get("action") in {"private.send","group.send","media.send","friends.respond","groups.manage"})
            and params.get("pluginId") == "momo-qq" and receipt["status"] == "closed_unknown"
            and receipt.get("automatic") is True and receipt.get("executorQuiescent") is True
            and receipt.get("deliveryStatus") == "unknown"):
            # Shutdown may have withdrawn the recovery worker already. Persist
            # its owned host's proof without silently restoring QQ next Boot.
            self._quarantine_qq_command(params)
        if receipt["status"] == "unknown":
            self._schedule_qq_recovery()

    @staticmethod
    def _quarantine_qq_command(params):
        from .social import social
        with social.lock:
            data = social._read()
            account = data.get("qq")
            if account and account.get("accountId") == params.get("accountId"):
                if account.get("enabled") or not account.get("quarantined"):
                    account.update(enabled=False, quarantined=True,
                        policyRevision=int(account["policyRevision"]) + 1)
                    social._write(data)

    def _qq_unknown_commands(self):
        rows = []
        for row in self._unresolved_commands():
            payload = json.loads(row["payload"])
            params = payload.get("params", payload)
            if (payload.get("method") == "channels.send" or payload.get("method") == "channels.action" and params.get("action") in {"private.send","group.send","media.send","friends.respond","groups.manage"}) and params.get("pluginId") == "momo-qq" and params.get("accountId"):
                rows.append((row, params))
        return rows

    def _qq_recovery_current(self, owner):
        return bool(owner and self.started and self.qq_recovery_owner is owner
            and self.closed is owner["closed"] and not self.closed.is_set()
            and self.host is owner["host"] and self.core_id == owner["coreId"]
            and getattr(self.host, "host_instance", None) == owner["hostInstance"]
            and not self.restoring)

    def _schedule_qq_recovery(self):
        # A receipt callback runs on the sole host reader: stopping the native
        # executor and awaiting its reply must happen on a separate worker.
        if not self.started or not self._qq_unknown_commands():
            return
        with self.condition:
            host_instance = getattr(self.host, "host_instance", None)
            if self.closed.is_set() or self.restoring or not host_instance:
                return
            if self.qq_recovery_thread and self.qq_recovery_thread.is_alive() and self._qq_recovery_current(self.qq_recovery_owner):
                return
            owner = {"host": self.host, "hostInstance": host_instance,
                     "closed": self.closed, "coreId": self.core_id}
            self.qq_recovery_owner = owner
            self.qq_recovery_thread = threading.Thread(target=self._recover_unknown_qq,
                args=(owner,), name="momo-qq-recovery", daemon=True)
            self.qq_recovery_thread.start()

    def _recover_unknown_qq(self, owner):
        from .social import SocialError
        try:
            with self.transition:
                with self.condition:
                    settled = self.condition.wait_for(lambda: not self._qq_recovery_current(owner) or self.active is None,
                                                      timeout=STOP_SECONDS)
                    if not settled or not self._qq_recovery_current(owner):
                        return
                for row, params in self._qq_unknown_commands():
                    with self.condition:
                        if not self._qq_recovery_current(owner):
                            return
                        # Withdraw persistent business authorization first. Do
                        # not refresh every MCP plugin just to stop one phone.
                        self._quarantine_qq_command(params)
                    result = owner["host"].request("qq.settleUnknown", {
                        "commandId": row["command_id"], "accountId": params["accountId"]}, timeout=STOP_SECONDS + 2)
                    with self.condition:
                        if not self._qq_recovery_current(owner):
                            return
                        receipt = result.get("receipt", {})
                        if (result.get("settled") is not True or result.get("executorQuiescent") is not True
                            or receipt.get("commandId") != row["command_id"] or receipt.get("runId") != row["run_id"]
                            or receipt.get("activityEpoch") != row["epoch"]
                            or any(receipt.get(key) != params.get(key) for key in ("pluginId", "accountId", "peerId"))):
                            continue
                        if receipt.get("status") == "closed_unknown":
                            if receipt.get("deliveryStatus") != "unknown" or receipt.get("executorQuiescent") is not True:
                                continue
                        elif receipt.get("status") not in {"completed", "delivered", "failed"}:
                            continue
                        self.record_receipt(receipt)
                with self.condition:
                    if not self._qq_recovery_current(owner) or self._unresolved_commands():
                        return
                # Recovery only returns to the title's dormant brain. A genuine
                # provider fact or a reaped executor must never perform Boot.
                self._recover_attention_locked(resume_owner=False)
        except (HostError, CoordinationError, SocialError, OSError, ValueError, TypeError, KeyError):
            # No proof means no reconciliation. In particular, a fresh host's
            # empty runtime cannot attest that a prior host's executor stopped.
            pass

    def _unresolved_commands(self):
        rows = db.query("SELECT * FROM outbox WHERE status='unknown'")
        return [r for r in rows if json.loads(r["payload"]).get("method") in {"plugins.callTool", "channels.send"} or (json.loads(r["payload"]).get("method") == "channels.action" and json.loads(r["payload"]).get("action") in {"private.send","group.send","media.send","friends.respond","groups.manage"}) or json.loads(r["receipt"] or "{}").get("requiresReconciliation")]

    @staticmethod
    def _retired_channel_command(row):
        try:
            payload = json.loads(row["payload"])
            params = payload.get("params", payload)
            source = RETIRED_CHANNEL_PLUGINS.get(params.get("pluginId"))
            if payload.get("method") == "channels.send" and source:
                return source, params
        except (ValueError, TypeError, AttributeError):
            pass
        return None

    def retired_operations(self):
        """Unresolved retired sends only; no account storage or credentials."""
        self.schema()
        records = []
        for row in db.query("SELECT * FROM outbox WHERE status='unknown' ORDER BY at DESC"):
            retired = self._retired_channel_command(row)
            if retired:
                source, params = retired
                records.append({"commandId": row["command_id"], "source": source,
                    "accountId": params.get("accountId"), "peerId": params.get("peerId"),
                    "status": "unknown", "createdAt": row["at"], "deliveryStatus": "unknown"})
                if len(records) == 100:
                    break
        return {"records": records}

    def end_retired_wait(self, command_id, *, executor_stopped):
        """A local human ends waiting, without inventing a delivery outcome."""
        if executor_stopped is not True:
            raise CoordinationError("Confirm the retired executor was stopped first")
        with self.transition:
            self.schema()
            rows = db.query("SELECT * FROM outbox WHERE command_id=?", (command_id,))
            row = rows[0] if rows else None
            if row is None or not self._retired_channel_command(row):
                raise ValueError("No matching retired unknown operation")
            prior = json.loads(row["receipt"] or "{}")
            if row["status"] == "closed_unknown" and prior.get("retired") is True and prior.get("executorStoppedByUser") is True:
                return self.snapshot()
            if row["status"] != "unknown":
                raise ValueError("No matching retired unknown operation")
            with self.condition:
                if self.active:
                    raise CoordinationError("Settle the active operation before reconciliation")
            # The retired adapter cannot be loaded by this host. The explicit
            # human attestation concerns any old standalone executor; it is
            # not a claim of provider acceptance or machine-verified delivery.
            self.record_receipt({"commandId": command_id, "runId": row["run_id"],
                "activityEpoch": row["epoch"], "status": "closed_unknown",
                "deliveryStatus": "unknown", "reconciled": True,
                "retired": True, "executorStoppedByUser": True})
            with self.condition:
                self.condition.notify_all()
            if self._unresolved_commands():
                return self.snapshot()
            return self._recover_attention_locked(resume_owner=False)

    def reconcile_command(self, command_id, outcome):
        if outcome not in {"completed", "failed", "closed_unknown"}:
            raise CoordinationError("An observed outcome or explicit close-unknown is required")
        with self.transition:
            with self.condition:
                if self.active:
                    raise CoordinationError("Settle the active operation before reconciliation")
            row = next((r for r in self._unresolved_commands() if r["command_id"] == command_id), None)
            if row is None:
                raise CoordinationError("Unknown command does not require reconciliation")
            result = self.host.request("commands.reconcile", {"commandId": command_id, "status": outcome}) if self.host else {}
            receipt = result.get("receipt") or {"commandId": command_id, "runId": row["run_id"], "activityEpoch": row["epoch"], "status": outcome, "reconciled": True}
            self.record_receipt(receipt)
            payload = json.loads(row["payload"])
            if outcome == "closed_unknown" and payload.get("accountId"):
                from .social import social
                provider = str(payload.get("pluginId", "")).removeprefix("momo-")
                if provider in {"qq"}:
                    social.quarantine(provider)
            with self.condition:
                self.condition.notify_all()

    def _cancel_generation(self):
        with db.tx() as c:
            c.execute("UPDATE sessions SET generation=generation+1 WHERE id='live'")
        from . import onboarding
        onboarding.rebind_after_interrupt()

    def _revoke(self, reason):
        with self.host.control if self.host else nullcontext():
            return self._revoke_locked(reason)

    def _revoke_locked(self, reason):
        with self.condition:
            self.epoch += 1
            epoch = self.epoch
            self._cancel_generation()
            self.presentation = None
            self.paused_presentations.clear()
            self.condition.notify_all()
        if self.host:
            result = self.host.request("revoke", {"activityEpoch": epoch, "reason": reason}, timeout=STOP_SECONDS + 2)
            if not result.get("stopped"):
                raise CoordinationError("Activity stop could not be confirmed; momo is paused")
        with self.condition:
            if not self.condition.wait_for(lambda: self.active is None, timeout=STOP_SECONDS):
                raise CoordinationError("The previous turn has not stopped; momo is paused")

    def _grant(self):
        if self._unresolved_commands():
            raise CoordinationError("Reconcile unknown external command outcomes before continuing")
        if self.host:
            self.host.request("grant", {"activityEpoch": self.epoch})

    def enter(self, client, lease=None, *, restore=False):
        from . import intro
        if not intro.can_boot():
            raise CoordinationError("Complete model configuration before Boot")
        if not self.transition.acquire(blocking=False):
            raise CoordinationError("An attention transition is in progress; retry shortly")
        try:
            with self.condition:
                if self.restoring:
                    raise CoordinationError("Data maintenance is in progress")
                self._expire()
                matching = bool(self.owner and self.owner["clientId"] == client and self.owner["leaseId"] == lease)
                if restore:
                    if not matching or self.mode != "meeting":
                        raise CoordinationError("Activation expired; use Boot from the title")
                if self.owner and not matching:
                    raise CoordinationError("Another window is using momo; return there or leave it first")
                if self._unresolved_commands():
                    raise CoordinationError("Reconcile unknown external command outcomes before continuing")
                self.rebinding = matching
                self.interrupt_hold = matching
                self.mode = "stopping"
            try:
                self._revoke("meeting")
                self._grant()
                with self.condition, db._lock, state.configuration_lock:
                    if not intro.can_boot():
                        raise CoordinationError("Model configuration changed during Boot")
                    self.mode = "meeting"
                    self.rebinding = False
                    self.interrupt_hold = False
                    self.owner = {"clientId": client, "leaseId": uuid.uuid4().hex, "expiresAt": time.monotonic() + LEASE_SECONDS}
                    intro.did_boot()
                    self._release_held()
                    self.condition.notify_all()
                    if not restore:
                        self._schedule_qq_restore()
                    return self._lease()
            except (HostError, CoordinationError) as error:
                with self.condition:
                    self.mode, self.owner = "paused", None
                raise CoordinationError("Could not settle the previous activity; momo is paused") from error
        finally:
            self.transition.release()

    def _note_phone_activity(self):
        """Retain a presentation hint for short work between UI polls, per Boot."""
        if self.owner and self.activity and (self.activity['source']=='qq' or self.activity.get('toolSource')=='qq'):
            self.last_phone_activity = {'lease':self.owner['leaseId'], 'activity':{**self.activity,'eventId':uuid.uuid4().hex}}

    def phone_activity(self):
        with self.condition:
            record=self.last_phone_activity
            if not record or not self.owner or record['lease']!=self.owner['leaseId']:
                return None
            return dict(record['activity'])

    def snapshot(self):
        with self.condition:
            self._expire()
            activity = self.activity or ({"runId": self.presentation["runId"], "source": "meeting", "accountId": None, "phase": "presenting"} if self.presentation else None)
            return {"mode": self.mode, "epoch": self.epoch, "busy": bool(activity), "activation": "active" if self.mode == "meeting" else "fault" if self.mode in {"paused", "stopping"} else "dormant", "focus": self.focus, "phonePaused": self.phone_paused, "activity": activity, "presentation": ({k: self.presentation[k] for k in ("runId", "token", "generation", "text") if k in self.presentation} if self.presentation else None)}

    def _lease(self):
        return {**self.snapshot(), "leaseId": self.owner["leaseId"], "expiresIn": LEASE_SECONDS}

    def _expire(self):
        if self.owner and self.owner["expiresAt"] < time.monotonic():
            self.owner = None
            self.mode = "paused"
            self.focus = False
            self._persist_attention_policy()
            self.presentation = None
            self.epoch += 1
            self._cancel_generation()
            expired_epoch = self.epoch
            def stop_expired():
                try:
                    with self.transition:
                        with self.condition:
                            if self.owner or self.mode != "paused" or self.epoch != expired_epoch:
                                return
                        self._revoke("activation_lease_expired")
                        with self.condition:
                            if not self._unresolved_commands():
                                self.mode = "dormant"
                except (HostError, CoordinationError):
                    pass
            threading.Thread(target=stop_expired, name="momo-expired-lease", daemon=True).start()

    def heartbeat(self, client, lease):
        with self.condition:
            self._expire()
            if not self.owner or self.owner["clientId"] != client or self.owner["leaseId"] != lease or self.restoring:
                raise CoordinationError("Activation lease expired or belongs to another window")
            # Fault ownership permits viewing/reconciling the original operation,
            # never inference or execution. Only explicit human recovery grants.
            self.owner["expiresAt"] = time.monotonic() + LEASE_SECONDS
            return self._lease()

    def recover_attention(self, *, resume_owner=True):
        """Called only by the authenticated human reconciliation endpoint."""
        with self.transition:
            return self._recover_attention_locked(resume_owner=resume_owner)

    def _recover_attention_locked(self, *, resume_owner):
        self.schema()
        if self._unresolved_commands():
            raise CoordinationError("Other unknown commands still need reconciliation")
        with self.condition:
            self.mode = "stopping"
        try:
            self._revoke("human_recovery")
            with self.condition:
                owner_valid = bool(resume_owner and self.owner and self.owner["expiresAt"] > time.monotonic())
            if owner_valid:
                self._grant()
            with self.condition:
                if owner_valid and self.owner and self.owner["expiresAt"] > time.monotonic():
                    self.mode = "meeting"
                else:
                    self.owner, self.mode = None, "dormant"
                    self.focus = False
                    self._persist_attention_policy()
                self.presentation = None
                self.interrupt_hold = False
                self._release_held()
                self.condition.notify_all()
                return self.snapshot()
        except (HostError, CoordinationError) as error:
            with self.condition:
                self.mode = "paused"
            raise CoordinationError("Executor stop or permission could not be confirmed") from error

    def require_meeting(self, client, lease):
        with self.condition:
            self._expire()
            if self.started and (self.mode != "meeting" or not self.owner or self.owner["clientId"] != client or self.owner["leaseId"] != lease):
                raise CoordinationError("Activation lease expired or belongs to another window")

    def leave(self, client, lease):
        if not self.transition.acquire(blocking=False):
            raise CoordinationError("An attention transition is in progress")
        try:
            with self.condition:
                self._expire()
                if not self.owner or self.owner["clientId"] != client or self.owner["leaseId"] != lease or self.restoring:
                    raise CoordinationError("Activation lease expired or belongs to another window")
                self.mode = "stopping"
            try:
                self._revoke("leave_chat")
                with self.condition:
                    self.owner = None
                    self.mode = "paused" if self._unresolved_commands() else "dormant"
                    self.focus = False
                    self._persist_attention_policy()
                    self.interrupt_hold = False
                    self.paused_presentations.clear()
                    self._release_held()
                    self.condition.notify_all()
            except (HostError, CoordinationError) as error:
                with self.condition:
                    self.mode, self.owner = "paused", None
                raise CoordinationError("Could not stop the active turn; momo is paused") from error
        finally:
            self.transition.release()

    def _external_running(self):
        self.schema()
        return bool(db.query("SELECT 1 FROM outbox WHERE status='started' LIMIT 1"))

    def prepare_local(self, client, lease):
        """The local player's words interrupt phone work, without another LLM."""
        self.require_meeting(client, lease)
        with self.condition:
            self.interrupt_hold = True
            phone_active = bool(self.activity and (self.activity["source"] != "meeting" or self.activity.get("toolSource") == "qq")) or self._external_running()
            self._release_held()
        if phone_active:
            with self.transition:
                try:
                    self._revoke("local_interruption")
                    self._grant()
                except (HostError, CoordinationError) as error:
                    with self.condition:
                        self.mode = "paused"
                    raise CoordinationError("Phone operation could not settle; check pending operations") from error

    def control(self, client, lease, request_id, action, run_id=None, *, from_run=False):
        self.require_meeting(client, lease)
        if action not in {"focus_on", "focus_off", "stop", "resume_phone", "use_phone"}:
            raise CoordinationError("Unsupported attention action")
        with self.condition:
            if request_id in self.controls:
                if self.controls[request_id] != action:
                    raise CoordinationError("Control request identity was reused")
                return self.snapshot()
            if from_run and (self.active != run_id or not self.activity or self.activity["source"] != "meeting"):
                raise CoordinationError("Only the current local player input can control attention")
            if run_id and not from_run and self.active and self.active != run_id:
                raise CoordinationError("The activity changed; inspect it before stopping")
            if action == "focus_on": self.focus = True
            elif action == "focus_off": self.focus = False
            elif action == "stop": self.phone_paused = True
            else: self.phone_paused = False
            self._persist_attention_policy()
            self.controls[request_id] = action
            if len(self.controls) > 256:
                self.controls.pop(next(iter(self.controls)))
            stop_active = bool(not from_run and action in {"stop", "focus_on"} and ((self.activity and (self.activity["source"] != "meeting" or self.activity.get("toolSource") == "qq")) or self._external_running()))
            self._release_held()
            self.condition.notify_all()
        if stop_active:
            with self.transition:
                try:
                    self._revoke("user_" + action)
                    self._grant()
                except (HostError, CoordinationError) as error:
                    with self.condition: self.mode = "paused"
                    raise CoordinationError("Stop needs reconciliation; momo is paused") from error
        return self.snapshot()

    @contextmanager
    def run(self, run_id, source="meeting", client=None, lease=None, *, account_id=None):
        if source not in {"meeting", "qq", "virtual"}:
            raise CoordinationError("Unsupported message source")
        with self.condition:
            if source == "meeting": self.require_meeting(client, lease)
            if len(self.queue) >= 32:
                raise CoordinationError("Too many pending conversations; please retry later")
            self.queue.append(run_id)
            try:
                while True:
                    if source == "meeting": self.require_meeting(client, lease)
                    elif self.started and self.mode != "meeting": raise CoordinationError("Momo is not activated")
                    elif self.focus or self.phone_paused or self.interrupt_hold:
                        raise CoordinationError("Phone work is held by the current attention policy")
                    from . import intro
                    if source != "meeting" and intro.restricted():
                        raise CoordinationError("Phone work is held during intro")
                    if source == "meeting" and intro.phase() in {"memory", "return_title", "celebration"}:
                        raise CoordinationError("Return to title to complete intro")
                    blocked = self.active or self.presentation or self.queue[0] != run_id
                    if source != "meeting": blocked = blocked or self.focus or self.phone_paused or self.interrupt_hold
                    if not blocked: break
                    self.condition.wait(.1)
                if self.restoring: raise CoordinationError("Data maintenance is in progress")
                self.queue.remove(run_id)
                self.active = run_id
                self.activity = {"runId": run_id, "source": source, "accountId": account_id, "phase": "thinking"}
                self._note_phone_activity()
                from . import checkpoint
                admission = (self.epoch, checkpoint.generation())
            except BaseException:
                if run_id in self.queue: self.queue.remove(run_id)
                self.condition.notify_all()
                raise
        try:
            yield admission
        finally:
            with self.condition:
                if self.active == run_id:
                    self.active = None
                    self.activity = None
                if source == "meeting" and not self.presentation:
                    self.interrupt_hold = False
                    self._release_held()
                self.condition.notify_all()

    def present(self, run_id, generation, *, display_run_id=None):
        if not self.started: return None
        with self.condition:
            if self.active != run_id or not self.owner:
                raise CoordinationError("Cannot present a stale run")
            presented_run = display_run_id or run_id
            # A hidden player may stop presentation while the same inference is
            # still streaming. Later sentences must keep that paused capability:
            # issuing a second token would strand the old one and block resume.
            for item in self.paused_presentations.values():
                if all(item.get(key) == value for key, value in {
                    "runId": presented_run, "generation": generation,
                    "clientId": self.owner["clientId"], "leaseId": self.owner["leaseId"],
                }.items()):
                    return item["token"]
            if not self.presentation:
                self.presentation = {"runId": presented_run, "token": uuid.uuid4().hex, "generation": generation, "clientId": self.owner["clientId"], "leaseId": self.owner["leaseId"], "expiresAt": time.monotonic() + 120}
            return self.presentation["token"]

    def complete_presentation(self, client, lease, run_id, token, generation, outcome="completed"):
        self.require_meeting(client, lease)
        with self.condition:
            item = self.paused_presentations.get(token) if outcome == "resume" else self.presentation
            if not item or any(item.get(k) != value for k, value in {"runId": run_id, "token": token, "generation": generation, "clientId": client, "leaseId": lease}.items()):
                raise CoordinationError("Presentation capability is stale or belongs to another run")
            if outcome == "resume":
                if self.active or self.presentation:
                    raise CoordinationError("Another activity owns attention; retry after it settles")
                from .checkpoint import generation as current_generation
                if current_generation() != generation:
                    self.paused_presentations.pop(token, None)
                    raise CoordinationError("Presentation belongs to an interrupted generation")
                self.presentation = self.paused_presentations.pop(token)
                self.interrupt_hold = True
            else:
                self.presentation = None
                if outcome == "stopped" and item.get("kind") != "replay": self.paused_presentations[token] = item
                self.interrupt_hold = False
                self._release_held()
            self.condition.notify_all()
            return self.snapshot()

    def replay(self, client, lease, run_id, event_id):
        from . import checkpoint
        self.require_meeting(client, lease)
        text = checkpoint.replay_text(run_id, event_id)
        if not text:
            raise CoordinationError("Only a visible assistant reply may be replayed")
        with self.condition:
            if self.active or self.presentation:
                raise CoordinationError("Another activity owns attention")
            self.presentation = {"runId": run_id, "token": uuid.uuid4().hex, "generation": checkpoint.generation(), "clientId": client, "leaseId": lease, "kind": "replay", "text": text, "expiresAt": time.monotonic() + 120}
            self.interrupt_hold = True
            self.condition.notify_all()
            return self.snapshot()

    def _hold_unstarted_reply(self, item):
        # Recompute only cancelled inference that never dispatched an external
        # command. An uncertain or completed send is never retried here.
        with self.condition:
            held = (self.mode == "meeting" or self.rebinding and self.mode == "stopping") and (self.interrupt_hold or self.focus or self.phone_paused)
            if not held or item["source"] not in {"qq"}:
                return False
            with db.tx() as c:
                if c.execute("SELECT 1 FROM outbox WHERE run_id=?", (item["run_id"],)).fetchone():
                    return False
                prior = c.execute("SELECT 1 FROM runs WHERE id=?", (item["run_id"],)).fetchone()
                origin = item["retry_of"] or (item["run_id"] if prior else "")
                c.execute("UPDATE inbox SET status=?,retry_of=?,run_id=? WHERE id=?", (self._pending_status(item["source"]), origin, uuid.uuid4().hex if prior else item["run_id"], item["id"]))
            return True

    def valid_run(self, run_id):
        with self.condition:
            self._expire()
            return not self.started or (not self.restoring and self.active == run_id and self.mode == "meeting")

    def social_action(self, action, arguments):
        """Model QQ actions share the active run, never a channel-owned brain."""
        from .social import social
        from . import checkpoint, social_media
        run_id = current_run.get()
        with self.condition:
            if not run_id or not self.started or not self.valid_run(run_id):
                raise CoordinationError("QQ tools require the current activated run")
            from . import intro
            if self.focus or self.phone_paused or intro.restricted():
                raise CoordinationError("QQ activity is paused")
            rows = db.query("SELECT * FROM inbox WHERE run_id=? ORDER BY seq DESC LIMIT 1",(run_id,))
            if not rows or rows[0]['audience'] != checkpoint.audience():
                raise CoordinationError("QQ action audience is not the admitted conversation")
            local = rows[0]['source'] == 'meeting' and rows[0]['audience'] == 'owner'
            if self.interrupt_hold and not local:
                raise CoordinationError('QQ activity is held for local conversation')
            run_epoch, run_generation = self.epoch, checkpoint.generation()
            if action == 'media.library':
                if not local or social._account('qq').get('permissions',{}).get('media') is not True or not social._account('qq').get('enabled'):
                    raise CoordinationError("QQ media library is not granted")
                return {'items': social_media.listing()}
            authorization = social.authorize_action(action,arguments,audience=checkpoint.audience(),local_owner=local)
        native_args = dict(authorization['params'])
        if action == 'media.send':
            native_args.pop('mediaId',None)
            native_args.update(social_media.payload(authorization['params']['mediaId'],audience=checkpoint.audience(),expected=authorization))
        result = self.command('channels.action',{
            'pluginId':authorization['pluginId'],'accountId':authorization['accountId'],
            'policyRevision':authorization['policyRevision'],'peerId':authorization.get('peerId'),'selfId':authorization['expectedSelfId'],
            'action':action,'arguments':native_args,'authorizationArguments':authorization['params'],
            'audience':checkpoint.audience(),'localOwner':local,'replyMode':not local,
        },run_id)
        from .social_actions import MUTATIONS
        with self.condition:
            if action not in MUTATIONS and (not self.valid_run(run_id) or self.focus or self.phone_paused or self.interrupt_hold and not local or self.epoch != run_epoch or checkpoint.generation() != run_generation):
                raise CoordinationError('QQ query result belongs to withdrawn attention')
            filtered = social.filter_action_result(authorization,result.get('result',{}))
            if action == 'media.fetch':
                filtered = social_media.store_result(filtered,audience=checkpoint.audience(),expected=authorization)
        receipt = result.get('receipt',{})
        # Receipts describe the original operation, not a fabricated read/sent
        # claim. Query bytes/contact data are never copied into event receipts.
        return {'result':filtered,'receipt':{k:receipt[k] for k in ('commandId','status','deliveryStatus','externalMessageId') if k in receipt}}

    def command(self, method, params, run_id=None):
        run_id = run_id or current_run.get()
        with self.condition:
            if not self.valid_run(run_id): raise CoordinationError("Stale execution")
            from . import intro
            if intro.restricted(): raise CoordinationError("Plugin activity is paused during intro")
            if self.focus: raise CoordinationError("Plugin activity is paused while focusing")
            if method == "channels.send":
                from .social import social
                if self.phone_paused or self.interrupt_hold:
                    raise CoordinationError("Phone activity is paused")
                authorized_account = social.authorize_send(params["accountId"], params["peerId"], params["policyRevision"], audience=params.get("audience"))
                params = {**params, "selfId": authorized_account["expectedSelfId"]}
            permit = self.host.permit(run_id)
            if method == "channels.action":
                from .social import social
                if self.phone_paused or self.interrupt_hold and not params.get("localOwner"):
                    raise CoordinationError("QQ activity is paused")
                social.authorize_action(params['action'],params['authorizationArguments'],
                    account_id=params['accountId'],revision=params['policyRevision'],
                    audience=params['audience'],local_owner=params['localOwner'],consume=True,command_id=permit['commandId'])
            payload = {"method": method, **{k: params[k] for k in ("pluginId", "accountId", "peerId", "policyRevision", "action", "selfId") if k in params}}
            if method == "channels.action":
                payload["proactive"] = params["action"] in {"private.send","group.send"} or params["action"] == "media.send" and params.get("localOwner") is True
                arguments = params.get("authorizationArguments",{})
                payload.update({key:arguments[key] for key in ("operation","memberId","approve") if key in arguments})
            if "text" in params: payload["textHash"] = hashlib.sha256(params["text"].encode()).hexdigest()
            if method == "channels.action" and params.get("action") in {"private.send", "group.send"}:
                # Keep submitted text in the private command ledger. Phone views
                # expose it only after an actual successful provider receipt.
                payload["displayText"] = params.get("arguments", {}).get("text", "")
            with db.tx() as c:
                c.execute("INSERT INTO outbox(command_id,run_id,epoch,status,payload,at) VALUES(?,?,?,?,?,?)", (permit["commandId"], run_id, permit["activityEpoch"], "pending", json.dumps(payload), db.now_iso()))
            if self.activity: self.activity["phase"] = "sending" if method == "channels.send" else "tool"
            if self.activity and method == "channels.action": self.activity["toolSource"] = "qq"
            if self.activity and method in {"channels.send", "channels.action"}:
                self.activity["peerId"] = params.get("peerId")
                self._note_phone_activity()
        try:
            result = self.host.request(method, {**params, "permit": permit}, timeout=35)
            receipt = result.get("receipt", result) if isinstance(result, dict) else {}
            if receipt.get("commandId"): self.record_receipt(receipt)
            if receipt.get("status") == "unknown" and self.started:
                with self.condition:
                    self.mode = "paused"
                    self.condition.notify_all()
            return result
        except HostError as error:
            # These channel codes come from sendChannel's gates before
            # beginCommand. If a channel returns the same code after dispatch,
            # its receipt has already recorded failed or unknown, and the
            # conditional update below preserves that stronger fact.
            safe = {"PAUSED", "STALE_PERMIT", "INVALID_PERMIT", "DUPLICATE_COMMAND", "CAPACITY", "TOOL_UNAVAILABLE", "STALE_CONFIG", "Plugin host is unavailable", "PERMISSION_DENIED", "CHANNEL_UNAVAILABLE", "IDENTITY_MISMATCH"}
            if method in {"channels.send", "channels.action"}:
                safe |= {"PLUGIN_UNAVAILABLE", "CAPABILITY_UNAVAILABLE", "FORBIDDEN", "INPUT"}
            read_only_action = method == "channels.action" and params["action"] in {"contacts.list","history.list","media.fetch","friends.listRequests","groups.list","groups.members"}
            status = "failed" if read_only_action or str(error) in safe else "unknown"
            with db.tx() as c:
                c.execute("UPDATE outbox SET status=? WHERE command_id=? AND status IN ('pending','executing')", (status, permit["commandId"]))
            if self.started and self._unresolved_commands():
                with self.condition:
                    self.mode = "paused"
                    self.epoch += 1
                    self._cancel_generation()
                    self.condition.notify_all()
                self._schedule_qq_recovery()
            raise
        finally:
            with self.condition:
                if method == "channels.action" and self.activity and self.activity.get("runId") == run_id:
                    self.activity.pop("toolSource",None)
                    self.activity["phase"] = "thinking"

    @contextmanager
    def maintenance(self):
        with self.transition:
            with self.condition:
                self.restoring = True
                self.mode = "stopping"
            try:
                self._revoke("data_maintenance")
                yield
            finally:
                self.schema()
                with db.tx() as c:
                    c.execute("UPDATE inbox SET status='interrupted' WHERE status IN ('processing','queued','held_inactive','held_focus','held_paused','held_interrupt')")
                    c.execute("UPDATE outbox SET status='unknown' WHERE status IN ('pending','executing')")
                with self.condition:
                    self.restoring, self.mode, self.owner = False, "paused", None
                    self.presentation = None
                    self.paused_presentations.clear()
                    self.condition.notify_all()

    def _worker(self):
        while not self.closed.wait(.05):
            with self.condition:
                self._expire()
                from . import intro
                if self.mode != "meeting" or self.restoring or self.active or self.presentation or self.focus or self.phone_paused or self.interrupt_hold or intro.restricted():
                    continue
            rows = db.query("SELECT * FROM inbox WHERE status='queued' ORDER BY seq LIMIT 1")
            if not rows or rows[0]["source"] == "meeting": continue
            first = rows[0]
            # Historical and restored inbox rows keep their text, but only
            # reviewed current transports can acquire inference or delivery.
            if first["source"] != "qq" and not (first["source"] == "virtual" and self.virtual_enabled):
                self.inbox_status(first["id"], "held_scope")
                continue
            rid = first["run_id"]
            try:
                with self.run(rid, first["source"], account_id=first["account_id"]) as admission:
                    from . import turn, checkpoint
                    run_epoch, run_generation = admission
                    plugin_context = None
                    if first["source"] in {"qq"}:
                        from .social import social
                        from .turn_context import validate_plugin_context
                        incoming = {"source": first["source"], "accountId": first["account_id"], "peerId": first["peer_id"], "senderId": first["sender_id"], "selfId": first["self_id"], "conversationKind": "group" if first["peer_id"].startswith("group:") else "private", "groupId": first["peer_id"][6:] if first["peer_id"].startswith("group:") else None, "externalMessageId": first["raw_external_id"], "text": first["text"], "policyRevision": int(first["policy_revision"] or 0)}
                        normalized = social.authorize_event(incoming)
                        if normalized is None or normalized["audience"] != first["audience"] or not normalized["allowReply"]:
                            self.inbox_status(first["id"], "held_scope")
                            continue
                        try:
                            plugin_context = self.host.request("plugins.promptContext", {"pluginId": normalized["pluginId"], "source": first["source"], "accountId": first["account_id"], "peerId": first["peer_id"], "policyRevision": int(first["policy_revision"])}, timeout=3)
                            validate_plugin_context(plugin_context, first["source"])
                        except (HostError, ValueError, TypeError):
                            # Preserve the input without guessing another channel
                            # or inferring under an unavailable plugin's context.
                            self.inbox_status(first["id"], "held_scope")
                            continue
                    with self.condition:
                        # Identity verification is an asynchronous host RPC. A
                        # stop/focus/lease transition while it waits must not
                        # let this old run capture a newly granted generation.
                        if (not self.valid_run(rid) or self.mode != "meeting"
                            or self.focus or self.phone_paused or self.interrupt_hold
                            or self.epoch != run_epoch or checkpoint.generation() != run_generation):
                            if not self._hold_unstarted_reply(first):
                                self.inbox_status(first["id"], "interrupted")
                            continue
                        if first["source"] in {"qq"}:
                            normalized = social.authorize_event(incoming)
                            if normalized is None or normalized["audience"] != first["audience"] or not normalized["allowReply"]:
                                self.inbox_status(first["id"], "held_scope")
                                continue
                        self.inbox_status(first["id"], "processing")
                    token = current_run.set(rid)
                    try:
                        events = list(turn.run_turn(first["text"], run_id=rid, source=first["source"], external_message_id=json.dumps([first["account_id"], first["peer_id"], first["external_id"]]), audience=first["audience"], retry_of=first["retry_of"] or None, plugin_context=plugin_context, expected_generation=run_generation))
                    finally:
                        current_run.reset(token)
                    reply = "".join(e.get("text", "") for e in events if e["t"] == "sentence")
                    if reply and self.valid_run(rid):
                        method = "channels.send" if first["source"] in {"qq"} else "virtual.deliver"
                        params = {"text": reply, "accountId": first["account_id"]}
                        if method == "channels.send": params.update(pluginId="momo-" + first["source"], peerId=first["peer_id"], policyRevision=int(first["policy_revision"] or 0), audience=first["audience"])
                        result = self.command(method, params, rid)
                        receipt = result.get("receipt", result)
                        if receipt.get("status") in {"delivered", "completed"}:
                            gen = next(e["generation"] for e in events if e["t"] == "sentence")
                            if first["source"] in {"qq"}:
                                checkpoint.acknowledge_external(rid, reply, receipt["commandId"])
                            else:
                                checkpoint.acknowledge(rid, reply, gen)
                        self.inbox_status(first["id"], "completed" if receipt.get("status") in {"completed", "delivered"} else "unknown" if receipt.get("status") == "unknown" else "failed")
                    else:
                        if not self._hold_unstarted_reply(first):
                            self.inbox_status(first["id"], "failed" if not reply else "interrupted")
            except Exception:
                if not self._hold_unstarted_reply(first):
                    self.inbox_status(first["id"], "interrupted")


runtime = Coordinator()
