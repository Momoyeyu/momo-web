"""Exercise the build downloader against an HTTP boundary and integrity checks."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from threading import Thread
import unittest


class PrepareCoreTests(unittest.TestCase):
    def run_downloader(self, response, expected, existing=None):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                agent = self.headers.get('User-Agent', '')
                requests.append(agent)
                if agent != 'momo-resource-builder/1':
                    self.send_error(403)
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(response)

            def log_message(self, *_args):
                pass

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            (root / 'migration').mkdir()
            source = Path(__file__).resolve().parents[2] / 'scripts/prepare-core.py'
            script = root / 'scripts/prepare-core.py'
            shutil.copyfile(source, script)
            target = root / 'frontend/public/live2d/live2dcubismcore.min.js'
            if existing is not None:
                target.parent.mkdir(parents=True)
                target.write_bytes(existing)
            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                (root / 'migration/cubism-core.json').write_text(json.dumps({
                    'url': f'http://127.0.0.1:{server.server_port}/core.js',
                    'size_bytes': len(expected),
                    'sha256': hashlib.sha256(expected).hexdigest(),
                }))
                result = subprocess.run([sys.executable, str(script)], capture_output=True, text=True, timeout=10)
                content = target.read_bytes() if target.exists() else None
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
            return result, content, requests

    def test_identified_request_can_fetch_verified_core(self):
        core = b'verified core fixture'
        result, content, requests = self.run_downloader(core, core)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(content, core)
        self.assertEqual(requests, ['momo-resource-builder/1'])

    def test_corrupt_download_does_not_replace_existing_input(self):
        previous = b'previous build input'
        result, content, _ = self.run_downloader(b'wrong bytes', b'right bytes', previous)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('checksum mismatch', result.stderr)
        self.assertEqual(content, previous)

    def test_verified_cache_needs_no_network(self):
        core = b'verified cached fixture'
        result, content, requests = self.run_downloader(b'unused', core, core)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(content, core)
        self.assertEqual(requests, [])
