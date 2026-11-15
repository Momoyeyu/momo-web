import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
spec=importlib.util.spec_from_file_location('component_builder',Path(__file__).with_name('build-minecraft-component.py'))
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)

class DistributionIsolation(unittest.TestCase):
    dependency=b'locked upstream bytes'
    lock={'file':'baritone.jar','sha256':hashlib.sha256(dependency).hexdigest(),'maxBytes':1000,'minecraft':'1.21.1','version':'1.11.3','license':'LGPL-3.0','source':'https://example.invalid/source','release':'https://example.invalid/release'}
    def archive(self,folder,entries=None,identity='momo_companion',dependency=None,notice=True):
        path=Path(folder)/'companion.jar'
        with zipfile.ZipFile(path,'w') as z:
            z.writestr('fabric.mod.json',json.dumps({'id':identity,'jars':[{'file':'META-INF/jars/baritone.jar'}]}))
            z.writestr('META-INF/jars/baritone.jar',self.dependency if dependency is None else dependency)
            z.writestr('META-INF/momo/minecraft-resources.json',json.dumps({'baritone':self.lock}))
            if notice:
                z.writestr('META-INF/licenses/baritone-LGPL-3.0.txt','LGPL-3.0 test notice')
                z.writestr('META-INF/licenses/baritone-source.txt',self.lock['source']+' '+self.lock['release'])
            for name in entries or []:z.writestr(name,b'fixture')
        return path
    def test_regular_companion_is_valid(self):
        with tempfile.TemporaryDirectory() as folder:
            builder.validate_distribution(self.archive(folder,['dev/momo/CompanionClient.class']),lock=self.lock)
    def test_development_initializer_cannot_enter_distribution(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError,'fixture'):
                builder.validate_distribution(self.archive(folder,['dev/momo/fixture/AcceptanceFixtures.class']),lock=self.lock)
    def test_preparation_mod_cannot_be_staged_as_the_companion(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):builder.validate_distribution(self.archive(folder,identity='momo_acceptance_setup'),lock=self.lock)
    def test_nested_preparation_mod_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError,'fixture'):
                builder.validate_distribution(self.archive(folder,['META-INF/jars/momo-acceptance-fixtures.jar']),lock=self.lock)

    def test_tampered_nested_dependency_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError,'checksum'):builder.validate_distribution(self.archive(folder,dependency=b'tampered'),lock=self.lock)
    def test_missing_upstream_notice_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError,'notice'):builder.validate_distribution(self.archive(folder,notice=False),lock=self.lock)
    def test_provenance_records_actual_artifact_and_locked_dependency(self):
        with tempfile.TemporaryDirectory() as folder:
            artifact=self.archive(folder)
            result=builder.provenance(artifact,'a'*40,lock=self.lock)
            self.assertEqual(result['sha256'],hashlib.sha256(artifact.read_bytes()).hexdigest())
            self.assertEqual(result['sourceRevision'],'a'*40)
            self.assertEqual(result['dependency'],self.lock)

    def test_staging_requires_exact_provenance_revision_and_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            artifact=self.archive(folder);destination=Path(folder)/'staged'
            proof=builder.provenance(artifact,'a'*40,lock=self.lock)
            artifact.with_suffix('.provenance.json').write_text(json.dumps(proof))
            with self.assertRaisesRegex(ValueError,'provenance'):builder.stage_distribution(artifact,destination,'b'*40,lock=self.lock)
            self.assertFalse(destination.exists())
            builder.stage_distribution(artifact,destination,'a'*40,lock=self.lock)
            self.assertEqual((destination/artifact.name).read_bytes(),artifact.read_bytes())
            self.assertEqual(json.loads((destination/artifact.with_suffix('.provenance.json').name).read_text()),proof)
            artifact.write_bytes(artifact.read_bytes()+b'changed bytes')
            with self.assertRaisesRegex(ValueError,'provenance'):builder.stage_distribution(artifact,destination,'a'*40,lock=self.lock)

if __name__=='__main__':unittest.main()
