"""Dependency verification must fail closed before Loom loads downloaded bytecode."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('minecraft_runtime', Path(__file__).with_name('prepare-minecraft-runtime.py'))
runtime = importlib.util.module_from_spec(spec) if spec else None
if spec and spec.loader and Path(spec.origin).exists():
    spec.loader.exec_module(runtime)

class RuntimeVerification(unittest.TestCase):
    def archive(self, directory, minecraft=('1.21','1.21.1')):
        path=Path(directory)/'baritone.jar'
        with zipfile.ZipFile(path,'w') as z:
            z.writestr('fabric.mod.json',json.dumps({'id':'baritone','version':'1.11.3','license':'LGPL-3.0','depends':{'minecraft':list(minecraft)}}))
        lock={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'maxBytes':6000000,'modId':'baritone','version':'1.11.3','minecraft':'1.21.1','license':'LGPL-3.0'}
        return path,lock

    def test_verifier_exists(self):
        self.assertTrue(callable(getattr(runtime,'verify',None)), 'No verified dependency loader exists')

    def test_tampered_archive_is_rejected(self):
        if not hasattr(runtime,'verify'): self.fail('No verifier')
        with tempfile.TemporaryDirectory() as directory:
            path,lock=self.archive(directory)
            path.write_bytes(path.read_bytes()+b'tampered')
            with self.assertRaisesRegex(ValueError,'checksum'): runtime.verify(path,lock)

    def test_other_minecraft_version_is_rejected_even_with_matching_hash(self):
        if not hasattr(runtime,'verify'): self.fail('No verifier')
        with tempfile.TemporaryDirectory() as directory:
            path,lock=self.archive(directory,('1.21.4',))
            with self.assertRaisesRegex(ValueError,'Minecraft'): runtime.verify(path,lock)

    def test_valid_archive_and_license_are_verified(self):
        if not hasattr(runtime,'verify'): self.fail('No verifier')
        with tempfile.TemporaryDirectory() as directory:
            path,lock=self.archive(directory)
            self.assertEqual(runtime.verify(path,lock)['version'],'1.11.3')

    def test_symlink_is_rejected(self):
        if not hasattr(runtime,'verify'): self.fail('No verifier')
        with tempfile.TemporaryDirectory() as directory:
            path,lock=self.archive(directory)
            link=Path(directory)/'link.jar';link.symlink_to(path)
            with self.assertRaisesRegex(ValueError,'regular'): runtime.verify(link,lock)

if __name__=='__main__': unittest.main()
