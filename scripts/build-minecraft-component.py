#!/usr/bin/env python3
"""Build the pinned original mod; generated artifacts never enter source control."""
import argparse
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
def dependency_lock():return json.loads((ROOT/'scripts/minecraft-resources.json').read_text())['baritone']

def validate_distribution(artifact, *, lock=None):
    """Developer world setup must never become an installed game capability."""
    with zipfile.ZipFile(artifact) as archive:
        for name in archive.namelist():
            if name.startswith('dev/momo/fixture/') or 'acceptance-fixture' in name.lower():
                raise ValueError('Development fixture content cannot enter the companion distribution')
        metadata=json.loads(archive.read('fabric.mod.json'))
        if metadata.get('id')!='momo_companion':raise ValueError('Expected the production companion mod')
        lock=lock or dependency_lock()
        nested='META-INF/jars/'+lock['file']
        if metadata.get('jars')!=[{'file':nested}]:raise ValueError('Unpinned nested dependency')
        try:
            if archive.getinfo(nested).file_size>lock['maxBytes']:raise ValueError('Oversized nested dependency')
            if hashlib.sha256(archive.read(nested)).hexdigest()!=lock['sha256']:raise ValueError('Nested dependency checksum mismatch')
            if json.loads(archive.read('META-INF/momo/minecraft-resources.json'))!={'baritone':lock}:raise ValueError('Embedded dependency lock mismatch')
            if not archive.read('META-INF/licenses/baritone-LGPL-3.0.txt'):raise ValueError('Missing upstream notice')
            notice=archive.read('META-INF/licenses/baritone-source.txt').decode()
            if lock['source'] not in notice or lock['release'] not in notice:raise ValueError('Incomplete upstream notice')
        except KeyError as error:raise ValueError('Missing pinned dependency or upstream notice') from error

def provenance(artifact, source_revision, *, lock=None):
    lock=lock or dependency_lock()
    validate_distribution(artifact,lock=lock)
    return {'format':'momo-minecraft-component','version':1,'artifact':Path(artifact).name,
            'sha256':hashlib.sha256(Path(artifact).read_bytes()).hexdigest(),
            'sourceRevision':source_revision,'minecraft':lock['minecraft'],'dependency':lock}

def stage_distribution(artifact, destination, source_revision, *, lock=None):
    """Stage only a build whose receipt matches these exact bytes and source."""
    artifact=Path(artifact);proof=artifact.with_suffix('.provenance.json')
    expected=provenance(artifact,source_revision,lock=lock)
    if not proof.is_file() or json.loads(proof.read_text())!=expected:raise ValueError('Minecraft build provenance mismatch')
    destination=Path(destination);destination.mkdir(parents=True,exist_ok=True)
    shutil.copy2(artifact,destination/artifact.name)
    shutil.copy2(proof,destination/proof.name)
    return expected

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
    source=ROOT/'migration/web-source.json'
    revision=json.loads(source.read_text())['revision'] if source.is_file() else subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True).strip()
    record=provenance(artifact,revision)
    artifact.with_suffix('.provenance.json').write_text(json.dumps(record,indent=2)+'\n')
    print(json.dumps({**record,'artifact':str(artifact)}))
if __name__ == '__main__': main()
