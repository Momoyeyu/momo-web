"""Boot restores an already enabled account without opening another brain or QQ."""
import copy
import threading
import time

import pytest

from app.services import coordinator
from app.services.coordinator import Coordinator, CoordinationError
from app.services.social import SocialAccounts


ATTEMPT = "076a3a21-f6a1-4fd8-8377-1b1b93479434"
OTHER_ATTEMPT = "176a3a21-f6a1-4fd8-8377-1b1b93479434"


def native_status(status="idle", *, attempt=None, identity=None, revision=0):
    running = status in {"preparing", "connecting", "verifying", "qr_pending", "connected"}
    return {"provider": "qq", "status": status, "running": running,
            "connected": status == "connected", "actualSelfId": identity,
            "attemptId": attempt, "loginRevision": revision, "error": None, "executorQuiescent": not running,
            "qr": None}


class CapturedHost:
    def __init__(self):
        self.host_instance = "host-one"
        self.closed = threading.Event()
        self.control = threading.RLock()
        self.calls = []
        self.native = native_status()
        self.begin_started = threading.Event()
        self.begin_release = threading.Event()
        self.begin_release.set()
        self.begin_result = None

    def request(self, method, params=None, timeout=None):
        self.calls.append((method, copy.deepcopy(params), timeout))
        if method == "revoke":
            return {"stopped": True}
        if method == "grant":
            return {"paused": False}
        if method == "qq.runtime.status":
            return copy.deepcopy(self.native)
        if method == "qq.runtime.restore":
            self.begin_started.set()
            assert self.begin_release.wait(2), "test did not release the cached login"
            if self.begin_result is not None:
                return copy.deepcopy(self.begin_result)
            self.native = native_status("connected", attempt=ATTEMPT, identity="10001", revision=1)
            return copy.deepcopy(self.native)
        if method == "plugins.configure":
            return {"plugins": []}
        raise AssertionError(method)

    def close(self):
        self.closed.set()
        self.begin_release.set()


@pytest.fixture
def boot_core(monkeypatch):
    store = SocialAccounts()
    store.put("qq", {"expectedSelfId": "10001", "permissions": {"reply": False},
                     "allowlistEnabled": True, "allowlist": []})
    data = store._read()
    data["qq"].update(enabled=True, ownerPeerId="20002")
    store._write(data)
    core = Coordinator()
    core.schema()
    core.started = True
    core.host = CapturedHost()
    monkeypatch.setattr(coordinator, "QQ_RESTORE_SECONDS", .25, raising=False)
    monkeypatch.setattr(coordinator, "QQ_RESTORE_POLL_SECONDS", .005, raising=False)
    yield core, store
    core.close()


def joined(core):
    thread = getattr(core, "qq_restore_thread", None)
    if thread:
        thread.join(1)
        assert not thread.is_alive(), "owned restoration must be bounded"


def configured(host):
    return [params for method, params, _ in host.calls if method == "plugins.configure"]


def test_explicit_boot_restores_enabled_pinned_account_without_blocking_or_policy_writes(boot_core):
    core, store = boot_core
    host = core.host
    host.begin_release.clear()
    before = store._path().read_bytes()
    core.phone_paused = True
    started = time.monotonic()
    lease = core.enter("player")
    assert time.monotonic() - started < .2
    assert lease["activation"] == "active"
    assert host.begin_started.wait(.3), "Boot must start the cached account restoration"
    assert configured(host) == []
    restore_call = next(params for method, params, _ in host.calls if method == "qq.runtime.restore")
    assert restore_call == {"ownerAction": True, "expectedSelfId": "10001",
                            "expectedAttemptId": None, "expectedLoginRevision": 0}
    host.begin_release.set()
    joined(core)
    assert len(configured(host)) == 1
    account = configured(host)[0]["plugins"][0]
    assert account["expectedSelfId"] == "10001"
    assert account["permissions"]["reply"] is False
    assert account["allowlistEnabled"] is True and account["allowlist"] == []
    assert store._path().read_bytes() == before
    assert core.phone_paused is True


@pytest.mark.parametrize("change", [{"enabled": False}, {"expectedSelfId": ""}, {"quarantined": True}])
def test_boot_never_authenticates_ineligible_accounts(boot_core, change):
    core, store = boot_core
    data = store._read()
    data["qq"].update(change)
    store._write(data)
    core.enter("player")
    joined(core)
    assert not any(method.startswith("qq.runtime") for method, _, _ in core.host.calls)


def test_matching_page_restoration_does_not_start_background_qq_login(boot_core):
    core, _ = boot_core
    core.mode = "meeting"
    core.owner = {"clientId": "player", "leaseId": "old-lease", "expiresAt": time.monotonic() + 10}
    core.enter("player", "old-lease", restore=True)
    joined(core)
    assert not any(method.startswith("qq.runtime") for method, _, _ in core.host.calls)


