import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
spec=importlib.util.spec_from_file_location('component_builder',Path(__file__).with_name('build-minecraft-component.py'))
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)

class DistributionIsolation(unittest.TestCase):
    def archive(self,folder,entries=None,identity='momo_companion'):
        path=Path(folder)/'companion.jar'
        with zipfile.ZipFile(path,'w') as z:
            z.writestr('fabric.mod.json',json.dumps({'id':identity}))
            for name in entries or []:z.writestr(name,b'fixture')
        return path
    def test_regular_companion_is_valid(self):
        with tempfile.TemporaryDirectory() as folder:
            builder.validate_distribution(self.archive(folder,['dev/momo/CompanionClient.class']))
    def test_development_initializer_cannot_enter_distribution(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError,'fixture'):
                builder.validate_distribution(self.archive(folder,['dev/momo/fixture/AcceptanceFixtures.class']))
    def test_preparation_mod_cannot_be_staged_as_the_companion(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):builder.validate_distribution(self.archive(folder,identity='momo_acceptance_setup'))
    def test_nested_preparation_mod_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError,'fixture'):
                builder.validate_distribution(self.archive(folder,['META-INF/jars/momo-acceptance-fixtures.jar']))

if __name__=='__main__':unittest.main()
