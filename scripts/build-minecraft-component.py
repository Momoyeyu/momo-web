#!/usr/bin/env python3
"""Build the pinned original mod; generated artifacts never enter source control."""
import argparse
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
def validate_distribution(artifact):
    """Developer world setup must never become an installed game capability."""
    with zipfile.ZipFile(artifact) as archive:
        for name in archive.namelist():
            if name.startswith('dev/momo/fixture/') or 'acceptance-fixture' in name.lower():
                raise ValueError('Development fixture content cannot enter the companion distribution')
        metadata=json.loads(archive.read('fabric.mod.json'))
        if metadata.get('id')!='momo_companion':raise ValueError('Expected the production companion mod')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--gradle',type=Path,required=True,help='Qualified Gradle 8.10.2 executable')
    parser.add_argument('--cache',type=Path,required=True,help='Isolated build cache')
    args = parser.parse_args()
    gradle = str(args.gradle.resolve(strict=True))
    version = subprocess.run([gradle,'--version'],capture_output=True,text=True,check=True).stdout
    if 'Gradle 8.10.2' not in version: raise SystemExit('Expected Gradle 8.10.2')
    subprocess.run([sys.executable,str(ROOT/'scripts/prepare-minecraft-runtime.py'),'--offline'],check=True)
    cwd = ROOT/'plugin-host/minecraft-fabric'
    subprocess.run([gradle,'--no-daemon','--gradle-user-home',str(args.cache.resolve()),'build'],cwd=cwd,check=True)
    artifact = cwd/'build/libs/momo-fabric-companion-0.1.0.jar'
    validate_distribution(artifact)
    print(json.dumps({'artifact':str(artifact),'sha256':hashlib.sha256(artifact.read_bytes()).hexdigest()}))
if __name__ == '__main__': main()
