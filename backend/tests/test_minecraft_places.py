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


SEEN='2026-11-16T01:00:00+00:00'
REMOVED=1794790801000  # 2026-11-16 01:00:01 UTC

def fact(seq=1,**values):
 return {'seq':seq,'source':'mined','serverBlockSeq':seq,'observedAt':REMOVED,
         'dimension':'minecraft:overworld','x':60,'y':68,'z':0,'block':'minecraft:air',**values}

def test_confirmed_mining_prunes_all_old_sightings_without_inventing_a_visit():
 with patch.object(db,'now_iso',return_value=SEEN):
  visit(markers=[marker()]);visit(x=17,markers=[marker()])
 before=db.query('SELECT updated_at FROM minecraft_places ORDER BY rowid')
 assert journal.apply_block_facts(BINDING,[fact()])==1
 assert journal.recall_places(BINDING,'oak')==[]
 assert db.query('SELECT updated_at FROM minecraft_places ORDER BY rowid')==before
 assert journal.goal(BINDING) is None
 assert journal.apply_block_facts(BINDING,[fact()],after=1)==1

@pytest.mark.parametrize('change',[{'source':'unknown'},{'serverBlockSeq':0},{'x':True},{'y':999},{'observedAt':0},{'dimension':'bad'},{'block':'private command'},{'seq':False}])
def test_unconfirmed_or_malformed_changes_do_not_delete_resource_memory(change):
 with patch.object(db,'now_iso',return_value=SEEN):visit(markers=[marker()])
 assert journal.apply_block_facts(BINDING,[fact(**change)])==0
 assert len(journal.recall_places(BINDING,'oak'))==1

def test_clear_line_of_sight_absence_is_not_a_claim_of_a_server_mutation():
 with patch.object(db,'now_iso',return_value=SEEN):visit(markers=[marker()])
 assert journal.apply_block_facts(BINDING,[fact(source='visible_absence',serverBlockSeq=0)])==1
 assert journal.recall_places(BINDING,'oak')==[]


def test_fresh_regrowth_wins_over_late_old_receipts_and_wrong_scopes():
 with patch.object(db,'now_iso',return_value='2026-11-16T01:00:02+00:00'):visit(markers=[marker()])
 journal.apply_block_facts(BINDING,[fact()])
 assert journal.recall_places(BINDING,'oak')
 with patch.object(db,'now_iso',return_value=SEEN):visit(markers=[marker()],dimension='minecraft:the_nether')
 journal.apply_block_facts({'world':'other','account':'player'},[fact(observedAt=REMOVED+2000)])
 assert len(journal.recall_places(BINDING,'oak'))==2
 journal.apply_block_facts(BINDING,[fact(seq=2,observedAt=REMOVED+2000)])
 assert [p['dimension'] for p in journal.recall_places(BINDING,'oak')]==['minecraft:the_nether']


def test_legacy_successful_receipts_filter_recall_without_replaying_or_editing_history():
 with patch.object(db,'now_iso',return_value=SEEN):visit(markers=[marker()])
 raw=json.dumps({'taskId':'old-mine','skill':'plan','state':'succeeded','dimension':'minecraft:overworld',
   'evidence':{'steps':[{'result':{'x':60,'y':68,'z':0,'block':'Block{minecraft:oak_log}[axis=y]',
                                  'after':'Block{minecraft:air}','serverBlockSeq':7}}]}})
 with db.tx() as c:c.execute('INSERT INTO minecraft_tasks VALUES(?,?,?,?,?)',(journal.scope(BINDING),'old','old-mine',raw,'2026-11-16T01:00:01+00:00'))
 assert journal.recall_places(BINDING,'oak')==[]
 assert db.query('SELECT data FROM minecraft_tasks')[0]['data']==raw


def test_queued_or_failed_absence_without_a_real_receipt_is_not_negative_knowledge():
 with patch.object(db,'now_iso',return_value=SEEN):visit(markers=[marker()])
 journal.record(BINDING,'a',[{'taskId':'not-seen','skill':'mine','state':'failed','reason':'target_not_visible','dimension':'minecraft:overworld','evidence':{}}])
 assert journal.recall_places(BINDING,'oak')


def test_late_terminal_receipt_preserves_newer_regrowth_and_queued_receipts_are_not_facts():
 with patch.object(db,'now_iso',return_value='2026-11-16T01:00:02+00:00'):visit(markers=[marker()])
 evidence={'x':60,'y':68,'z':0,'block':'Block{minecraft:oak_log}[axis=y]',
           'after':'Block{minecraft:air}','serverBlockSeq':7,'serverObservedAt':REMOVED}
 with patch.object(db,'now_iso',return_value='2026-11-16T01:00:03+00:00'):
  journal.record(BINDING,'old',[{'taskId':'late','state':'succeeded','dimension':'minecraft:overworld','evidence':evidence}])
 assert journal.recall_places(BINDING,'oak')
 evidence={**evidence,'serverObservedAt':REMOVED+3000}
 journal.record(BINDING,'old',[{'taskId':'queued','state':'queued','dimension':'minecraft:overworld','evidence':evidence}])
 assert journal.recall_places(BINDING,'oak')


def test_capture_time_is_preserved_when_a_frame_arrives_after_a_mining_receipt():
 with patch.object(db,'now_iso',return_value='2026-11-16T01:00:03+00:00'):
  journal.observe_visit(BINDING,{**BINDING,'dimension':'minecraft:overworld','x':1,'y':64,'z':0,
    'observedAt':REMOVED-1000,'visibleLandmarks':[marker()],'visibleBlocks':[]})
 journal.apply_block_facts(BINDING,[fact()])
 assert journal.recall_places(BINDING,'oak')==[]


def test_explicit_fact_account_must_match_the_original_binding():
 with patch.object(db,'now_iso',return_value=SEEN):visit(markers=[marker()])
 assert journal.apply_block_facts(BINDING,[fact(account='another-player')])==0
 assert journal.recall_places(BINDING,'oak')