@pytest.mark.parametrize("change", [{"enabled": False}, {"expectedSelfId": "99999"}, {"quarantined": True}])
def test_late_cached_login_cannot_reenable_a_changed_account(boot_core, change):
    core, store = boot_core
    host = core.host
    host.begin_release.clear()
    core.enter("player")
    assert host.begin_started.wait(.3)
    if "quarantined" in change:
        store.quarantine("qq")
    else:
        store.put("qq", change)
    host.begin_release.set()
    joined(core)
    assert configured(host) == []
    assert store.get("qq")["enabled"] is change.get("enabled", True)


def test_policy_edits_during_authentication_bind_only_the_latest_restrictive_grants(boot_core):
    core, store = boot_core
    host = core.host
    host.begin_release.clear()
    core.enter("player")
    assert host.begin_started.wait(.3)
    store.put("qq", {"permissions": {"receive": False, "reply": False},
                     "allowlistEnabled": True, "allowlist": []})
    before = store._path().read_bytes()
    host.begin_release.set()
    joined(core)
    account = configured(host)[0]["plugins"][0]
    assert account["permissions"]["receive"] is False and account["permissions"]["reply"] is False
    assert account["allowlistEnabled"] is True and account["allowlist"] == []
    assert store._path().read_bytes() == before


def test_replacement_host_and_closed_core_cannot_receive_stale_restore_completion(boot_core):
    core, _ = boot_core
    old = core.host
    old.begin_release.clear()
    core.enter("player")
    assert old.begin_started.wait(.3)
    replacement = CapturedHost()
    core.host = replacement
    old.begin_release.set()
    joined(core)
    assert configured(old) == [] and replacement.calls == []


@pytest.mark.parametrize("revoke", ["closed", "core", "hostInstance"])
def test_lifetime_changes_withdraw_a_blocked_restoration(boot_core, revoke):
    core, _ = boot_core
    host = core.host
    host.begin_release.clear()
    core.enter("player")
    assert host.begin_started.wait(.3)
    if revoke == "closed":
        core.closed.set()
    elif revoke == "core":
        core.core_id = "another-core"
    else:
        host.host_instance = "another-host-generation"
    host.begin_release.set()
    joined(core)
    assert configured(host) == []


def test_focus_and_phone_pause_changed_during_restore_are_preserved(boot_core):
    core, _ = boot_core
    host = core.host
    host.begin_release.clear()
    lease = core.enter("player")
    assert host.begin_started.wait(.3)
    core.control("player", lease["leaseId"], "focus", "focus_on")
    core.control("player", lease["leaseId"], "pause", "stop")
    host.begin_release.set()
    joined(core)
    assert core.focus is True and core.phone_paused is True
    assert core.snapshot()["activation"] == "active"


def test_new_boot_after_policy_change_is_coalesced_while_old_authentication_waits(boot_core):
    core, store = boot_core
    host = core.host
    host.begin_release.clear()
    first = core.enter("player")
    assert host.begin_started.wait(.3)
    store.put("qq", {"permissions": {"reply": True}})
    core.leave("player", first["leaseId"])
    core.enter("player")
    assert len([method for method, _, _ in host.calls if method == "qq.runtime.restore"]) == 1
    host.begin_release.set()
    joined(core)
    assert configured(host)
    assert all(item["plugins"][0]["permissions"]["reply"] is True for item in configured(host))
    assert len([method for method, _, _ in host.calls if method == "qq.runtime.restore"]) == 1


def test_new_boot_on_replacement_host_is_not_lost_behind_the_old_restore_task(boot_core):
    core, _ = boot_core
    old = core.host
    old.begin_release.clear()
    first = core.enter("player")
    assert old.begin_started.wait(.3)
    core.leave("player", first["leaseId"])
    replacement = CapturedHost()
    core.host = replacement
    core.enter("player")
    old.begin_release.set()
    joined(core)
    assert configured(old) == []
    assert len(configured(replacement)) == 1
    assert len([method for method, _, _ in replacement.calls if method == "qq.runtime.restore"]) == 1


