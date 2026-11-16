import copy
import pytest
from app.services.turn import ContextMessages
from app.services.context_policy import Budget, estimate_request
from app.services.prefix_budget import MeasuredPrefixes


CFG={'model':'fixture','contextWindow':16000,'maxOutputTokens':2000}
TOOLS=[{'type':'function','function':{'name':'look','description':'Read current state'}}]
SCOPE=('isolated-data','owner',7)


def test_identical_headers_reuse_a_whole_measured_request_as_an_upper_bound():
    cache=MeasuredPrefixes()
    header={'role':'system','content':'H'*10000}
    cache.remember([header,{'role':'user','content':'private old input'}],CFG,TOOLS,SCOPE,3500)
    messages=ContextMessages([copy.deepcopy(header),{'role':'user','content':'N'*8000}])
    original=copy.deepcopy(list(messages))
    assert estimate_request(messages,TOOLS)>Budget.from_config(CFG).safe
    assert cache.restore(messages,CFG,TOOLS,SCOPE)
    assert estimate_request(messages,TOOLS)<=Budget.from_config(CFG).safe
    assert messages.usage_anchor[2]==3500, 'Do not subtract the old suffix, images or tools from the measured total'
    assert messages.usage_anchor[0]==[header]
    assert list(messages)==original and 'private old input' not in str(messages)


@pytest.mark.parametrize('change',['header','model','key','tools','audience','generation','data'])
def test_changed_prefix_or_calibration_scope_cannot_borrow_the_old_measurement(change):
    cache=MeasuredPrefixes();header={'role':'system','content':'H'*10000}
    cache.remember([header],CFG,TOOLS,SCOPE,3500)
    messages=ContextMessages([copy.deepcopy(header),{'role':'user','content':'N'*8000}])
    cfg=copy.deepcopy(CFG);tools=copy.deepcopy(TOOLS);scope=SCOPE
    if change=='header':messages[0]['content']+='changed'
    if change=='model':cfg['model']='different'
    if change=='key':cfg['key']='new-credential'
    if change=='tools':tools[0]['function']['description']='A different schema'
    if change=='audience':scope=('isolated-data','contact',7)
    if change=='generation':scope=('isolated-data','owner',8)
    if change=='data':scope=('different-data','owner',7)
    assert not cache.restore(messages,cfg,tools,scope)
    assert not hasattr(messages,'usage_anchor')


@pytest.mark.parametrize('tokens',[None,0,-1,True,'3500',float('inf')])
def test_unusable_usage_is_not_a_calibration(tokens):
    cache=MeasuredPrefixes();header={'role':'system','content':'H'*10000}
    cache.remember([header],CFG,TOOLS,SCOPE,tokens)
    assert not cache.restore(ContextMessages([header]),CFG,TOOLS,SCOPE)


def test_mutating_old_messages_does_not_mutate_the_recorded_prefix():
    cache=MeasuredPrefixes();header={'role':'system','content':'H'*10000}
    cache.remember([header],CFG,TOOLS,SCOPE,3500)
    header['content']='new private text'
    original=ContextMessages([{'role':'system','content':'H'*10000}])
    assert cache.restore(original,CFG,TOOLS,SCOPE)
    assert not cache.restore(ContextMessages([header]),CFG,TOOLS,SCOPE)


def test_expired_calibration_does_not_reduce_the_budget():
    now=[1.0];cache=MeasuredPrefixes(ttl=10,clock=lambda:now[0])
    header={'role':'system','content':'H'*10000};cache.remember([header],CFG,TOOLS,SCOPE,3500)
    now[0]=12
    assert not cache.restore(ContextMessages([header]),CFG,TOOLS,SCOPE)


def test_a_tighter_current_round_anchor_is_preserved():
    cache=MeasuredPrefixes();header={'role':'system','content':'H'*10000}
    cache.remember([header],CFG,TOOLS,SCOPE,7000)
    messages=ContextMessages([header,{'role':'user','content':'N'*1000}])
    messages.usage_anchor=(copy.deepcopy(list(messages)),copy.deepcopy(TOOLS),2000)
    anchor=messages.usage_anchor
    assert not cache.restore(messages,CFG,TOOLS,SCOPE)
    assert messages.usage_anchor is anchor


def test_new_system_messages_and_new_images_remain_fully_charged():
    cache=MeasuredPrefixes();header={'role':'system','content':'H'*10000}
    cache.remember([header,{'role':'system','content':'Old world'}],CFG,TOOLS,SCOPE,3500)
    messages=ContextMessages([header,{'role':'system','content':'New world '*500}])
    assert cache.restore(messages,CFG,TOOLS,SCOPE)
    image=[{'role':'user','content':[{'type':'image_url','image_url':{'url':'pending'},'vision_tokens':8192}]}]
    assert estimate_request(messages,TOOLS,extra_messages=image)>Budget.from_config(CFG).safe
