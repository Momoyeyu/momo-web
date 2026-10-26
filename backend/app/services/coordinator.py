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
            self.owner = None
            self.presentation = None
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

    def _persist_attention_policy(self):
        with db.tx() as c:
            c.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('attention_policy',?)", (json.dumps({"focus": self.focus, "phonePaused": self.phone_paused}),))

    def configure_host_plugins(self, configs, *, tolerate_errors=True, revision=None):
        from .social import social
        with self.configuration_lock:
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
        if self.host:
            return self.host.request("plugins.configure", params, timeout=35)
        return {}

    def refresh_social_plugins(self):
        return self.configure_host_plugins(None)

    def configure_extensions(self, extensions):
        from ..core.mcp import hub
        hub.bind(self)
        return hub.configure(extensions)

    def event(self, name, data):
        # Never await the host on its reader thread (it owns RPC replies).
        if name == "receipt":
            self.record_receipt(data)
        elif name == "inbox":
            if data.get("source") in {"qq", "wechat"}:
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
        if self.focus:
            return "held_focus"
        if self.phone_paused:
            return "held_paused"
        if self.interrupt_hold:
            return "held_interrupt"
        return "queued"

    def enqueue(self, source, account, external_id, text, *, peer_id="", sender_id="", self_id="", audience="owner", policy_revision=""):
        self.schema()
        # Provider ids are local to an account AND peer, never globally unique.
        canonical = json.dumps([self_id, peer_id, external_id], ensure_ascii=False, separators=(",", ":")) if peer_id else str(external_id)
        with self.condition:
            pending_status = self._pending_status(source)
            with db.tx() as c:
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
            c.execute("UPDATE inbox SET status=? WHERE status IN ('queued','held_inactive','held_focus','held_paused','held_interrupt') AND source!='meeting'", (self._pending_status("qq"),))

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

    def _unresolved_commands(self):
        rows = db.query("SELECT * FROM outbox WHERE status='unknown'")
        return [r for r in rows if json.loads(r["payload"]).get("method") in {"plugins.callTool", "channels.send"} or json.loads(r["receipt"] or "{}").get("requiresReconciliation")]

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
                if provider in {"qq", "wechat"}:
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
                with self.condition:
                    self.mode = "meeting"
                    self.rebinding = False
                    self.interrupt_hold = False
                    self.owner = {"clientId": client, "leaseId": uuid.uuid4().hex, "expiresAt": time.monotonic() + LEASE_SECONDS}
                    self._release_held()
                    self.condition.notify_all()
                    return self._lease()
            except (HostError, CoordinationError) as error:
                with self.condition:
                    self.mode, self.owner = "paused", None
                raise CoordinationError("Could not settle the previous activity; momo is paused") from error
        finally:
            self.transition.release()

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

    def recover_attention(self):
        """Called only by the authenticated human reconciliation endpoint."""
        with self.transition:
            self.schema()
            if self._unresolved_commands():
                raise CoordinationError("Other unknown commands still need reconciliation")
            with self.condition:
                self.mode = "stopping"
            try:
                self._revoke("human_recovery")
                with self.condition:
                    owner_valid = bool(self.owner and self.owner["expiresAt"] > time.monotonic())
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
            phone_active = bool(self.activity and self.activity["source"] != "meeting") or self._external_running()
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
            stop_active = bool(not from_run and action in {"stop", "focus_on"} and ((self.activity and self.activity["source"] != "meeting") or self._external_running()))
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
        with self.condition:
            if source == "meeting": self.require_meeting(client, lease)
            self.queue.append(run_id)
            try:
                while True:
                    if source == "meeting": self.require_meeting(client, lease)
                    elif self.started and self.mode != "meeting": raise CoordinationError("Momo is not activated")
                    elif self.focus or self.phone_paused or self.interrupt_hold:
                        raise CoordinationError("Phone work is held by the current attention policy")
                    blocked = self.active or self.presentation or self.queue[0] != run_id
                    if source != "meeting": blocked = blocked or self.focus or self.phone_paused or self.interrupt_hold
                    if not blocked: break
                    self.condition.wait(.1)
                if self.restoring: raise CoordinationError("Data maintenance is in progress")
                self.queue.remove(run_id)
                self.active = run_id
                self.activity = {"runId": run_id, "source": source, "accountId": account_id, "phase": "thinking"}
            except BaseException:
                if run_id in self.queue: self.queue.remove(run_id)
                self.condition.notify_all()
                raise
        try:
            yield
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
            if not held or item["source"] not in {"qq", "wechat"}:
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

    def command(self, method, params, run_id=None):
        run_id = run_id or current_run.get()
        with self.condition:
            if not self.valid_run(run_id): raise CoordinationError("Stale execution")
            if self.focus: raise CoordinationError("Plugin activity is paused while focusing")
            if method == "channels.send":
                from .social import social
                if self.phone_paused or self.interrupt_hold:
                    raise CoordinationError("Phone activity is paused")
                social.authorize_send(params["accountId"], params["peerId"], params["policyRevision"], audience=params.get("audience"))
            permit = self.host.permit(run_id)
            payload = {"method": method, **{k: params[k] for k in ("pluginId", "accountId", "peerId", "policyRevision") if k in params}}
            if "text" in params: payload["textHash"] = hashlib.sha256(params["text"].encode()).hexdigest()
            with db.tx() as c:
                c.execute("INSERT INTO outbox(command_id,run_id,epoch,status,payload,at) VALUES(?,?,?,?,?,?)", (permit["commandId"], run_id, permit["activityEpoch"], "pending", json.dumps(payload), db.now_iso()))
            if self.activity: self.activity["phase"] = "sending" if method == "channels.send" else "tool"
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
            if method == "channels.send":
                safe |= {"PLUGIN_UNAVAILABLE", "CAPABILITY_UNAVAILABLE", "FORBIDDEN", "INPUT"}
            status = "failed" if str(error) in safe else "unknown"
            with db.tx() as c:
                c.execute("UPDATE outbox SET status=? WHERE command_id=? AND status IN ('pending','executing')", (status, permit["commandId"]))
            if self.started and self._unresolved_commands():
                with self.condition:
                    self.mode = "paused"
                    self.epoch += 1
                    self._cancel_generation()
                    self.condition.notify_all()
            raise

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
                if self.mode != "meeting" or self.restoring or self.active or self.presentation or self.focus or self.phone_paused or self.interrupt_hold:
                    continue
            rows = db.query("SELECT * FROM inbox WHERE status='queued' ORDER BY seq LIMIT 1")
            if not rows or rows[0]["source"] == "meeting": continue
            first = rows[0]
            rid = first["run_id"]
            try:
                with self.run(rid, first["source"], account_id=first["account_id"]):
                    if first["source"] in {"qq", "wechat"}:
                        from .social import social
                        normalized = social.authorize_event({"source": first["source"], "accountId": first["account_id"], "peerId": first["peer_id"], "senderId": first["sender_id"], "selfId": first["self_id"], "conversationKind": "private", "externalMessageId": first["raw_external_id"], "text": first["text"], "policyRevision": int(first["policy_revision"] or 0)})
                        if normalized is None or normalized["audience"] != first["audience"]:
                            self.inbox_status(first["id"], "held_scope")
                            continue
                    self.inbox_status(first["id"], "processing")
                    from . import turn, checkpoint
                    token = current_run.set(rid)
                    try:
                        events = list(turn.run_turn(first["text"], run_id=rid, source=first["source"], external_message_id=json.dumps([first["account_id"], first["peer_id"], first["external_id"]]), audience=first["audience"], retry_of=first["retry_of"] or None))
                    finally:
                        current_run.reset(token)
                    reply = "".join(e.get("text", "") for e in events if e["t"] == "sentence")
                    if reply and self.valid_run(rid):
                        method = "channels.send" if first["source"] in {"qq", "wechat"} else "virtual.deliver"
                        params = {"text": reply, "accountId": first["account_id"]}
                        if method == "channels.send": params.update(pluginId="momo-" + first["source"], peerId=first["peer_id"], policyRevision=int(first["policy_revision"] or 0), audience=first["audience"])
                        result = self.command(method, params, rid)
                        receipt = result.get("receipt", result)
                        if receipt.get("status") in {"delivered", "completed"}:
                            gen = next(e["generation"] for e in events if e["t"] == "sentence")
                            if first["source"] in {"qq", "wechat"}:
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