def test_old_worker_cannot_consume_or_clear_a_new_lifetimes_pending_boot(boot_core, monkeypatch):
    core, _ = boot_core
    old_host = core.host
    old_host.begin_release.clear()
    first = core.enter("player")
    assert old_host.begin_started.wait(.3)
    old_thread = core.qq_restore_thread
    core.leave("player", first["leaseId"])
    core.closed.set()
    core.closed = threading.Event()
    core.core_id = "new-lifetime"
    core.host = CapturedHost()
    original_start = threading.Thread.start
    staged = []
    def stage(thread):
        if thread.name == "momo-qq-restore":
            staged.append(thread)
        else:
            original_start(thread)
    monkeypatch.setattr(threading.Thread, "start", stage)
    try:
        core.enter("player")
        fresh_thread = core.qq_restore_thread
        assert fresh_thread is not old_thread
        fresh_pending = core.qq_restore_pending
        old_host.begin_release.set()
        old_thread.join(1)
        assert not old_thread.is_alive()
        assert core.qq_restore_thread is fresh_thread
        assert core.qq_restore_pending is fresh_pending
        original_start(fresh_thread)
        joined(core)
        assert len(configured(core.host)) == 1
        assert configured(old_host) == []
    finally:
        old_host.begin_release.set()
        old_thread.join(1)
        for thread in staged:
            if thread.ident is None:
                original_start(thread)
            thread.join(1)


@pytest.mark.parametrize("result", [native_status("qr_pending", attempt=ATTEMPT, revision=1), native_status("cancelled", revision=1), native_status("connected", attempt=ATTEMPT, identity="99999", revision=1)])
def test_qr_terminal_or_mismatched_identity_never_enables_chat(boot_core, result):
    core, _ = boot_core
    core.host.begin_result = result
    core.host.native = copy.deepcopy(result)
    # Begin from an idle engine; the result is not an initial owner login.
    initial = core.host.request
    first = True
    def request(method, params=None, timeout=None):
        nonlocal first
        if method == "qq.runtime.status" and first:
            first = False
            core.host.calls.append((method, copy.deepcopy(params), timeout))
            return native_status()
        return initial(method, params, timeout)
    core.host.request = request
    core.enter("player")
    joined(core)
    assert configured(core.host) == []
    assert len([method for method, _, _ in core.host.calls if method == "qq.runtime.restore"]) == 1


def test_owner_attempt_replacement_fences_polling_and_business_refresh(boot_core):
    core, _ = boot_core
    core.host.begin_result = native_status("verifying", attempt=ATTEMPT, revision=1)
    core.host.native = native_status("connected", attempt=OTHER_ATTEMPT, identity="10001", revision=2)
    request = core.host.request
    first = True
    def initial_idle(method, params=None, timeout=None):
        nonlocal first
        if method == "qq.runtime.status" and first:
            first = False
            core.host.calls.append((method, copy.deepcopy(params), timeout))
            return native_status()
        return request(method, params, timeout)
    core.host.request = initial_idle
    core.enter("player")
    joined(core)
    assert configured(core.host) == []


def test_an_owner_login_in_progress_is_not_replaced_by_boot(boot_core):
    core, _ = boot_core
    core.host.native = native_status("verifying", attempt=OTHER_ATTEMPT)
    core.enter("player")
    joined(core)
    assert not any(method == "qq.runtime.restore" for method, _, _ in core.host.calls)
    assert configured(core.host) == []


def test_one_pending_restoration_and_explicit_later_boot_can_restore_again(boot_core):
    core, _ = boot_core
    host = core.host
    host.begin_release.clear()
    first = core.enter("player")
    assert host.begin_started.wait(.3)
    second = core.enter("player", first["leaseId"])
    assert len([method for method, _, _ in host.calls if method == "qq.runtime.restore"]) == 1
    host.begin_release.set()
    joined(core)
    core.leave("player", second["leaseId"])
    host.native = native_status("stopped")
    core.enter("player")
    joined(core)
    assert len([method for method, _, _ in host.calls if method == "qq.runtime.restore"]) == 2


def test_a_stalled_restore_finishes_without_touching_grants_or_replaying_a_begin(boot_core):
    core, _ = boot_core
    host = core.host
    host.begin_result = native_status("verifying", attempt=ATTEMPT, revision=1)
    host.native = copy.deepcopy(host.begin_result)
    request = host.request
    first = True
    def initial_idle(method, params=None, timeout=None):
        nonlocal first
        if method == "qq.runtime.status" and first:
            first = False
            host.calls.append((method, copy.deepcopy(params), timeout))
            return native_status()
        return request(method, params, timeout)
    host.request = initial_idle
    core.enter("player")
    joined(core)
    assert configured(host) == []
    assert len([method for method, _, _ in host.calls if method == "qq.runtime.restore"]) == 1


def test_failed_boot_with_unknown_delivery_never_starts_account_restoration(boot_core):
    core, _ = boot_core
    core._unresolved_commands = lambda: [{"command_id": "unresolved"}]
    with pytest.raises(CoordinationError, match="unknown"):
        core.enter("player")
    assert not any(method.startswith("qq.runtime") for method, _, _ in core.host.calls)
