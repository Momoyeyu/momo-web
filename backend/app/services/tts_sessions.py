"""Keep the selected voice warm for the desktop process or an active web meeting."""

from __future__ import annotations

import asyncio
import os
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Callable
from urllib.parse import urlsplit

import httpx

from ..core import desktop_auth
from . import tts
from .coordinator import runtime

_RENEW_SECONDS = 10
_CHECK_SECONDS = .5
_REQUEST_SECONDS = 2


@dataclass(frozen=True)
class Target:
    owner_id: str
    engine: str
    base_url: str
    authorization: str | None = field(repr=False)


def _target() -> Target | None:
    # The web dev proxy also uses a capability token, but has no desktop lifetime.
    native = desktop_auth.token() and not os.environ.get("MOMO_WEB_ORIGIN")
    owner_id = "desktop" if native else runtime.active_meeting_id()
    if owner_id is None:
        return None
    try:
        config = tts._cfg()
        base_url, headers = tts.endpoint(config)
        address = urlsplit(base_url)
        if (
            address.scheme not in ("http", "https")
            or not address.hostname
            or address.username is not None
            or address.query
            or address.fragment
            or not tts.ref_path(config)
        ):
            return None
    except (AttributeError, TypeError, ValueError, OSError):
        return None
    return Target(owner_id, tts.engine(config), base_url, headers.get("Authorization"))


async def _request(client: httpx.AsyncClient, method: str, target: Target, session_id: str) -> int | None:
    headers = {"Authorization": target.authorization} if target.authorization else {}
    try:
        async with asyncio.timeout(_REQUEST_SECONDS):
            async with client.stream(method, f"{target.base_url}/session/{session_id}", headers=headers) as response:
                return response.status_code
    except (httpx.HTTPError, httpx.InvalidURL, TimeoutError, ValueError):
        # A dropped client is cleaned up by the upstream session TTL.
        return None


class VoiceSessions:
    def __init__(self, selected: Callable[[], Target | None]):
        self._selected = selected
        self._notify: Callable[[], None] | None = None

    def wake(self) -> None:
        """Notify from a sync request handler without waiting on the upstream."""
        notify = self._notify
        if notify is not None:
            try:
                notify()
            except RuntimeError:
                # The request may have overlapped shutdown.
                pass

    @asynccontextmanager
    async def running(self, *, transport: httpx.AsyncBaseTransport | None = None):
        loop = asyncio.get_running_loop()
        wake = asyncio.Event()
        stopping = asyncio.Event()
        self._notify = lambda: loop.call_soon_threadsafe(wake.set)
        async with httpx.AsyncClient(trust_env=False, transport=transport) as client:
            task = asyncio.create_task(self._run(client, wake, stopping), name="momo-tts-sessions")
            try:
                yield
            finally:
                self._notify = None
                stopping.set()
                wake.set()
                await task

    async def _run(self, client: httpx.AsyncClient, wake: asyncio.Event, stopping: asyncio.Event) -> None:
        target = None
        session_id = ""
        attempted = False
        unsupported = False
        next_renewal = 0.0
        clock = asyncio.get_running_loop().time
        try:
            while not stopping.is_set():
                wake.clear()
                selected = await asyncio.to_thread(self._selected)
                if stopping.is_set():
                    break
                if selected != target:
                    if target is not None and attempted and not unsupported:
                        await _request(client, "DELETE", target, session_id)
                    target = selected
                    session_id = str(uuid.uuid4()) if target is not None else ""
                    attempted = unsupported = False
                    next_renewal = 0.0
                if target is not None and not unsupported and not stopping.is_set() and clock() >= next_renewal:
                    attempted = True
                    code = await _request(client, "PUT", target, session_id)
                    unsupported = code in (404, 405)
                    next_renewal = clock() + _RENEW_SECONDS
                if not stopping.is_set():
                    try:
                        await asyncio.wait_for(wake.wait(), timeout=_CHECK_SECONDS)
                    except TimeoutError:
                        pass
        finally:
            if target is not None and attempted and not unsupported:
                await _request(client, "DELETE", target, session_id)


sessions = VoiceSessions(_target)
