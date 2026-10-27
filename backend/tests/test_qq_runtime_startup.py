"""Trusted process startup metadata is never an account/HTTP configuration."""
import json
import os
from pathlib import Path

import pytest

from app.core import plugin_host


def config_reader():
    reader = getattr(plugin_host, "managed_qq_runtime_config", None)
    assert callable(reader), "managed QQ trusted startup loader exists"
    return reader


def private_config(tmp_path):
    root = tmp_path.resolve()
    config = {"privateRoot": str(root), **{key: str(root / name) for key, name in {
        "resourceRoot": "resources", "manifestPath": "pins.json", "dataRoot": "session",
        "controlRoot": "control", "canaryPath": "canary.txt",
    }.items()}}
    path = root / "runtime-config.json"
    path.write_text(json.dumps(config)); path.chmod(0o600)
    return path, config


def test_trusted_runtime_binding_is_optional_and_does_not_scan_system_qq(monkeypatch):
    monkeypatch.delenv("MOMO_QQ_RUNTIME_CONFIG", raising=False)
    assert config_reader()() is None


def test_startup_loads_only_fixed_private_paths_not_account_credentials(tmp_path, monkeypatch):
    path, config = private_config(tmp_path)
    monkeypatch.setenv("MOMO_QQ_RUNTIME_CONFIG", str(path))
    assert config_reader()() == config
    value = {**config, "endpoint": "ws://untrusted", "token": "private-secret"}
    path.write_text(json.dumps(value))
    with pytest.raises(plugin_host.HostError, match="Managed QQ startup configuration is invalid"):
        config_reader()()


@pytest.mark.parametrize("kind", ["symlink", "public", "oversized", "relative", "outside"])
def test_untrusted_or_aliased_startup_file_is_rejected(tmp_path, monkeypatch, kind):
    path, config = private_config(tmp_path)
    if kind == "symlink":
        alias = path.with_name("alias.json"); alias.symlink_to(path); path = alias
    elif kind == "public":
        path.chmod(0o644)
    elif kind == "oversized":
        path.write_text("x" * (16 * 1024 + 1))
    elif kind == "relative":
        monkeypatch.setenv("MOMO_QQ_RUNTIME_CONFIG", "runtime-config.json")
    else:
        config["dataRoot"] = str(Path(config["privateRoot"]).parent / "not-qq")
        path.write_text(json.dumps(config))
    if kind != "relative": monkeypatch.setenv("MOMO_QQ_RUNTIME_CONFIG", str(path))
    with pytest.raises(plugin_host.HostError, match="Managed QQ startup configuration is invalid"):
        config_reader()()
