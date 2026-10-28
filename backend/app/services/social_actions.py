"""Reviewed QQ operation scopes; native results remain data, never instructions.

This module does not execute IO. The coordinator owns attention, command IDs,
permits and receipts; it calls this gate both before projection and dispatch.
"""
from __future__ import annotations
import base64
import copy
import re
import time

from .social import SocialError

ACTIONS = {
    'contacts.list': ('contacts',), 'history.list': ('history',),
    'private.send': ('proactive',), 'group.send': ('groups','proactive'),
    'media.send': ('media',), 'media.fetch': ('media','history'),
    'friends.listRequests': ('friendRequests',), 'friends.respond': ('friendRequests',),
    'groups.list': ('groups',), 'groups.members': ('groups','contacts'),
    'groups.manage': ('groups','groupManagement'),
}
MUTATIONS = {'private.send','group.send','media.send','friends.respond','groups.manage'}
OWNER_ONLY = {'contacts.list','private.send','group.send','friends.listRequests','friends.respond','groups.list','groups.manage'}
GROUP_OPERATIONS = {'setName','muteMember','kickMember','muteAll'}


def _id(value, name):
    if not isinstance(value,str) or not re.fullmatch(r'[1-9][0-9]{0,19}',value):
        raise SocialError('Invalid QQ ' + name)
    return value


def _token(value, name):
    if not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',value):
        raise SocialError('Invalid QQ ' + name)
    return value


def _text(value, name, limit=16000):
    if not isinstance(value,str) or not value.strip() or len(value)>limit or '\x00' in value:
        raise SocialError('Invalid QQ ' + name)
    return value


