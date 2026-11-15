import concurrent.futures
import io
import json
from types import SimpleNamespace

import pytest
from app.core.plugin_host import HostError,PluginHost
from app.services import computer_tools

DETAIL={'path':'args.steps[0].args.hotbar','rule':'integer','minimum':0,'maximum':8}

def received(error):
 host=PluginHost('validation-test',lambda *_:None,lambda:1)
 future=concurrent.futures.Future();host.pending['x']=future
 host.process=SimpleNamespace(stdout=io.StringIO(json.dumps({'v':1,'id':'x','ok':False,'error':error})+'\n'))
 host._reader()
 return future.exception(timeout=.1)

def test_only_bounded_minecraft_schema_detail_survives_the_actual_pipe_reader():
 error=received({'code':'MINECRAFT_INPUT','validation':DETAIL,'message':'secret transport message'})
 assert str(error)=='MINECRAFT_INPUT'
 assert error.validation==DETAIL
 assert 'secret' not in str(error)

@pytest.mark.parametrize('change',[
 {'rule':[]}, {'path':[]}, {'path':'secret\ntext'}, {'path':'x'*161}, {'rule':'run this command'}, {'minimum':'secret'},
 {'choices':['private\ntext']}, {'privateToken':'never copy this'},
])
def test_arbitrary_diagnostics_are_not_projected_as_schema_detail(change):
 error=received({'code':'MINECRAFT_INPUT','validation':{**DETAIL,**change}})
 assert error.validation is None

def test_unknown_transport_error_never_presents_schema_recovery():
 error=received({'code':'MINECRAFT_UNKNOWN','validation':DETAIL})
 assert error.validation is None

def test_model_tool_receives_exact_field_bounds_with_original_known_rejection(monkeypatch):
 from app.services.minecraft import minecraft
 error=received({'code':'MINECRAFT_INPUT','validation':DETAIL})
 monkeypatch.setattr(computer_tools,'require_local',lambda **_:None)
 def reject(*_):raise error
 monkeypatch.setattr(minecraft,'execute',reject)
 result=json.loads(computer_tools.execute('minecraft_action',{'action':'submit','taskId':'bad-slot','skill':'selectItem','args':{'item':'minecraft:stone','hotbar':36}}))
 assert result['ok'] is False and result['code']=='MINECRAFT_INPUT'
 assert result['validation']==DETAIL
 assert 'nothing ran' in result['error']
