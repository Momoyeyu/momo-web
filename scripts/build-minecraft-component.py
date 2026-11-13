#!/usr/bin/env python3
"""Build the pinned original mod; generated artifacts never enter source control."""
import argparse
from pathlib import Path
import hashlib
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
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
    print(json.dumps({'artifact':str(artifact),'sha256':hashlib.sha256(artifact.read_bytes()).hexdigest()}))
if __name__ == '__main__': main()
