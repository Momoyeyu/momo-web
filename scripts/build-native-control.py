#!/usr/bin/env python3
"""Build fixed macOS input broker. No runtime compiler or downloaded executable."""
import argparse, pathlib, subprocess, sys
parser=argparse.ArgumentParser()
parser.add_argument('--output',required=True)
parser.add_argument('--sdk',required=True,help='SDK matching installed Swift compiler')
a=parser.parse_args()
if sys.platform!='darwin': raise SystemExit('macOS build required')
source=pathlib.Path(__file__).resolve().parents[1]/'plugin-host/resources/native-control/control.swift'
output=pathlib.Path(a.output).resolve();output.parent.mkdir(parents=True,exist_ok=True)
subprocess.run(['/usr/bin/swiftc','-sdk',str(pathlib.Path(a.sdk).resolve()),str(source),'-o',str(output)],check=True)
print(output)
