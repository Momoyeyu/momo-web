#!/usr/bin/env python3
"""Create an opt-in, disposable 007 test save. Never edit a played world.

The separate development setup mod fills this save once; remove that mod before
acceptance. This script and its generated saves are not application resources.
"""
import argparse
import gzip
import io
from pathlib import Path
import struct
import time

NAME='momo-007-fixtures'

def decode(data):
    cursor=0
    def take(length):
        nonlocal cursor
        if length<0 or cursor+length>len(data):raise ValueError('Invalid NBT boundary')
        value=data[cursor:cursor+length];cursor+=length;return value
    def number(fmt):return struct.unpack('>'+fmt,take(struct.calcsize('>'+fmt)))[0]
    def string():return take(number('H'))
    def payload(kind):
        if kind in {1,2,3,4,5,6}:return number({1:'b',2:'h',3:'i',4:'q',5:'f',6:'d'}[kind])
        if kind==8:return string()
        if kind in {7,11,12}:
            length=number('i')
            if length<0:raise ValueError('Invalid NBT array')
            return take(length*{7:1,11:4,12:8}[kind])
        if kind==9:
            child=number('B');length=number('i')
            if length<0 or length>len(data):raise ValueError('Invalid NBT list')
            return child,[payload(child) for _ in range(length)]
        if kind==10:
            result={}
            while True:
                child=number('B')
                if not child:return result
                key=string().decode('utf-8',errors='surrogateescape')
                if key in result:raise ValueError('Duplicate NBT key')
                result[key]=(child,payload(child))
        raise ValueError('Unsupported NBT tag')
    if number('B')!=10:raise ValueError('Expected compound NBT root')
    name=string().decode('utf-8',errors='surrogateescape');value=payload(10)
    if cursor!=len(data):raise ValueError('Trailing NBT bytes')
    return name,value

def encode(root):
    def text(value):
        value=value if isinstance(value,bytes) else value.encode('utf-8',errors='surrogateescape')
        return struct.pack('>H',len(value))+value
    def payload(kind,value):
        if kind in {1,2,3,4,5,6}:return struct.pack('>'+{1:'b',2:'h',3:'i',4:'q',5:'f',6:'d'}[kind],value)
        if kind==8:return text(value)
        if kind in {7,11,12}:return struct.pack('>i',len(value)//{7:1,11:4,12:8}[kind])+value
        if kind==9:
            child,items=value
            return bytes([child])+struct.pack('>i',len(items))+b''.join(payload(child,item) for item in items)
        if kind==10:return b''.join(bytes([tag[0]])+text(key)+payload(*tag) for key,tag in value.items())+b'\0'
        raise ValueError('Unsupported NBT tag')
    name,value=root
    return b'\x0a'+text(name)+payload(10,value)

def prepare(template,saves):
    template=Path(template).resolve(strict=True);saves=Path(saves).resolve();destination=saves/NAME
    if destination.exists() or destination.is_symlink():raise FileExistsError('Never replace an existing fixture or played save')
    compressed=template.read_bytes()
    if len(compressed)>4_000_000:raise ValueError('Unexpected level.dat size')
    with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:raw=stream.read(16_000_001)
    if len(raw)>16_000_000:raise ValueError('Unexpected NBT size')
    root=decode(raw);data=root[1]['Data'][1]
    data.pop('Player',None)
    data.update(LevelName=(8,NAME.encode()),GameType=(3,0),hardcore=(1,0),allowCommands=(1,0),Difficulty=(1,2),DifficultyLocked=(1,0),initialized=(1,1),SpawnX=(3,0),SpawnY=(3,64),SpawnZ=(3,0),SpawnAngle=(5,0.0),Time=(4,6000),DayTime=(4,6000),LastPlayed=(4,int(time.time()*1000)))
    rules=data.setdefault('GameRules',(10,{}))[1]
    rules.update({key:(8,value.encode()) for key,value in {'doDaylightCycle':'false','doWeatherCycle':'false','doMobSpawning':'false','spawnRadius':'0'}.items()})
    generation=data['WorldGenSettings'][1];generation['seed']=(4,172007);generation['generate_features']=(1,0);generation['bonus_chest']=(1,0)
    overworld=generation['dimensions'][1]['minecraft:overworld'][1]
    overworld['type']=(8,b'minecraft:overworld')
    overworld['generator']=(10,{'type':(8,b'minecraft:flat'),'settings':(10,{'biome':(8,b'minecraft:plains'),'features':(1,0),'lakes':(1,0),'structure_overrides':(9,(8,[])),'layers':(9,(10,[{'block':(8,block.encode()),'height':(3,height)} for block,height in [('minecraft:bedrock',1),('minecraft:dirt',126),('minecraft:grass_block',1)]]))})})
    output=gzip.compress(encode(root),mtime=0)
    destination.mkdir(parents=True,mode=0o700)
    (destination/'level.dat').write_bytes(output)
    (destination/'.momo-fixture-setup').write_text('momo-007-fixtures-v1\n')
    return destination

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--template',type=Path,required=True)
    parser.add_argument('--saves',type=Path,required=True)
    args=parser.parse_args();print(prepare(args.template,args.saves))

if __name__=='__main__':main()
