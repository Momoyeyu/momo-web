"""Prevent data replacement while a turn, upload, or live ASR session owns state."""

import threading
import asyncio


class DataMaintenance:
    def __init__(self, app, barrier_factory=None):
        self.app = app
        self.barrier_factory = barrier_factory
        self._lock = threading.Lock()
        self._active = 0
        self._maintenance = False

    async def __call__(self, scope, receive, send):
        kind = scope["type"]
        if kind not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        maintenance = scope.get("path") in {
            "/api/data/export",
            "/api/data/import",
            "/api/data/validate",
        }
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
            barrier = (
                self.barrier_factory()
                if self.barrier_factory and scope.get("path") == "/api/data/import"
                else None
            )
            if barrier:
                try:
                    await asyncio.to_thread(barrier.__enter__)
                except Exception:
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
                            "body": b'{"detail":"Could not safely pause runtime for restore"}',
                        }
                    )
                    return
            try:
                await self.app(scope, receive, send)
            finally:
                if barrier:
                    await asyncio.to_thread(barrier.__exit__, None, None, None)
        finally:
            with self._lock:
                if maintenance:
                    self._maintenance = False
                else:
                    self._active -= 1
