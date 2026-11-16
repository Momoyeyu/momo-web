import gzip
import importlib.util
from pathlib import Path
import tempfile
import unittest

module_path=Path(__file__).with_name('minecraft_fixture_world.py')
spec=importlib.util.spec_from_file_location('fixture_world',module_path)
world=importlib.util.module_from_spec(spec)
spec.loader.exec_module(world)

class FixtureWorldTests(unittest.TestCase):
    def test_codec_preserves_tag_types_and_array_bytes(self):
        # A fixed big-endian NBT root containing one signed integer.
        raw=bytes.fromhex('0a000003000178fffffffe00')
        self.assertEqual(world.encode(world.decode(raw)),raw)
        self.assertEqual(world.decode(raw)[1]['x'],(3,-2))

    def test_new_world_is_isolated_survival_and_template_is_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            template=root/'original.dat'
            template.write_bytes(gzip.compress(world.encode(('',{'Data':(10,{'LevelName':(8,b'original'),'Player':(10,{'Inventory':(9,(10,[]))}),'WorldGenSettings':(10,{'dimensions':(10,{'minecraft:overworld':(10,{'generator':(10,{})})})})})}))))
            original=template.read_bytes()
            destination=world.prepare(template,root/'saves')
            data=world.decode(gzip.decompress((destination/'level.dat').read_bytes()))[1]['Data'][1]
            self.assertNotIn('Player',data)
            self.assertEqual(data['GameType'],(3,0))
            self.assertEqual(data['allowCommands'],(1,0))
            self.assertEqual(data['Difficulty'],(1,2))
            self.assertEqual(data['WorldGenSettings'][1]['dimensions'][1]['minecraft:overworld'][1]['generator'][1]['type'],(8,b'minecraft:flat'))
            layers=data['WorldGenSettings'][1]['dimensions'][1]['minecraft:overworld'][1]['generator'][1]['settings'][1]['layers'][1][1]
            self.assertEqual(-64+sum(layer['height'][1] for layer in layers)-1,63,'Flat layers begin at dimension minY=-64; the surrounding ground must meet the scene at Y=63')
            self.assertEqual((destination/'.momo-fixture-setup').read_text(),'momo-007-fixtures-v1\n')
            self.assertEqual(template.read_bytes(),original)
            with self.assertRaises(FileExistsError):world.prepare(template,root/'saves')
            self.assertEqual(template.read_bytes(),original)

    def test_transition_pair_is_fresh_survival_and_cannot_overwrite_a_save(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);template=root/'source.dat'
            template.write_bytes(gzip.compress(world.encode(('',{'Data':(10,{'Player':(10,{'Inventory':(9,(10,[]))}),'WorldGenSettings':(10,{'dimensions':(10,{'minecraft:overworld':(10,{'generator':(10,{})})})})})}))))
            original=template.read_bytes();saves=root/'saves'
            pair=world.prepare_transition(template,saves)
            self.assertEqual([p.name for p in pair],['momo-007-transition-a','momo-007-transition-b'])
            self.assertEqual(sorted(p.name for p in saves.iterdir()),sorted(p.name for p in pair),'No staging world is left behind')
            for path in pair:
                data=world.decode(gzip.decompress((path/'level.dat').read_bytes()))[1]['Data'][1]
                self.assertEqual(data['LevelName'],(8,path.name.encode()))
                self.assertNotIn('Player',data)
                self.assertEqual(data['GameType'],(3,0));self.assertEqual(data['allowCommands'],(1,0))
                self.assertEqual((path/'.momo-transition-test').read_bytes(),b'momo-007-transition-v1\n')
                self.assertFalse((path/'.momo-fixture-setup').exists(),'The paired world never authorizes server fixture seeding')
            self.assertEqual(template.read_bytes(),original)
            before=[(p/'level.dat').read_bytes() for p in pair]
            with self.assertRaises(FileExistsError):world.prepare_transition(template,saves)
            self.assertEqual([(p/'level.dat').read_bytes() for p in pair],before)

    def test_existing_transition_destination_prevents_both_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);template=root/'missing-template.dat';saves=root/'saves'
            existing=saves/'momo-007-transition-b';existing.mkdir(parents=True)
            (existing/'keep.txt').write_text('player data')
            with self.assertRaises(FileExistsError):world.prepare_transition(template,saves)
            self.assertFalse((saves/'momo-007-transition-a').exists())
            self.assertEqual((existing/'keep.txt').read_text(),'player data')

if __name__=='__main__':unittest.main()
