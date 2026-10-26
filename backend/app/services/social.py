"""Reviewed personal-account channels: private configuration and final policy gates.

The account file and secret references live outside the life archive. Transport
events are trusted only after host authentication; platform identity, recipient,
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
from urllib.parse import urlsplit

from ..core import db, state
from ..core.credentials import credentials, CredentialError


class SocialError(ValueError):
    pass


PROVIDERS = ("qq", "wechat")
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
                "accountId": provider + "-main", "expectedSelfId": "", "endpoint": "",
                "enabled": False, "permissions": dict(PERMISSIONS), "allowlistEnabled": False,
                "allowlist": [], "ownerPeerId": None, "policyRevision": 0, "quarantined": False}

    def _account(self, provider):
        return self._read().get(provider, self._default(provider))

    def get(self, provider):
        with self.lock:
            account = copy.deepcopy(self._account(provider))
        value = {key: copy.deepcopy(account.get(key)) for key in self._default(provider)}
        value["hasCredential"] = bool(account.get("credentialRef"))
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
                "providers": [{"id": p, "name": "QQ" if p == "qq" else "微信",
                               "auth": "personal_bridge", "oauthMessaging": False,
                               "capabilities": dict(CAPABILITIES)} for p in PROVIDERS]}

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
        allowed = {"enabled", "accountId", "expectedSelfId", "endpoint", "token", "permissions", "allowlistEnabled", "allowlist"}
        if set(values) - allowed:
            raise SocialError("Unknown account field; owner identity requires a verified challenge")
        with self.lock:
            data = self._read()
            old = data.get(provider, self._default(provider))
            account = copy.deepcopy(old)
            for flag in ("enabled", "allowlistEnabled"):
                if flag in values:
                    if not isinstance(values[flag], bool):
                        raise SocialError("Permission switches must be boolean")
                    account[flag] = values[flag]
            for key in ("accountId", "expectedSelfId"):
                if key in values:
                    account[key] = _identifier(values[key], key) if values[key] else ""
            if "endpoint" in values:
                endpoint = values["endpoint"]
                if not isinstance(endpoint, str) or len(endpoint) > 2048:
                    raise SocialError("Invalid connection address")
                try:
                    parsed = urlsplit(endpoint)
                    schemes = {"ws", "wss"} if provider == "qq" else {"http", "https"}
                    valid = not endpoint or parsed.scheme in schemes and bool(parsed.hostname) and not any((parsed.username, parsed.password, parsed.query, parsed.fragment))
                except ValueError:
                    valid = False
                if not valid:
                    raise SocialError("Use a channel address without credentials, query or fragment")
                account["endpoint"] = endpoint.strip()
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
            if account["enabled"] and not all(account[k] for k in ("accountId", "expectedSelfId", "endpoint")):
                raise SocialError("Configure the account identity and connection address first")
            if any(p != provider and row.get("accountId") == account["accountId"] for p, row in data.items()):
                raise SocialError("Each channel account needs a distinct identity")
            rebound = any(account[k] != old[k] for k in ("accountId", "expectedSelfId", "endpoint"))
            if rebound:
                account["ownerPeerId"] = None
                account.pop("ownerChallenge", None)
            if account["accountId"] != old["accountId"]:
                account.pop("credentialRef", None)
            token = values.get("token")
            if token is not None:
                if not isinstance(token, str) or len(token) > 4096 or any(ord(c) < 32 for c in token):
                    raise SocialError("Invalid connection credential")
                if token:
                    account["credentialRef"] = credentials.put(provider=provider, account_key=account["accountId"],
                        plugin_id=account["id"], secret={"token": token}, declared_scopes=["connect"], granted_scopes=["connect"])
                elif not old.get("credentialRef"):
                    account.pop("credentialRef", None)
            account["policyRevision"] = int(old["policyRevision"]) + 1
            data[provider] = account
            self._write(data)
            old_ref = old.get("credentialRef")
            if old_ref and old_ref != account.get("credentialRef"):
                try:
                    credentials.revoke(old_ref)
                except CredentialError:
                    pass
        self._refresh()
        return self.get(provider)

    def host_configs(self):
        with self.lock:
            result = []
            for provider, row in self._read().items():
                if provider not in PROVIDERS or not row.get("enabled") or row.get("quarantined"):
                    continue
                secret = {}
                if row.get("credentialRef"):
                    try:
                        secret = credentials.resolve(row["credentialRef"], plugin_id=row["id"],
                            required_scopes=["connect"], activity_scopes=["connect"])
                        if credentials.metadata(row["credentialRef"])["accountKey"] != row["accountId"]:
                            continue
                    except CredentialError:
                        continue
                result.append({"id": row["id"], "type": provider, "enabled": True,
                    "accountId": row["accountId"], "expectedSelfId": row["expectedSelfId"],
                    "endpoint": row["endpoint"], "credential": secret, "permissions": row["permissions"],
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
            account = next((row for row in self._read().values() if row.get("accountId") == account_id), None)
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

    def connect(self, provider):
        with self.lock:
            data = self._read()
            account = data.get(provider, self._default(provider))
            if account.get("quarantined"):
                raise SocialError("Reconcile pending operations before resuming this account")
        return self.put(provider, {"enabled": True})

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
