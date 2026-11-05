import subprocess
import sys
import pytest
from app.core.data_lock import DataDirectoryLock


def contender(path):
    return subprocess.run([sys.executable, '-c',
        'import sys; from pathlib import Path; from app.core.data_lock import DataDirectoryLock; '
        'lock=DataDirectoryLock(Path(sys.argv[1])); lock.acquire(); lock.release()', str(path)],
        capture_output=True, text=True, timeout=5)


def test_second_process_cannot_write_and_release_allows_restart(tmp_path):
    lock = DataDirectoryLock(tmp_path)
    lock.acquire()
    try:
        result = contender(tmp_path)
        assert result.returncode != 0
        assert 'Data directory is already in use' in result.stderr
    finally:
        lock.release()
    assert contender(tmp_path).returncode == 0


def test_crashed_owner_does_not_leave_stale_lock(tmp_path):
    result = subprocess.run([sys.executable, '-c',
        'import os,sys; from pathlib import Path; from app.core.data_lock import DataDirectoryLock; '
        'lock=DataDirectoryLock(Path(sys.argv[1])); lock.acquire(); os._exit(0)', str(tmp_path)], timeout=5)
    assert result.returncode == 0
    assert contender(tmp_path).returncode == 0
