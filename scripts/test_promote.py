import importlib.util
from pathlib import Path
import subprocess
import pytest

spec = importlib.util.spec_from_file_location(
    "promote", Path(__file__).with_name("promote.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args])


def commit(root):
    git(root, "add", "-A")
    # Synthetic throwaway repositories, not the project's author history.
    git(
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "test: fixture",
    )


@pytest.fixture
def pair(tmp_path):
    source = tmp_path / "source"
    target = tmp_path / "target"
    for root in (source, target):
        root.mkdir()
        git(root, "init", "-q")
    (source / "frontend").mkdir()
    (source / "frontend/a.ts").write_text("new")
    (source / "backend").mkdir()
    (source / "backend/b.py").write_text("new")
    (source / ".gitignore").write_text(".env\nbackend/data/\n")
    (source / ".env").write_text("PRIVATE")
    (target / "app/frontend").mkdir(parents=True)
    (target / "app/frontend/a.ts").write_text("old")
    (target / "app/src-tauri").mkdir()
    (target / "app/src-tauri/keep.rs").write_text("native")
    commit(source)
    commit(target)
    return source, target


def test_dry_run_owns_only_shared_tracked_sources(pair):
    source, target = pair
    report = module.promote(source, target, "HEAD", bootstrap=True)
    assert report["changed"] == ["app/backend/b.py", "app/frontend/a.ts"]
    assert (target / "app/frontend/a.ts").read_text() == "old"
    assert not (target / "app/.env").exists()


def test_second_promotion_has_no_diff_and_drift_is_rejected(pair):
    source, target = pair
    module.promote(source, target, "HEAD", bootstrap=True, apply=True)
    commit(target)
    module.promote(source, target, "HEAD", apply=True)
    assert not git(target, "status", "--porcelain").strip()
    (target / "app/frontend/a.ts").write_text("unreviewed")
    with pytest.raises(ValueError, match="drift"):
        module.promote(source, target, "HEAD", apply=True)
    assert (target / "app/frontend/a.ts").read_text() == "unreviewed"


def test_deletes_only_previous_owned_file_and_deletion_is_repeatable(pair):
    source, target = pair
    module.promote(source, target, "HEAD", bootstrap=True, apply=True)
    commit(target)
    (source / "backend/b.py").unlink()
    commit(source)
    result = module.promote(source, target, "HEAD", apply=True)
    commit(target)
    assert result["deleted"] == ["app/backend/b.py"]
    assert (target / "app/src-tauri/keep.rs").read_text() == "native"
    module.promote(source, target, "HEAD", apply=True)
    assert not git(target, "status", "--porcelain").strip()


def test_bootstrap_refuses_untracked_target_and_dirty_source(pair):
    source, target = pair
    (target / "app/backend").mkdir()
    (target / "app/backend/b.py").write_text("private")
    with pytest.raises(ValueError, match="Untracked target"):
        module.promote(source, target, "HEAD", bootstrap=True)
    (source / "frontend/a.ts").write_text("not committed")
    with pytest.raises(ValueError, match="reviewed source"):
        module.promote(source, target, "HEAD", bootstrap=True)


def test_bootstrap_retires_deleted_tracked_shared_files_and_rejects_drift(pair):
    source, target = pair
    retired = target / "app/frontend/Checkpoint.tsx"
    retired.write_text("retired")
    commit(target)
    retired.write_text("user edit")
    with pytest.raises(ValueError, match="drift"):
        module.promote(source, target, "HEAD", bootstrap=True)
    retired.write_text("retired")
    report = module.promote(source, target, "HEAD", bootstrap=True, apply=True)
    assert report["deleted"] == ["app/frontend/Checkpoint.tsx"]
    assert not retired.exists()
    assert (target / "app/src-tauri/keep.rs").exists()


def test_parent_symlink_cannot_redirect_writes_outside_target(pair, tmp_path):
    source, target = pair
    outside = tmp_path / "outside"
    outside.mkdir()
    (target / "app/backend").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="symlink"):
        module.promote(source, target, "HEAD", bootstrap=True, apply=True)
    assert not list(outside.iterdir())
