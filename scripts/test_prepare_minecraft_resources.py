import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('prepare_minecraft',Path(__file__).with_name('prepare-minecraft-resources.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class ResourceDownloadTests(unittest.TestCase):
    def test_nonofficial_download_is_rejected_before_network(self):
        with patch.object(module.urllib.request,'urlopen') as network:
            with self.assertRaises(ValueError): module.fetch('https://example.com/mod.jar')
            with self.assertRaises(ValueError): module.fetch('http://maven.fabricmc.net/file')
            network.assert_not_called()
    def test_retries_are_bounded(self):
        with patch.object(module.urllib.request,'urlopen',side_effect=TimeoutError) as network, patch.object(module.time,'sleep'):
            with self.assertRaises(TimeoutError): module.fetch('https://maven.fabricmc.net/file')
            self.assertEqual(network.call_count,4)
    def test_failure_preserves_cache_and_removes_partial_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);cache=root/'cache';cache.mkdir();(cache/'existing').write_bytes(b'cache')
            with patch.object(module,'data',side_effect=TimeoutError):
                with self.assertRaises(TimeoutError): module.prepare(root/'result',root/'mod.jar',cache)
            self.assertFalse((root/'result').exists())
            self.assertEqual((cache/'existing').read_bytes(),b'cache')
    def test_complete_manifest_records_asset_index_and_reuses_verified_cache(self):
        import hashlib,json
        def sha(raw): return hashlib.sha1(raw).hexdigest()
        asset=b'asset'; client=b'client'; api=b'api'
        index=json.dumps({'objects':{'one':{'hash':sha(asset)}}}).encode()
        version=json.dumps({'downloads':{'client':{'url':'https://piston-data.mojang.com/client','sha1':sha(client)}},'libraries':[],'assetIndex':{'id':'17','url':'https://piston-meta.mojang.com/assets','sha1':sha(index)}}).encode()
        versions={'versions':[{'id':'1.21.1','url':'https://piston-meta.mojang.com/version','sha1':sha(version)}]}
        def fetch(url):
            if url.endswith('version_manifest_v2.json'): return json.dumps(versions).encode()
            if url.endswith('profile/json'): return json.dumps({'libraries':[],'mainClass':'net.fabricmc.loader.impl.launch.knot.KnotClient'}).encode()
            if url.endswith('/version'): return version
            if url.endswith('/client'): return client
            if url.endswith('/assets'): return index
            if 'resources.download' in url: return asset
            if url.endswith('.sha1'): return sha(api).encode()
            if url.endswith('.jar'): return api
            raise AssertionError(url)
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);mod=root/'mod.jar';mod.write_bytes(b'mod')
            with patch.object(module,'fetch',side_effect=fetch):
                module.prepare(root/'result',mod)
            manifest=json.loads((root/'result'/'manifest.json').read_text())
            self.assertEqual(manifest['assetIndex'],'17')
            self.assertEqual(len(manifest['files']),5)
if __name__=='__main__': unittest.main()
