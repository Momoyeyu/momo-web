"""Advisory OS lock outside the replaceable profile tree (also survives restore)."""

import hashlib
import os
from pathlib import Path


class InstanceLock:
    def __init__(self, data_dir):
        data_dir = Path(data_dir).resolve()
        data_dir.parent.mkdir(parents=True, exist_ok=True)
        name = (
            ".momo-" + hashlib.sha256(str(data_dir).encode()).hexdigest()[:20] + ".lock"
        )
        self.path = data_dir.parent / name
        self.file = None

    def acquire(self):
        self.file = open(self.path, "a+b")
        os.chmod(self.path, 0o600)
        try:
            if os.name == "nt":
                import msvcrt

                self.file.seek(0)
                if not self.file.read(1):
                    self.file.write(b" ")
                    self.file.flush()
                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, BlockingIOError) as error:
            self.file.close()
            self.file = None
            raise RuntimeError("Another momo coordinator owns this profile") from error
        return self

    def close(self):
        if self.file:
            self.file.close()
            self.file = None
        # Do not unlink: waiting instances must lock the same inode.
