import json
from unittest.mock import patch
import pytest
from app.core import db
from app.services import minecraft_journal as journal

BINDING={'world':'remembered-world','account':'player'}


def visit(x=1,markers=(),dimension='minecraft:overworld',binding=BINDING):
    journal.observe_visit(binding,{**binding,'dimension':dimension,'x':x,'y':64,'z':0,
                                   'visibleLandmarks':list(markers),'visibleBlocks':[]})


def marker(block='minecraft:oak_log',x=60):
    return {'block':block,'x':x,'y':68,'z':0}


def test_older_forests_are_queryable_after_recent_visits_and_looking_away():
    seen=marker()
    with patch.object(db,'now_iso',return_value='2026-11-16T01:00:00+00:00'):visit(markers=[seen])
    visit(x=2)  # The same visited chunk is seen from another angle.
    assert journal.explored(BINDING)[0]['landmarks']==[], 'The ordinary visit view stays a truthful snapshot'
    for x in range(10):visit(x=160+x*16)
    assert not any(p['landmarks'] for p in journal.explored(BINDING)[:4])
    recalled=journal.recall_places(BINDING,'oak')
    assert len(recalled)==1
    assert {k:recalled[0][k] for k in seen}==seen
    assert recalled[0]['seenAt']=='2026-11-16T01:00:00+00:00'
    assert recalled[0]['dimension']=='minecraft:overworld'


def test_a_new_observation_at_the_same_position_replaces_the_old_marker():
    visit(markers=[marker()]);visit(markers=[marker('minecraft:furnace')])
    assert journal.recall_places(BINDING,'oak')==[]
    assert journal.recall_places(BINDING,'furnace')[0]['block']=='minecraft:furnace'


def test_place_recall_is_scoped_to_world_account_and_preserves_dimensions():
    visit(markers=[marker()])
    visit(markers=[marker('minecraft:warped_stem')],dimension='minecraft:the_nether')
    assert journal.recall_places({'world':'another','account':'player'},'')==[]
    assert journal.recall_places({'world':'remembered-world','account':'another'},'')==[]
    assert {row['dimension'] for row in journal.recall_places(BINDING,'')}=={'minecraft:overworld','minecraft:the_nether'}


def test_only_observed_bounded_markers_are_remembered_and_result_size_is_bounded():
    visit(markers=[marker('minecraft:diamond_ore',x=200)])
    assert journal.recall_places(BINDING,'diamond')==[]
    for i in range(20):visit(x=i*32,markers=[marker(x=i*32+3)])
    assert 0<len(journal.recall_places(BINDING,'oak'))<=6
    for i in range(8):visit(x=1,markers=[marker(x=20+i*6+j) for j in range(6)])
    row=db.query('SELECT data FROM minecraft_places WHERE scope=? AND chunk_x=0 AND chunk_z=0',(journal.scope(BINDING),))[0]
    assert len(json.loads(row['data'])['knownLandmarks'])<=32


def test_legacy_sightings_are_read_without_migration_or_new_observations():
    journal.schema();legacy={'dimension':'minecraft:overworld','x':1,'y':64,'z':0,'landmarks':[marker()]}
    with db.tx() as c:c.execute('INSERT INTO minecraft_places VALUES(?,?,?,?,?,?)',
                               (journal.scope(BINDING),'minecraft:overworld',0,0,json.dumps(legacy),'2026-11-15T01:00:00+00:00'))
    assert journal.recall_places(BINDING,'oak')[0]['seenAt']=='2026-11-15T01:00:00+00:00'
    assert journal.explored(BINDING)==[legacy]
    assert json.loads(db.query('SELECT data FROM minecraft_places')[0]['data'])==legacy


def test_recall_does_not_look_up_or_scan_the_live_world():
    from tests.test_minecraft_tasks import setup
    m,runtime=setup();m.binding=BINDING
    visit(markers=[marker()])
    with patch('app.services.minecraft.runtime',runtime),patch.object(m,'gate',return_value='cfg'):
        result=m.execute('places',{'query':'oak'},0,'owner','lease')
        assert result['historical'] is True and result['places'][0]['block']=='minecraft:oak_log'
        runtime.host.request.assert_not_called()
        with pytest.raises(ValueError,match='revoked'):m.execute('places',{'query':'oak'},99,'owner','lease')
        m.permissions=set()
        with pytest.raises(ValueError,match='denied'):m.execute('places',{'query':'oak'},0,'owner','lease')


def test_places_tool_and_api_pass_the_query_without_staging_a_frame():
    from app.services import computer_tools as tools
    from app.services.minecraft import minecraft
    from app.api.minecraft import TaskCommand,tasks
    reply={'historical':True,'places':[{'block':'minecraft:oak_log','x':60,'y':68,'z':0}]}
    with patch.object(tools,'require_local',return_value='run'),patch.object(minecraft,'execute',return_value=reply) as execute,patch.object(tools,'stage') as stage:
        value=json.loads(tools.execute('minecraft_action',{'action':'places','query':'oak'}))
        assert value==reply
        assert execute.call_args.args[:2]==('places',{'query':'oak'})
        assert tools.capture_budget({'function':{'name':'minecraft_action','arguments':'{"action":"places","query":"oak"}'}})==[]
        stage.assert_not_called()
        command=TaskCommand(clientId='owner',leaseId='lease',generation=0,action='places',query='oak')
        assert tasks(command)==reply
        assert execute.call_args.args[:2]==('places',{'query':'oak'})
