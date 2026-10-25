"""Restoring a profile must reconcile the live Cordis capability authority."""

from pathlib import Path
import shutil
import pytest
from app.core import mcp, state
from app.services import checkpoint, memory
from app.services import archive, extend, coordinator
from app.services.coordinator import Coordinator


@pytest.fixture
def restore_runtime(monkeypatch):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node is required for the restore integration test")
    core = Coordinator()
    facade = mcp.McpHub()
    monkeypatch.setattr(coordinator, "runtime", core)
    monkeypatch.setattr(mcp, "_coordinator", core)
    monkeypatch.setattr(mcp, "hub", facade)
    monkeypatch.setattr(extend, "hub", facade)
    core.start()
    try:
        yield core, facade, node
    finally:
        facade.close()
        core.close()


def test_restored_disabled_plugins_replace_the_live_enabled_catalog(restore_runtime):
    core, facade, node = restore_runtime
    disabled = state.load()
    disabled["settings"]["extensions"] = []
    state.write_state(disabled)
    saved = archive.export_data()
    extension = {
        "name": "echo",
        "enabled": True,
        "transport": "stdio",
        "command": node,
        "args": [
            str(
                Path(__file__).resolve().parents[2]
                / "plugin-host/test/fixtures/mcp-server.mjs"
            )
        ],
    }
    enabled = state.load()
    enabled["settings"]["extensions"] = [extension]
    state.write_state(enabled)
    assert extend.configure([extension])
    lease = core.enter("client-one")
    stale = facade.open([extension], set())
    assert stale.has("echo_echo")
    assert core.host.request("plugins.listTools")["tools"]
    with core.maintenance():
        archive.import_data(saved)
        assert core.host.request("plugins.listTools")["tools"] == []
    core.enter("client-two")
    assert state.load()["settings"]["extensions"] == []
    # Even a pre-restore turn snapshot cannot restore old capabilities.
    assert facade.open([extension], set()).decls == []
    assert "授权已失效" in stale.call("echo_echo", {})


def test_failed_restore_reconciliation_withdraws_all_local_capabilities(
    restore_runtime, monkeypatch
):
    core, facade, node = restore_runtime
    extension = {
        "name": "echo",
        "enabled": True,
        "transport": "stdio",
        "command": node,
        "args": [
            str(
                Path(__file__).resolve().parents[2]
                / "plugin-host/test/fixtures/mcp-server.mjs"
            )
        ],
    }
    cfg = state.load()
    cfg["settings"]["extensions"] = [extension]
    state.write_state(cfg)
    cfg["settings"]["llm"]["model"] = "from-backup"
    state.write_state(cfg)
    saved = archive.export_data()
    cfg["settings"]["llm"]["model"] = "current-profile"
    state.write_state(cfg)
    current_memory = memory.add_memory("Keep current profile on failed replacement")
    assert extend.configure([extension])
    core.enter("client-one")
    stale = facade.open([extension], set())
    assert stale.has("echo_echo")
    real_configure = extend.configure

    def fail_enabled(config):
        if config:
            return False
        return real_configure(config)

    monkeypatch.setattr(extend, "configure", fail_enabled)
    with pytest.raises(RuntimeError, match="capabilities"):
        with core.maintenance():
            stale_generation = checkpoint.generation()
            archive.import_data(saved)
    assert state.load()["settings"]["llm"]["model"] == "current-profile"
    assert memory.list_memories() == [current_memory]
    assert checkpoint.generation() > stale_generation
    assert core.mode == "paused"
    core.enter("client-two")
    assert facade.open([extension], set()).decls == []
    assert "授权已失效" in stale.call("echo_echo", {})
