"""Private, versioned pipe to the single Cordis host. No listening management port."""

from __future__ import annotations

import concurrent.futures
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import threading
import uuid


class HostError(RuntimeError):
    pass


def managed_qq_runtime_config():
    """Read a fixed private startup binding, never an account request or model tool."""
    configured = os.environ.get("MOMO_QQ_RUNTIME_CONFIG")
    if not configured:
        return None
    try:
        path = Path(configured)
        if not path.is_absolute() or str(path) != configured or path.resolve() != path:
            raise ValueError()
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as source:
            before = os.fstat(source.fileno())
            if (
                not stat.S_ISREG(before.st_mode)
                or before.st_uid != os.getuid()
                or before.st_nlink != 1
                or before.st_mode & 0o077
                or before.st_size > 16 * 1024
            ):
                raise ValueError()
            content = source.read(16 * 1024 + 1)
            after = os.fstat(source.fileno())
        current = path.lstat()
        snapshot = lambda value: (
            value.st_dev, value.st_ino, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns, value.st_mode,
        )
        if snapshot(before) != snapshot(after) or snapshot(after) != snapshot(current):
            raise ValueError()
        value = json.loads(content)
        fields = {
            "privateRoot", "resourceRoot", "manifestPath",
            "dataRoot", "controlRoot", "canaryPath",
        }
        if not isinstance(value, dict) or set(value) != fields:
            raise ValueError()
        for entry in value.values():
            if (
                not isinstance(entry, str) or not entry or len(entry) > 4096
                or any(ord(character) < 32 or ord(character) == 127 for character in entry)
                or not Path(entry).is_absolute() or str(Path(entry)) != entry
            ):
                raise ValueError()
        private = Path(value["privateRoot"])
        if path == private or not path.is_relative_to(private):
            raise ValueError()
        for field in fields - {"privateRoot"}:
            child = Path(value[field])
            if child == private or not child.is_relative_to(private):
                raise ValueError()
        return value
    except (OSError, ValueError, TypeError, AttributeError):
        raise HostError("Managed QQ startup configuration is invalid") from None


class PluginHost:
    def __init__(self, core_instance: str, on_event, epoch):
        self.core_instance = core_instance
        self.on_event = on_event
        self.epoch = epoch
        self.token = secrets.token_urlsafe(32)
        self.host_instance = ""
        self.process = None
        self.pending = {}
        self.lock = threading.Lock()
        self.closed = threading.Event()
        self.control = threading.RLock()

    def start(self):
        qq_runtime = managed_qq_runtime_config()
        root = Path(__file__).resolve().parents[3]
        resources = Path(
            os.environ.get("MOMO_RESOURCES_DIR", root / "resources/models")
        ).parent
        entry = Path(
            os.environ.get("MOMO_PLUGIN_HOST", resources / "plugin-host/src/index.mjs")
        )
        if not entry.exists():
            entry = root / "plugin-host/src/index.mjs"
        node = os.environ.get("MOMO_NODE") or str(
            resources / ("node/node.exe" if os.name == "nt" else "node/bin/node")
        )
        if not Path(node).is_file():
            if getattr(__import__("sys"), "frozen", False):
                raise HostError("Bundled plugin runtime is missing")
            node = "node"
        if not entry.is_file():
            raise HostError(
                "Plugin host is missing; install locked plugin-host dependencies"
            )
        self.process = subprocess.Popen(
            [node, str(entry)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        threading.Thread(
            target=self._reader, name="momo-host-pipe", daemon=True
        ).start()
        result = self.request(
            "hello",
            {
                "coreInstance": self.core_instance,
                "token": self.token,
                "heartbeatMs": 5000,
                **({"qqRuntime": qq_runtime} if qq_runtime is not None else {}),
            },
        )
        self.host_instance = result["hostInstance"]
        self.request("heartbeat", {"activityEpoch": self.epoch()})
        threading.Thread(
            target=self._heartbeat, name="momo-host-heartbeat", daemon=True
        ).start()

    def _reader(self):
        try:
            for line in self.process.stdout:
                packet = json.loads(line)
                if packet.get("v") != 1:
                    raise HostError("Plugin protocol version mismatch")
                if "event" in packet:
                    self.on_event(packet["event"], packet.get("data", {}))
                    continue
                with self.lock:
                    future = self.pending.pop(packet.get("id"), None)
                if future and not future.done():
                    if packet.get("ok"):
                        future.set_result(packet.get("result"))
                    else:
                        future.set_exception(
                            HostError(
                                str(packet.get("error", {}).get("code", "host_error"))
                            )
                        )
        except Exception:
            pass
        finally:
            with self.lock:
                pending, self.pending = self.pending, {}
            for future in pending.values():
                if not future.done():
                    future.set_exception(HostError("Plugin host disconnected"))
            if not self.closed.is_set():
                self.on_event("host.paused", {"reason": "disconnected"})

    def request(self, method, params=None, timeout=12):
        request_id = uuid.uuid4().hex
        future = concurrent.futures.Future()
        with self.lock:
            if (
                self.closed.is_set()
                or not self.process
                or self.process.poll() is not None
            ):
                raise HostError("Plugin host is unavailable")
            self.pending[request_id] = future
            try:
                self.process.stdin.write(
                    json.dumps(
                        {
                            "v": 1,
                            "id": request_id,
                            "token": self.token,
                            "method": method,
                            "params": params or {},
                        }
                    )
                    + "\n"
                )
                self.process.stdin.flush()
            except Exception as error:
                self.pending.pop(request_id, None)
                raise HostError("Plugin pipe failed") from error
        try:
            return future.result(timeout=timeout)
        except concurrent.futures.TimeoutError as error:
            with self.lock:
                self.pending.pop(request_id, None)
            raise HostError("Plugin host timed out") from error

    def _heartbeat(self):
        while not self.closed.wait(1):
            try:
                with self.control:
                    self.request(
                        "heartbeat", {"activityEpoch": self.epoch()}, timeout=2
                    )
            except HostError as error:
                if str(error) in {"EPOCH_MISMATCH", "STALE_EPOCH"}:
                    continue
                self.on_event("host.paused", {"reason": "heartbeat_failed"})
                return

    def permit(self, run_id):
        import time

        return {
            "coreInstance": self.core_instance,
            "hostInstance": self.host_instance,
            "activityEpoch": self.epoch(),
            "runId": run_id,
            "commandId": uuid.uuid4().hex,
            "expiresAt": int(time.time() * 1000) + 4000,
        }

    def close(self):
        if self.closed.is_set():
            return
        try:
            self.request("shutdown", timeout=3)
        except HostError:
            pass
        self.closed.set()
        if self.process:
            try:
                self.process.stdin.close()
                self.process.wait(timeout=3)
            except (subprocess.TimeoutExpired, OSError):
                self.process.kill()
                self.process.wait(timeout=2)
