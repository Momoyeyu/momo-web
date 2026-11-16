import copy
import json
from unittest.mock import patch
import pytest
from app.services import minecraft_journal as journal

BINDING={'world':'build-world','account':'player'}
GOAL={'title':'休息处','reason':'想歇脚','source':'rest','expected':'有门和顶的空间','status':'active'}
CELLS=[{'x':10,'y':64,'z':20,'block':'minecraft:dirt'},
       {'x':12,'y':66,'z':23,'block':'minecraft:oak_planks'}]

def build(binding=BINDING,activity='original',task_id='walls',cells=CELLS,skill='build'):
 args={'cells':copy.deepcopy(cells)}
 if skill=='plan':args={'steps':[{'skill':'wait','args':{'ticks':20}},{'skill':'build','args':args}]}
 journal.prepare_dispatch(binding,activity,{'taskId':task_id,'skill':skill,'args':args})

def test_build_plan_index_recalls_original_intent_beyond_recent_tasks_without_claiming_completion():
 journal.set_goal(BINDING,GOAL);build()
 for index in range(100):journal.prepare_dispatch(BINDING,'later',{'taskId':f'walk-{index}','skill':'navigate','args':{'x':index}})
 before=journal.history(BINDING,activity='original',task_id='walls')
 result=journal.build_plans(BINDING)
 assert result['nextCursor'] is None and len(result['buildPlans'])==1
 plan=result['buildPlans'][0]
 assert plan=={'activityId':'original','taskId':'walls','state':'unknown','dispatch':'pending',
               'partCount':1,'requestedCells':2,'bounds':{'min':{'x':10,'y':64,'z':20},'max':{'x':12,'y':66,'z':23}}}
 assert journal.history(BINDING,activity='original',task_id='walls')==before
 assert before[0]['request']['args']['cells']==CELLS


def test_build_history_bounds_each_scan_and_seek_continuation_is_stable_when_new_work_arrives():
 journal.set_goal(BINDING,GOAL);build(task_id='original-layout')
 for index in range(300):journal.prepare_dispatch(BINDING,'walks',{'taskId':f'w{index}','skill':'navigate','args':{'x':index}})
 first=journal.build_plans(BINDING)
 assert first['buildPlans']==[], 'A sparse history page must stop scanning before decoding the entire lifetime journal'
 cursor=first['nextCursor'];assert type(cursor) is int and cursor>0
 build(activity='new',task_id='new-layout')
 second=journal.build_plans(BINDING,cursor)
 third=journal.build_plans(BINDING,second['nextCursor'])
 assert second['buildPlans']==[]
 assert [p['taskId'] for p in third['buildPlans']]==['original-layout']
 assert third['nextCursor'] is None
 assert journal.build_plans(BINDING)['buildPlans'][0]['taskId']=='new-layout'

def test_build_index_is_goal_world_account_scoped_and_includes_nested_parts_with_pagination():
 journal.set_goal(BINDING,GOAL);build(task_id='old')
 journal.set_goal(BINDING,{**GOAL,'title':'另一个空间'})
 for index in range(8):build(activity='new',task_id=f'part-{index}',skill='plan')
 journal.record(BINDING,'new',[{'taskId':'part-0','skill':'plan','state':'failed','reason':'materials_missing','evidence':{}}])
 for binding in [{'world':'other','account':'player'},{'world':'build-world','account':'other'}]:
  journal.set_goal(binding,GOAL);build(binding=binding,task_id='private')
 first=journal.build_plans(BINDING);second=journal.build_plans(BINDING,first['nextCursor'])
 assert [p['taskId'] for p in first['buildPlans']]==[f'part-{index}' for index in range(7,1,-1)]
 assert [p['taskId'] for p in second['buildPlans']]==['part-1','part-0']
 assert type(first['nextCursor']) is int and first['nextCursor']>0 and second['nextCursor'] is None
 assert all(p['partCount']==1 and p['requestedCells']==2 for p in first['buildPlans'])
 assert journal.build_plans({'world':'absent','account':'player'})=={'buildPlans':[],'nextCursor':None}

def test_build_index_read_retains_permission_generation_and_does_not_dispatch_or_restore_control():
 from tests.test_minecraft_tasks import setup
 m,runtime=setup();m.binding=BINDING
 journal.set_goal(BINDING,GOAL);build()
 with patch('app.services.minecraft.runtime',runtime),patch.object(m,'gate',return_value='cfg'):
  result=m.execute('task',{'query':'build'},0,'owner','lease')
  assert result['buildPlans'][0]['taskId']=='walls'
  runtime.host.request.assert_not_called()
  assert not m.tasks and not m.autonomous
  with pytest.raises(ValueError,match='revoked'):m.execute('task',{'query':'build'},99,'owner','lease')
  m.permissions=set()
  with pytest.raises(ValueError,match='denied'):m.execute('task',{'query':'build'},0,'owner','lease')


@pytest.mark.parametrize('intent',[
 {'skill':'build','args':{'cells':None}},
 {'skill':'build','args':{'cells':123}},
 {'skill':'plan','args':{'steps':[{'skill':'build','args':None}]}},
 {'skill':'plan','args':{'steps':{'skill':'build','args':{'cells':CELLS}}}},
 {'skill':'build','args':{'cells':[None,{'x':True,'y':64,'z':0,'block':'minecraft:dirt'}]}},
])
def test_rejected_malformed_intent_remains_inspectable_without_breaking_the_build_index(intent):
 journal.set_goal(BINDING,GOAL)
 journal.prepare_dispatch(BINDING,'bad',{'taskId':'bad',**intent})
 journal.dispatch_failed(BINDING,'bad','bad',rejected=True,reason='submission_rejected')
 result=journal.build_plans(BINDING)['buildPlans'][0]
 assert result['state']=='failed' and result['dispatch']=='rejected'
 assert result['requestedCells']==0 and result['bounds'] is None
 assert journal.history(BINDING,activity='bad',task_id='bad')[0]['request']==intent

def test_build_index_tool_api_propagate_query_without_pixels_and_refuse_ambiguous_selector():
 from app.services import computer_tools as tools
 from app.services.minecraft import minecraft
 from app.api.minecraft import TaskCommand,tasks
 reply={'buildPlans':[],'nextCursor':None}
 with patch.object(tools,'require_local',return_value='r'),patch.object(minecraft,'execute',return_value=reply) as execute,patch.object(tools,'stage') as stage:
  assert json.loads(tools.execute('minecraft_action',{'action':'task','query':'build:6'}))==reply
  assert execute.call_args.args[:2]==('task',{'query':'build:6'})
  assert tasks(TaskCommand(clientId='owner',leaseId='lease',generation=0,action='task',query='build:6'))==reply
  assert execute.call_args.args[:2]==('task',{'query':'build:6'})
  stage.assert_not_called()
 from tests.test_minecraft_tasks import setup
 m,runtime=setup()
 with patch('app.services.minecraft.runtime',runtime),patch.object(m,'gate',return_value='cfg'):
  for args in [{'query':'build','taskId':'walls'},{'query':'build','activityId':'a'},{'query':'build:-1'},{'query':'build:0'},{'query':'build:9223372036854775808'},{'query':'anything'}]:
   with pytest.raises(ValueError,match='Invalid'):m.execute('task',args,0,'owner','lease')
  runtime.host.request.assert_not_called()
