"""Prevent data replacement while a turn, upload, or live ASR session owns state."""

import threading


class DataMaintenance:
    def __init__(self, app):
        self.app = app
        self._lock = threading.Lock()
        self._active = 0
        self._maintenance = False

    async def __call__(self, scope, receive, send):
        kind = scope["type"]
        if kind not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        maintenance = (scope.get("method"), scope.get("path")) in {
            ("GET", "/api/data/export"),
            ("POST", "/api/data/import"),
            ("POST", "/api/data/validate"),
        }
        # Lease renewal changes only coordinator memory. Treating it as a data
        # writer makes chat-page transfers race their background heartbeat.
        if kind == "http" and scope.get("method") == "POST" and scope.get("path") == "/api/meeting/heartbeat":
            return await self.app(scope, receive, send)
        mutation = kind == "websocket" or scope.get("method") not in (
            "GET",
            "HEAD",
            "OPTIONS",
        )
        if not maintenance and not mutation:
            return await self.app(scope, receive, send)
        with self._lock:
            conflict = self._maintenance or (maintenance and self._active > 0)
            if not conflict:
                if maintenance:
                    self._maintenance = True
                else:
                    self._active += 1
        if conflict:
            if kind == "websocket":
                await send({"type": "websocket.close", "code": 1013})
            else:
                await send(
                    {
                        "type": "http.response.start",
                        "status": 409,
                        "headers": [(b"content-type", b"application/json")],
                    }
                )
                await send(
                    {
                        "type": "http.response.body",
                        "body": b'{"detail":"Finish the active operation before transferring data"}',
                    }
                )
            return
        try:
            await self.app(scope, receive, send)
        finally:
            with self._lock:
                if maintenance:
                    self._maintenance = False
                else:
                    self._active -= 1