def _integer(value, name, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise SocialError('Invalid QQ ' + name)
    return value


def _params(action, values):
    if not isinstance(values,dict):
        raise SocialError('QQ operation arguments must be an object')
    allowed = {
        'contacts.list': {'limit','cursor'}, 'history.list': {'peerId','groupId','limit','beforeMessageId'},
        'private.send': {'peerId','text'}, 'group.send': {'peerId','groupId','text'},
        'media.send': {'peerId','groupId','mediaId','text'},
        'media.fetch': {'peerId','groupId','messageId','elementId'},
        'friends.listRequests': {'limit','cursor'}, 'friends.respond': {'requestId','peerId','approve','reason'},
        'groups.list': {'limit','cursor'}, 'groups.members': {'peerId','groupId','limit','cursor'},
        'groups.manage': {'peerId','groupId','operation','memberId','name','durationSeconds','enabled'},
    }[action]
    if set(values)-allowed:
        raise SocialError('Unreviewed QQ operation argument')
    params=copy.deepcopy(values)
    peer=None
    scoped=action in {'private.send','group.send','history.list','media.send','media.fetch','groups.members','groups.manage'}
    if scoped:
        if bool(params.get('peerId')) == bool(params.get('groupId')):
            raise SocialError('Choose exactly one QQ conversation')
        if params.get('groupId'):
            peer='group:'+_id(params.pop('groupId'),'group number')
        else:
            peer=params['peerId']
            if isinstance(peer,str) and peer.startswith('group:'):
                peer='group:'+_id(peer[6:],'group number')
            else:
                peer=_id(peer,'number')
        if action=='private.send' and peer.startswith('group:'):
            raise SocialError('A private QQ recipient is required')
        if action.startswith('group') and not peer.startswith('group:'):
            raise SocialError('A QQ group recipient is required')
        params['peerId']=peer
    if action in {'private.send','group.send'}:
        params['text']=_text(params.get('text'),'message')
    if action=='media.send':
        params['mediaId']=_token(params.get('mediaId'),'media reference')
        if 'text' in params:
            params['text']=_text(params['text'],'caption',1000)
    if action=='media.fetch':
        params['messageId']=_token(params.get('messageId'),'message reference')
        params['elementId']=_token(params.get('elementId'),'element reference')
    if action.endswith('.list') or action.endswith('.listRequests') or action=='groups.members':
        params['limit']=_integer(params.get('limit',50),'page limit',1,50)
    for name in ('cursor','beforeMessageId'):
        if name in params:
            params[name]=_token(params[name],name)
    if action=='friends.respond':
        request_id=params.get('requestId')
        if not isinstance(request_id,str) or not re.fullmatch(r'u_[A-Za-z0-9_-]{1,128}:[0-9]{1,20}',request_id):
            raise SocialError('Invalid QQ friend request reference')
        params['requestId']=request_id
        params['peerId']=_id(params.get('peerId'),'number')
        peer=params['peerId']
        if type(params.get('approve')) is not bool:
            raise SocialError('Choose whether to approve this friend request')
        if 'reason' in params:
            params['reason']=_text(params['reason'],'reason',120)
    if action=='groups.manage':
        operation=params.get('operation')
        if operation not in GROUP_OPERATIONS:
            raise SocialError('Unreviewed QQ group operation')
        expected={'peerId','operation'}
        if operation=='setName':
            expected.add('name');params['name']=_text(params.get('name'),'group name',60)
        elif operation in {'muteMember','kickMember'}:
            expected.add('memberId');params['memberId']=_id(params.get('memberId'),'member number')
            if operation=='muteMember':
                expected.add('durationSeconds');params['durationSeconds']=_integer(params.get('durationSeconds'),'mute duration',0,2592000)
        elif operation=='muteAll':
            expected.add('enabled')
            if type(params.get('enabled')) is not bool:
                raise SocialError('Choose group mute state')
        if set(params)!=expected:
            raise SocialError('Invalid arguments for this QQ group operation')
    return params,peer


def _proactive_check(account, peer, *, consume, command_id, require_recipient=True):
    policy=account['proactivePolicy']
    if require_recipient and peer not in policy['recipientIds']:
        raise SocialError('This contact is not allowed for proactive QQ messages')
    hour=time.localtime().tm_hour
    start,end=policy['quietStart'],policy['quietEnd']
    quiet=(start<=hour<end) if start<end else (hour>=start or hour<end) if start>end else False
    if quiet:
        raise SocialError('Proactive QQ messages are paused during quiet hours')
    now=time.time()
    attempts=[row for row in account.get('proactiveAttempts',[]) if isinstance(row,dict)
              and type(row.get('at')) in {int,float} and now-row['at']<3600]
    # Revalidating the same in-flight command is idempotent. Account scope,
    # grants, revision and quiet hours were still checked above this branch.
    prior=next((row for row in attempts if row.get('commandId')==command_id),None) if command_id else None
    if prior:
        if prior.get('peerId')!=peer:
            raise SocialError('QQ command recipient changed')
        return False
    if len(attempts)>=policy['maxPerHour']:
        raise SocialError('Proactive QQ hourly limit reached')
    last=account.get('lastProactiveAttemptAt',max((row['at'] for row in attempts),default=0))
    if type(last) in {int,float} and last>0 and now-last<policy['minIntervalSeconds']:
        raise SocialError('Wait before sending another proactive QQ message')
    if consume:
        _token(command_id,'command reference')
        account['proactiveAttempts']=[*attempts,{'commandId':command_id,'peerId':peer,'at':now}]
        account['lastProactiveAttemptAt']=now
        return True
    return False


def authorize_action(store, action, params, *, account_id=None, revision=None, audience='owner', local_owner=False, consume=False, command_id=None):
    if action not in ACTIONS:
        raise SocialError('Unreviewed QQ operation')
    params,peer=_params(action,params)
    if type(local_owner) is not bool or type(consume) is not bool:
        raise SocialError('Invalid QQ admission context')
    # Only a locally admitted run may opt into owner tools. A linked remote
    # owner has private memory authority, not account-management authority.
    if action in OWNER_ONLY and not local_owner:
        raise SocialError('This QQ operation requires a local owner turn')
    if local_owner and audience!='owner':
        raise SocialError('Local QQ tools require owner audience')
    with store.lock:
        data=store._read();account=data.get('qq',store._default('qq'))
        if (not account['enabled'] or account.get('quarantined') or not account.get('expectedSelfId')
            or account_id is not None and account['accountId']!=account_id
            or revision is not None and account['policyRevision']!=revision):
            raise SocialError('QQ account or authorization revision changed')
        if any(account['permissions'].get(grant) is not True for grant in ACTIONS[action]):
            raise SocialError('QQ operation permission is not granted')
        if peer:
            if peer==account['expectedSelfId'] or not store._scope_allowed(account,peer):
                raise SocialError('QQ conversation is outside the authorized scope')
            if not local_owner and store._audience(account,peer)!=audience:
                raise SocialError('QQ operation cannot access another conversation')
        if action=='media.send':
            if not local_owner:
                # A remote reply may attach only within its same proven scope;
                # unsolicited sends are reserved for locally admitted tools.
                if not account['permissions']['reply']:
                    raise SocialError('QQ reply permission is not granted')
            elif not account['permissions']['proactive']:
                raise SocialError('Proactive QQ permission is not granted')
            if peer.startswith('group:') and not account['permissions']['groups']:
                raise SocialError('QQ group permission is not granted')
        if action=='groups.manage' and params.get('memberId')==account['expectedSelfId']:
            raise SocialError('QQ group management cannot target this account')
        proactive=action in {'private.send','group.send'} or action=='media.send' and local_owner
        if proactive and _proactive_check(account,peer,consume=consume,command_id=command_id,require_recipient=not peer.startswith('group:')):
            data['qq']=account;store._write(data)
        result={'pluginId':account['id'],'accountId':account['accountId'], 'expectedSelfId':account['expectedSelfId'],
                'policyRevision':account['policyRevision'],'action':action,'params':params,'peerId':peer,
                'audience':store._audience(account,peer) if peer else 'owner','localOwner':local_owner}
        return result


def _public_row(row, fields):
    if not isinstance(row,dict):
        return None
    result={}
    for key in fields:
        value=row.get(key)
        if isinstance(value,str):
            result[key]=value[:16000 if key=='text' else 160]
        elif type(value) in {int,float,bool}:
            result[key]=value
    return result


def filter_action_result(store, authorization, result):
    """Bound and redact native query replies after rechecking the current grants."""
    if not isinstance(result,dict):
        raise SocialError('Invalid QQ operation result')
    action=authorization['action']
    if action in MUTATIONS:
        # A real provider outcome remains a fact after permission changes. Do
        # not re-charge proactive limits or erase a late delivery receipt here.
        output={key:result[key][:160] for key in ('status','deliveryStatus','externalMessageId','messageId','requestId','groupId','peerId') if isinstance(result.get(key),str)}
        if type(result.get('approved')) is bool:output['approved']=result['approved']
        receipt=result.get('receipt')
        if isinstance(receipt,dict):
            output['receipt']={key:value[:160] for key,value in receipt.items() if key in {
                'commandId','status','deliveryStatus','externalMessageId','runId'} and isinstance(value,str)}
        return output
    auth=authorize_action(store,action,authorization['params'],
        account_id=authorization['accountId'],revision=authorization['policyRevision'],
        audience='owner' if authorization['localOwner'] else authorization['audience'],local_owner=authorization['localOwner'])
    def page(key):
        rows=result.get(key,[])
        if not isinstance(rows,list):
            raise SocialError('Invalid QQ result page')
        return rows[:auth['params'].get('limit',50)]
    with store.lock:
        account=store._account('qq')
        if action=='contacts.list':
            rows=page('contacts')
            items=[_public_row(row,('peerId','name','remark')) for row in rows[:100] if isinstance(row,dict) and store._peer_allowed(account,row.get('peerId'))]
            key='contacts'
        elif action=='groups.list':
            rows=page('groups')
            items=[]
            for row in rows:
                if not isinstance(row,dict):
                    continue
                peer=row.get('peerId')
                group_id=peer[6:] if isinstance(peer,str) and peer.startswith('group:') else row.get('groupId')
                if store._group_allowed(account,group_id):
                    items.append({**_public_row(row,('name','memberCount','role')), 'peerId':'group:'+group_id})
            key='groups'
        elif action=='friends.listRequests':
            rows=page('requests')
            items=[_public_row(row,('requestId','peerId','name','message','at')) for row in rows[:100] if isinstance(row,dict) and store._peer_allowed(account,row.get('peerId'))]
            key='requests'
        elif action=='groups.members':
            rows=page('members')
            items=[_public_row(row,('peerId','name','card','role')) for row in rows[:100]]
            key='members'
        elif action=='history.list':
            rows=page('messages')
            remaining_text=32000
            items=[]
            for row in rows:
                if authorization.get('peerId','').startswith('group:') and account['allowlistEnabled'] and (not isinstance(row,dict) or row.get('senderId')!=account['expectedSelfId'] and not store._peer_allowed(account,row.get('senderId'))):
                    continue
                clean=_public_row(row,('messageId','senderId','text','at','time'))
                if clean is None:
                    continue
                if isinstance(clean.get('text'),str):
                    clean['text']=clean['text'][:remaining_text]
                    remaining_text-=len(clean['text'])
                attachments=row.get('attachments',[])
                if not isinstance(attachments,list):
                    raise SocialError('Invalid QQ attachment references')
                refs=[]
                if account['permissions'].get('media'):
                    for item in attachments[:10]:
                        if (not isinstance(item,dict) or not isinstance(item.get('elementId'),str)
                            or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',item['elementId'])
                            or item.get('kind') not in {'image','audio','video','file'}):
                            continue
                        ref=_public_row(item,('elementId','kind','name','mime','size'))
                        if type(ref.get('size',0)) is not int or not 0<=ref.get('size',0)<=10*1024*1024:
                            continue
                        refs.append(ref)
                if refs:
                    clean['attachments']=refs
                items.append(clean)
            key='messages'
        elif action=='media.fetch':
            encoded=result.get('dataBase64')
            if not isinstance(encoded,str) or len(encoded)>14*1024*1024:
                raise SocialError('Invalid QQ media result')
            try:
                size=len(base64.b64decode(encoded,validate=True))
            except (ValueError,TypeError):
                raise SocialError('Invalid QQ media result') from None
            if size>10*1024*1024 or 'size' in result and result['size']!=size:
                raise SocialError('Invalid QQ media result')
            return {**_public_row(result,('name','mime')), 'size':size, 'dataBase64':encoded}
        else:
            raise SocialError('Unreviewed QQ result')
        if not isinstance(rows,list):
            raise SocialError('Invalid QQ result page')
        output={key:[row for row in items if row is not None]}
        cursor=result.get('cursor')
        if isinstance(cursor,str) and re.fullmatch(r'[A-Za-z0-9_-]{1,160}',cursor):
            output['cursor']=cursor
        return output
