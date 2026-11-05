from pathlib import Path
import os


class DataDirectoryLock:
    def __init__(self, directory: Path):
        self.directory = directory
        self.file = None

    def acquire(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        handle = (self.directory / '.momo-owner.lock').open('a+b')
        try:
            if os.name == 'nt':
                import msvcrt
                handle.seek(0)
                if not handle.read(1):
                    handle.write(b'0')
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            handle.close()
            raise RuntimeError('Data directory is already in use') from error
        self.file = handle

    def release(self):
        if self.file is not None:
            self.file.close()
            self.file = None
