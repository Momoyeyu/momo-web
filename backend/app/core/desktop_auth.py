"""Desktop capability authentication. Browser development remains opt-in by entrypoint."""

import asyncio
import hmac
import os

ORIGINS = {"tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"}


def token():
    return os.environ.get("MOMO_DESKTOP_TOKEN", "")


def valid(value):
    return (
        isinstance(value, str) and bool(token()) and hmac.compare_digest(value, token())
    )


def allowed_origins():
    origin = os.environ.get("MOMO_WEB_ORIGIN", "")
    return ORIGINS | ({origin} if origin.startswith("http://127.0.0.1:") else set())


class DesktopAuth:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if not token() or scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        origin = headers.get(b"origin", b"").decode()
        allowed = not origin or origin in allowed_origins()
        if scope["type"] == "websocket":
            if not allowed:
                await send({"type": "websocket.close", "code": 1008})
                return
            # Only the loopback development proxy possesses this capability.
            if os.environ.get("MOMO_WEB_ORIGIN") and valid(
                headers.get(b"x-momo-token", b"").decode()
            ):
                return await self.app(scope, receive, send)
            # Consume the connect and authentication frame before business code.
            await receive()
            await send({"type": "websocket.accept"})
            try:
                import json

                msg = await asyncio.wait_for(receive(), timeout=5)
                auth = json.loads(msg.get("text", ""))
                authenticated = auth.get("type") == "authenticate" and valid(
                    auth.get("token")
                )
            except (ValueError, AttributeError, asyncio.TimeoutError):
                authenticated = False
            if not authenticated:
                await send({"type": "websocket.close", "code": 1008})
                return
            connected = False

            async def business_receive():
                nonlocal connected
                if not connected:
                    connected = True
                    return {"type": "websocket.connect"}
                return await receive()

            async def business_send(msg):
                if msg["type"] != "websocket.accept":
                    await send(msg)

            return await self.app(scope, business_receive, business_send)
        credential = headers.get(b"x-momo-token", b"").decode()
        if not credential:
            credential = (
                headers.get(b"authorization", b"").decode().removeprefix("Bearer ")
            )
        # Let CORS process only trusted preflights without a bearer capability.
        if not allowed or (scope["method"] != "OPTIONS" and not valid(credential)):
            response_headers = [(b"content-type", b"application/json")]
            if origin in allowed_origins():
                # The trusted WebView must be able to observe a capability denial.
                response_headers.extend(
                    [
                        (b"access-control-allow-origin", origin.encode()),
                        (b"vary", b"Origin"),
                    ]
                )
            await send(
                {
                    "type": "http.response.start",
                    "status": 403,
                    "headers": response_headers,
                }
            )
            await send(
                {
                    "type": "http.response.body",
                    "body": b'{"detail":"Desktop authentication required"}',
                }
            )
            return
        await self.app(scope, receive, send)
