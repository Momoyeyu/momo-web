"""Reviewed personal-account channels: private configuration and final policy gates.

The account file lives outside the life archive; native login is runtime-owned.
Events are trusted only after host authentication; platform identity, recipient,
permissions and their revision are still checked here before inference or send.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
import threading
import time
import uuid

from ..core import db, state


class SocialError(ValueError):
    pass


QQ_RUNTIME_ERRORS = {
    "OWNER_ACTION_REQUIRED": "QQ login requires an explicit local owner action",
    "RESOURCE_UNAVAILABLE": "Managed QQ resources are not available",
    "RESOURCE_INVALID": "Managed QQ resources are not qualified",
    "INPUT": "Invalid QQ login action",
    "ATTEMPT_CANCELLED": "QQ login attempt was cancelled or replaced",
    "RUNTIME_FAILED": "Managed QQ runtime failed",
    "RUNTIME_TIMEOUT": "Managed QQ runtime did not respond",
    "RUNTIME_NOT_QUIESCENT": "Managed QQ runtime has not stopped",
    "RUNTIME_STOPPED": "Managed QQ runtime stopped",
    "RUNTIME_UNAVAILABLE": "Managed QQ runtime is unavailable",
    "IPC_LIMIT": "Managed QQ runtime exceeded its communication limit",
    "IPC_PROTOCOL": "Managed QQ runtime returned an invalid response",
    "ACCOUNT_MISMATCH": "The logged-in QQ account does not match the bound account",
    "FORGET_UNAVAILABLE": "Managed QQ session removal is unavailable",
    "FORGET_FAILED": "Managed QQ session could not be removed",
}
QQ_RUNTIME_STATES = {
    "idle", "preparing", "connecting", "qr_pending", "awaiting_confirmation", "verifying",
    "expired", "connected", "identity_mismatch", "cancelled", "stopping", "stopped",
    "disconnected", "error",
}


class QQRuntimeError(SocialError):
    def __init__(self, code):
        self.code = code if code in QQ_RUNTIME_ERRORS else "RUNTIME_UNAVAILABLE"
        super().__init__(QQ_RUNTIME_ERRORS[self.code])


def _public_qq_runtime_status(value):
    """Whitelist the private host reply; native diagnostics never enter HTTP."""
    if (not isinstance(value, dict) or value.get("provider") != "qq"
        or not isinstance(value.get("status"), str) or value["status"] not in QQ_RUNTIME_STATES
        or any(type(value.get(key)) is not bool for key in ("running", "connected", "executorQuiescent"))):
        raise QQRuntimeError("IPC_PROTOCOL")
    identity = value.get("actualSelfId")
    if identity is not None and (not isinstance(identity, str) or not re.fullmatch(r"[1-9][0-9]{0,19}", identity)):
        raise QQRuntimeError("IPC_PROTOCOL")
    attempt = value.get("attemptId")
    if attempt is not None:
        try:
            if not isinstance(attempt, str) or str(uuid.UUID(attempt)) != attempt:
                raise ValueError
        except (ValueError, AttributeError):
            raise QQRuntimeError("IPC_PROTOCOL") from None
    if (value["connected"] != (value["status"] == "connected")
        or value["connected"] and (not value["running"] or not identity)
        or value["running"] and value["executorQuiescent"]):
        raise QQRuntimeError("IPC_PROTOCOL")
    result = {key: value[key] for key in ("provider", "status", "running", "connected", "executorQuiescent")}
    error = value.get("error")
    result.update({"actualSelfId": identity, "attemptId": attempt,
                   "error": error if isinstance(error, str) and error in QQ_RUNTIME_ERRORS else "RUNTIME_FAILED" if error is not None else None,
                   "qr": None})
    qr = value.get("qr")
    if qr is not None:
        if (not isinstance(qr, dict) or not isinstance(qr.get("dataUrl"), str)
            or len(qr["dataUrl"]) > 384 * 1024
            or not re.fullmatch(r"data:image/png;base64,[A-Za-z0-9+/]+={0,2}", qr["dataUrl"])
            or type(qr.get("expiresAt")) is not int):
            raise QQRuntimeError("IPC_PROTOCOL")
        now = int(time.time() * 1000)
        if qr["expiresAt"] > now + 10 * 60 * 1000:
            raise QQRuntimeError("IPC_PROTOCOL")
        if not value["connected"] and qr["expiresAt"] > now:
            result["qr"] = {"dataUrl": qr["dataUrl"], "expiresAt": qr["expiresAt"]}
        elif not value["connected"] and result["status"] == "qr_pending":
            result["status"] = "expired"
    return result


PROVIDERS = ("qq",)
CAPABILITIES = {"receive": True, "reply": True, "proactive": False,
                "contacts": False, "history": False, "ownerBinding": True}
PERMISSIONS = {"receive": True, "reply": True, "proactive": False,
               "contacts": False, "history": False}


def _identifier(value, label="identity"):
    if not isinstance(value, str) or not value.strip() or len(value) > 160 or any(ord(c) < 32 for c in value):
        raise SocialError(f"Invalid {label}")
    return value.strip()


class SocialAccounts:
    def __init__(self):
        self.lock = threading.RLock()
        self._qq_logging_out = False

    def _path(self):
        # macOS exposes /var through /private/var. Canonicalize the configured
        # life root before checking our private tree for redirected files.
        root = state.DATA_DIR.resolve()
        profile = hashlib.sha256(str(root).encode()).hexdigest()[:20]
        return root.parent / ".workbuddy" / "social" / profile / "accounts.json"

    def _read(self):
        path = self._path()
        if path.is_symlink() or any(p.is_symlink() for p in path.parents):
            raise SocialError("Private account storage is unavailable")
        try:
            if os.name != "nt" and path.stat().st_mode & 0o077:
                raise SocialError("Private account storage permissions are unsafe")
            content = json.loads(path.read_text())
            if not isinstance(content, dict):
                raise SocialError("Private account storage is invalid")
            account = content.get("qq")
            if isinstance(account, dict):
                # Disposable bridge configuration cannot enable the native
                # account or carry an old gateway credential into the host.
                managed = account.get("transport") == "managed"
                account = {**self._default("qq"), **account}
                if not managed:
                    account["enabled"] = False
                account["transport"] = "managed"
                for key in ("endpoint", "token", "credentialRef"):
                    account.pop(key, None)
                content["qq"] = account
            return content
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as error:
            raise SocialError("Private account storage is unavailable") from error

    def _write(self, content):
        path = self._path()
        if path.is_symlink() or any(p.is_symlink() for p in path.parents):
            raise SocialError("Private account storage is unavailable")
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(path.parent, 0o700)
        temp = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as out:
                temp = Path(out.name)
                os.chmod(temp, 0o600)
                json.dump(content, out, ensure_ascii=False)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temp, path)
        finally:
            if temp is not None:
                temp.unlink(missing_ok=True)

    def _default(self, provider):
        if provider not in PROVIDERS:
            raise SocialError("Unsupported personal-account provider")
        return {"provider": provider, "id": "momo-" + provider,
                "accountId": provider + "-main", "expectedSelfId": "",
                "transport": "managed",
                "enabled": False, "permissions": dict(PERMISSIONS), "allowlistEnabled": False,
                "allowlist": [], "ownerPeerId": None, "policyRevision": 0, "quarantined": False}

    def _account(self, provider):
        return self._read().get(provider, self._default(provider))

    def get(self, provider):
        with self.lock:
            account = copy.deepcopy(self._account(provider))
        value = {key: copy.deepcopy(account.get(key)) for key in self._default(provider)}
        value["capabilities"] = dict(CAPABILITIES)
        value["status"] = "quarantined" if account.get("quarantined") else "disconnected" if account["enabled"] else "disabled"
        value["actualSelfId"] = None
        # The host reader may be persisting an incoming event. Never hold the
        # account lock while awaiting a reply that only that reader can deliver.
        if account["enabled"] and not account.get("quarantined"):
            health = self._health(provider)
            if health:
                value["actualSelfId"] = health.get("actualSelfId")
                value["executorQuiescent"] = health.get("executorQuiescent") is True
                value["status"] = health.get("status", "disconnected")
                if health.get("error"):
                    value["error"] = "Channel connection is unavailable"
                supported = health.get("capabilities", {})
                if isinstance(supported, dict):
                    value["capabilities"] = {k: bool(v and supported.get(k, k == "ownerBinding")) for k, v in CAPABILITIES.items()}
        return value

    def list_accounts(self):
        return {"accounts": [self.get(p) for p in PROVIDERS],
                "providers": [{"id": p, "name": "QQ",
                               "auth": "personal_native", "oauthMessaging": False,
                               "capabilities": dict(CAPABILITIES)} for p in PROVIDERS]}

    def native_restore_binding(self):
        """Restore only an eligible stored identity, never its previous grants."""
        with self.lock:
            if not self._path().is_file():
                return None
            account = self._account("qq")
            identity = account.get("expectedSelfId")
            if (account.get("transport") != "managed" or account.get("enabled") is not True
                or account.get("quarantined") or not isinstance(identity, str)
                or not re.fullmatch(r"[1-9][0-9]{0,19}", identity)):
                return None
            return {key: account.get(key) for key in ("id", "accountId", "expectedSelfId", "transport")}

    def managed_qq_runtime(self, action="status"):
        """Local-user login management is independent of Boot and message grants.

        The host owns engine/session lifecycle. Login never grants messaging;
        explicit logout withdraws business without changing grants or identity.
        """
        if action != "forget":
            return self._request_qq_runtime(action)
        with self.lock:
            if self._qq_logging_out:
                raise QQRuntimeError("RUNTIME_NOT_QUIESCENT")
            data = self._read()
            account = data.get("qq")
            if account is not None:
                account["enabled"] = False
                account["policyRevision"] = int(account["policyRevision"]) + 1
                self._write(data)
            self._qq_logging_out = True
        try:
            # Withdraw Python's event/send/Boot gates before the native stop.
            # Do not wait for unrelated MCP configuration to release QQ.
            return self._request_qq_runtime(action)
        finally:
            with self.lock:
                self._qq_logging_out = False

    def _request_qq_runtime(self, action):
        from .coordinator import runtime
        if action not in {"status", "begin", "refresh", "cancel", "stop", "forget"}:
            raise QQRuntimeError("INPUT")
        if not runtime.started or not runtime.host:
            raise QQRuntimeError("RUNTIME_UNAVAILABLE")
        params = {"authenticatedDetail": True} if action == "status" else {"ownerAction": True}
        if action == "begin":
            with self.lock:
                expected = self._account("qq").get("expectedSelfId") or None
            if expected is not None and not re.fullmatch(r"[1-9][0-9]{0,19}", expected):
                raise QQRuntimeError("INPUT")
            params["expectedSelfId"] = expected
        timeout = 3 if action == "status" else 35 if action in {"begin", "refresh"} else 20
        try:
            value = runtime.host.request("qq.runtime." + action, params, timeout=timeout)
        except Exception as error:
            # HostError already strips native diagnostics. Preserve only the
            # finite public codes even if a future transport regresses that rule.
            code = str(error)
            raise QQRuntimeError(code if code in QQ_RUNTIME_ERRORS else "RUNTIME_UNAVAILABLE") from None
        result = _public_qq_runtime_status(value)
        if action == "forget" and (result["status"] != "idle" or result["running"]
            or not result["executorQuiescent"] or result["actualSelfId"] is not None
            or result["attemptId"] is not None or result["qr"] is not None):
            raise QQRuntimeError("IPC_PROTOCOL")
        return result

    def _health(self, provider):
        from .coordinator import runtime
        if not runtime.started or not runtime.host:
            return None
        try:
            return runtime.host.request("channels.health", {"pluginId": "momo-" + provider}, timeout=3)
        except Exception:
            return None

    def _refresh(self):
        from .coordinator import runtime
        if runtime.started:
            runtime.refresh_social_plugins()

    def put(self, provider, values):
        if not isinstance(values, dict):
            raise SocialError("Account configuration must be an object")
        allowed = {"enabled", "accountId", "expectedSelfId", "permissions", "allowlistEnabled", "allowlist"}
        if set(values) - allowed:
            raise SocialError("Unknown account field; owner identity requires a verified challenge")
        with self.lock:
            data = self._read()
            old = data.get(provider, self._default(provider))
            account = copy.deepcopy(old)
            if not old["enabled"] and values.get("enabled") is True:
                raise SocialError("Use the verified QQ connection action to enable managed chat")
            for flag in ("enabled", "allowlistEnabled"):
                if flag in values:
                    if not isinstance(values[flag], bool):
                        raise SocialError("Permission switches must be boolean")
                    account[flag] = values[flag]
            for key in ("accountId", "expectedSelfId"):
                if key in values:
                    account[key] = _identifier(values[key], key) if values[key] else ""
            if "permissions" in values:
                grants = values["permissions"]
                if not isinstance(grants, dict) or set(grants) - set(PERMISSIONS):
                    raise SocialError("Unknown permission")
                if any(not isinstance(value, bool) or value and not CAPABILITIES[key] for key, value in grants.items()):
                    raise SocialError("A requested permission is not supported")
                account["permissions"] = {**account["permissions"], **grants}
            if "allowlist" in values:
                entries = values["allowlist"]
                if not isinstance(entries, list) or len(entries) > 200:
                    raise SocialError("Use at most 200 allowed contacts")
                normalized = {}
                for entry in entries:
                    if not isinstance(entry, dict) or set(entry) - {"peerId", "label"}:
                        raise SocialError("Invalid allowed contact")
                    peer = _identifier(entry.get("peerId"), "contact identity")
                    label = entry.get("label", "")
                    if not isinstance(label, str) or len(label) > 160:
                        raise SocialError("Invalid contact label")
                    normalized[peer] = {"peerId": peer, "label": label}
                account["allowlist"] = list(normalized.values())
            required = ("accountId", "expectedSelfId")
            if account["enabled"] and not all(account[k] for k in required):
                raise SocialError("Configure the account identity first")
            if any(p != provider and row.get("accountId") == account["accountId"] for p, row in data.items()):
                raise SocialError("Each channel account needs a distinct identity")
            rebound = any(account[k] != old[k] for k in ("accountId", "expectedSelfId"))
            if rebound:
                account["ownerPeerId"] = None
                account.pop("ownerChallenge", None)
            account["policyRevision"] = int(old["policyRevision"]) + 1
            data[provider] = account
            self._write(data)
        self._refresh()
        return self.get(provider)

    def host_configs(self):
        with self.lock:
            result = []
            for provider, row in self._read().items():
                if provider not in PROVIDERS or not row.get("enabled") or row.get("quarantined"):
                    continue
                result.append({"id": row["id"], "type": provider, "transport": "managed", "enabled": True,
                    "accountId": row["accountId"], "expectedSelfId": row["expectedSelfId"],
                    "permissions": row["permissions"],
                    "policyRevision": row["policyRevision"], "allowlistEnabled": row["allowlistEnabled"],
                    "allowlist": [p["peerId"] for p in row["allowlist"]]})
            return result

    def _peer_allowed(self, account, peer):
        return not account["allowlistEnabled"] or peer in {p["peerId"] for p in account["allowlist"]}

    def _audience(self, account, peer):
        return "owner" if account.get("ownerPeerId") == peer else "social:" + hashlib.sha256(
            json.dumps([account["provider"], account["accountId"], peer], separators=(",", ":")).encode()).hexdigest()

    def authorize_event(self, event):
        with self.lock:
            provider = event.get("source")
            if provider not in PROVIDERS:
                return None
            account = self._account(provider)
            peer, sender = event.get("peerId"), event.get("senderId")
            if (not account["enabled"] or account.get("quarantined") or not account["permissions"]["receive"]
                or event.get("accountId") != account["accountId"] or event.get("selfId") != account["expectedSelfId"]
                or event.get("conversationKind") != "private" or not isinstance(peer, str) or not peer
                or sender != peer or sender == account["expectedSelfId"] or not self._peer_allowed(account, peer)
                or not isinstance(event.get("text"), str) or not 0 < len(event["text"]) <= 16000
                or not isinstance(event.get("externalMessageId"), str) or not event["externalMessageId"]):
                return None
            revision = event.get("policyRevision")
            if revision is not None and revision != account["policyRevision"]:
                return None
            challenge = account.get("ownerChallenge")
            if challenge and challenge["peerId"] == peer and challenge["expiresAt"] > time.time():
                digest = hashlib.sha256(event["text"].strip().encode()).hexdigest()
                if secrets.compare_digest(digest, challenge["hash"]):
                    data = self._read()
                    account["ownerPeerId"] = peer
                    account.pop("ownerChallenge", None)
                    data[provider] = account
                    self._write(data)
                    return None
            audience = self._audience(account, peer)
            return {**event, "policyRevision": account["policyRevision"], "audience": audience,
                    "pluginId": account["id"], "allowReply": account["permissions"]["reply"]}

    def authorize_send(self, account_id, peer_id, revision, *, audience):
        with self.lock:
            account = next((row for provider, row in self._read().items()
                            if provider in PROVIDERS and row.get("provider") == provider and row.get("accountId") == account_id), None)
            if (not account or not account["enabled"] or account.get("quarantined")
                or not account["permissions"]["reply"] or account["policyRevision"] != revision
                or not self._peer_allowed(account, peer_id) or peer_id == account["expectedSelfId"]
                or audience != self._audience(account, peer_id)):
                raise SocialError("Reply permission or recipient scope changed")
            return {k: copy.deepcopy(v) for k, v in account.items() if k not in {"credentialRef", "ownerChallenge"}}

    def owner_challenge(self, provider, peer_id):
        peer = _identifier(peer_id, "contact identity")
        with self.lock:
            data = self._read()
            account = data.get(provider, self._default(provider))
            if not account["enabled"] or not account["permissions"]["receive"] or not self._peer_allowed(account, peer):
                raise SocialError("Enable receiving from this contact before linking identity")
            challenge = "momo-link-" + secrets.token_urlsafe(18)
            expires = time.time() + 300
            # Revoke the old owner's authority on the local configuration
            # request, where the host can be synchronously stopped/refreshed.
            # The later proof arrives on its RPC reader and cannot await it.
            account["ownerPeerId"] = None
            account["policyRevision"] += 1
            account["ownerChallenge"] = {"peerId": peer, "hash": hashlib.sha256(challenge.encode()).hexdigest(), "expiresAt": expires}
            data[provider] = account
            self._write(data)
        self._refresh()
        return {"challenge": challenge, "expiresAt": expires}

    def quarantine(self, provider):
        with self.lock:
            data = self._read()
            account = data.get(provider, self._default(provider))
            account["quarantined"] = True
            account["policyRevision"] += 1
            data[provider] = account
            self._write(data)
        self._refresh()

    def connect(self, provider, *, transport=None):
        from .coordinator import runtime
        with self.lock:
            if self._qq_logging_out:
                raise SocialError("QQ logout is in progress; log in again before enabling chat")
            data = self._read()
            original = copy.deepcopy(data.get(provider, self._default(provider)))
            if original.get("quarantined"):
                raise SocialError("Reconcile pending operations before resuming this account")
        if transport not in {None, "managed"}:
            raise SocialError("Unsupported QQ transport")
        account = copy.deepcopy(original)
        # No account lock is held while the RPC reader may admit messages.
        native = self.managed_qq_runtime()
        if not native["connected"] or not native.get("actualSelfId"):
            raise SocialError("Log in to the managed QQ account before enabling chat")
        if account["expectedSelfId"] and native["actualSelfId"] != account["expectedSelfId"]:
            raise SocialError("The logged-in QQ account does not match the bound account")
        if not account["expectedSelfId"]:
            account["expectedSelfId"] = native["actualSelfId"]
            account["ownerPeerId"] = None
            account.pop("ownerChallenge", None)
        if runtime.started:
            for row in runtime._unresolved_commands():
                try:
                    payload = json.loads(row["payload"])
                    params = payload.get("params", payload)
                    blocked = params.get("accountId") == account["accountId"]
                except (ValueError, TypeError, AttributeError):
                    blocked = True
                if blocked:
                    raise SocialError("Reconcile this account's pending operation before changing its connection")
        with self.lock:
            if self._qq_logging_out:
                raise SocialError("QQ logout is in progress; log in again before enabling chat")
            data = self._read()
            current = data.get(provider, self._default(provider))
            if current != original:
                raise SocialError("QQ settings changed while verifying the account; try connecting again")
            account.update({"transport": "managed", "enabled": True, "policyRevision": int(original["policyRevision"]) + 1})
            data[provider] = account
            self._write(data)
        try:
            self._refresh()
            result = self.get(provider)
            if (result["status"] == "connected" and result.get("actualSelfId") == account["expectedSelfId"]
                and result["policyRevision"] == account["policyRevision"] and result["transport"] == "managed"):
                return result
        except Exception:
            pass
        # Authentication and transport health are distinct. Preserve the bound
        # account and policy, but never leave a failed business connection enabled.
        with self.lock:
            data = self._read()
            current = data.get(provider, self._default(provider))
            if current["policyRevision"] == account["policyRevision"]:
                current["enabled"] = False
                current["policyRevision"] += 1
                data[provider] = current
                self._write(data)
        try:
            self._refresh()
        except Exception:
            pass
        raise SocialError("Managed QQ chat connection could not be verified; it remains disabled")

    def disconnect(self, provider):
        return self.put(provider, {"enabled": False})

    def resume(self, provider):
        """Explicit human action; a closed unknown command is never retried."""
        from .coordinator import runtime
        with self.lock:
            data = self._read()
            account = data.get(provider, self._default(provider))
            if not account.get("quarantined"):
                raise SocialError("This account is not awaiting explicit resumption")
            for row in runtime._unresolved_commands() if runtime.started else []:
                payload = json.loads(row["payload"])
                params = payload.get("params", payload)
                if params.get("accountId") == account["accountId"]:
                    raise SocialError("Reconcile this account's pending operation first")
            account["quarantined"] = False
            account["policyRevision"] += 1
            data[provider] = account
            self._write(data)
        self._refresh()
        result = self.get(provider)
        if result["status"] not in {"connected", "ready", "online"} or result.get("actualSelfId") != account["expectedSelfId"]:
            self.quarantine(provider)
            raise SocialError("Verify the account connection before resuming new messages")
        return self.get(provider)

    def records(self, provider):
        account = self.get(provider)
        if not db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='outbox'"):
            return {"records": []}
        records = []
        for row in db.query("SELECT * FROM outbox ORDER BY at DESC LIMIT 500"):
            try:
                payload = json.loads(row["payload"])
                params = payload.get("params", payload)
                if params.get("accountId") != account["accountId"] or params.get("pluginId") != account["id"]:
                    continue
                receipt = json.loads(row["receipt"] or "{}")
                records.append({"commandId": row["command_id"], "status": row["status"],
                    "peerId": params.get("peerId"), "createdAt": row["at"],
                    "executorQuiescent": account.get("executorQuiescent") is True,
                    "evidence": receipt.get("evidence") or receipt.get("deliveryEvidence")})
            except (ValueError, AttributeError):
                continue
        return {"records": records[:100]}


social = SocialAccounts()
