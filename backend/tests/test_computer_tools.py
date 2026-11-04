import base64
import io
import time
from unittest.mock import patch
import pytest
from PIL import Image
from app.services import computer_tools as tools, vision
from app.services.coordinator import current_run


def pixels():
    out=io.BytesIO(); Image.new('RGB',(32,32),'red').save(out,'PNG'); return out.getvalue()


def test_remote_and_wrong_run_cannot_use_local_tools():
    token=current_run.set('r')
    try:
        with patch.object(tools,'runtime') as runtime, patch.object(tools.checkpoint,'audience',return_value='owner'):
            runtime.started=True; runtime.valid_run.return_value=True
            runtime.focus=runtime.restoring=runtime.interrupt_hold=False
            runtime.activity={'runId':'r','source':'qq'}
            with pytest.raises(ValueError): tools.require_local()
            assert tools.declarations('qq') == []
            runtime.activity={'runId':'other','source':'meeting'}
            with pytest.raises(ValueError): tools.require_local()
            runtime.activity={'runId':'r','source':'meeting'}
            assert tools.require_local() == 'r'
    finally: current_run.reset(token)


def test_ephemeral_pixels_only_enter_private_provider_payload_once():
    token=current_run.set('r')
    cfg={'model':'test'}
    try:
        with patch.object(tools,'require_local',return_value='r'), patch.object(vision,'require_enabled'), patch.object(tools.state,'load',return_value={'settings':{'llm':cfg}}):
            tools.stage(pixels(),lambda:None)
            transcript=[{'role':'tool','content':'{"pixelsFollow":true}','tool_call_id':'c'}]
            payload=tools.project(transcript,cfg)
            assert len(transcript)==1
            url=payload[-1]['content'][1]['image_url']['url']
            data=base64.b64decode(url.split(',')[1])
            assert Image.open(io.BytesIO(data)).size == (32,32)
            assert tools.project(transcript,cfg) is transcript
            assert 'base64' not in str(transcript)
    finally: current_run.reset(token)


def test_revocation_between_tool_and_provider_discards_pixels():
    token=current_run.set('r')
    try:
        with patch.object(tools,'require_local',return_value='r'):
            allowed=[True]
            def validate():
                if not allowed[0]: raise ValueError('revoked')
            tools.stage(pixels(),validate)
            allowed[0]=False
            with pytest.raises(vision.VisionError,match='revoked'): tools.project([],{'model':'test'})
            assert 'r' not in tools._pending
    finally: current_run.reset(token)


def test_minecraft_frame_is_stripped_and_staged_not_serialized():
    import json
    from app.services.minecraft import minecraft
    data=pixels()
    frame='data:image/png;base64,'+base64.b64encode(data).decode()
    with patch.object(tools,'require_local',return_value='r'), patch.object(minecraft,'execute',return_value={'frame':frame,'observedAt':time.time()*1000,'world':'fixture'}), patch.object(tools,'stage') as stage:
        result=json.loads(tools.execute('minecraft_action',{'action':'observe'}))
        assert 'frame' not in result
        assert result['pixelsFollow']
        assert 'base64' not in json.dumps(result)
        assert stage.call_args.args[0]==data
