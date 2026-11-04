"""Own-client Microsoft device flow; no official launcher client IDs or offline fallback."""
import json
import os
from pathlib import Path
import re
import time
import stat
import uuid
import httpx

AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/'
SCOPE = 'XboxLive.signin offline_access'

class MinecraftAuthError(ValueError): pass

class MinecraftAuth:
    def __init__(self, client_id, credential_path, http=None, clock=time.time):
        try: self.client_id = str(uuid.UUID(client_id))
        except (ValueError, TypeError): raise MinecraftAuthError('An owned Microsoft public client ID is required') from None
        self.path = Path(credential_path)
        self.http = http or httpx.Client(timeout=15, follow_redirects=False)
        self.clock = clock
        self.pending = None
        self.cached = None

    def _request(self, method, url, **kwargs):
        try:
            result = self.http.request(method,url,**kwargs)
            data = result.json()
            if result.status_code >= 400 and 'error' not in data: raise MinecraftAuthError('Identity provider rejected request')
            return data
        except (httpx.HTTPError, ValueError, KeyError): raise MinecraftAuthError('Identity provider request failed') from None

    def begin(self):
        data = self._request('POST',AUTH+'devicecode',data={'client_id':self.client_id,'scope':SCOPE})
        if 'device_code' not in data: raise MinecraftAuthError('Device authorization unavailable')
        self.pending = {**data,'deadline':self.clock()+min(int(data['expires_in']),900),'next':self.clock()+max(int(data.get('interval',5)),5)}
        return {'userCode':data['user_code'],'verificationUri':data['verification_uri'],'expiresIn':min(int(data['expires_in']),900)}

    def poll(self):
        p = self.pending
        if not p or self.clock() >= p['deadline']:
            self.pending = None
            raise MinecraftAuthError('Device authorization expired')
        if self.clock() < p['next']: return {'status':'pending'}
        p['next'] = self.clock()+max(int(p.get('interval',5)),5)
        data = self._request('POST',AUTH+'token',data={'client_id':self.client_id,'grant_type':'urn:ietf:params:oauth:grant-type:device_code','device_code':p['device_code']})
        if data.get('error') in ('authorization_pending','slow_down'):
            if data['error']=='slow_down': p['interval']=int(p.get('interval',5))+5; p['next']=self.clock()+p['interval']
            return {'status':'pending'}
        self.pending = None
        session = self._exchange(data)
        return {'status':'authenticated','profile':session['profile']}

    def _exchange(self, oauth):
        if not oauth.get('access_token'): raise MinecraftAuthError('Microsoft authorization rejected')
        xbox = self._request('POST','https://user.auth.xboxlive.com/user/authenticate',json={'Properties':{'AuthMethod':'RPS','SiteName':'user.auth.xboxlive.com','RpsTicket':'d='+oauth['access_token']},'RelyingParty':'http://auth.xboxlive.com','TokenType':'JWT'})
        if not xbox.get('Token'): raise MinecraftAuthError('Xbox authentication unavailable')
        xsts = self._request('POST','https://xsts.auth.xboxlive.com/xsts/authorize',json={'Properties':{'SandboxId':'RETAIL','UserTokens':[xbox['Token']]},'RelyingParty':'rp://api.minecraftservices.com/','TokenType':'JWT'})
        try: identity = 'XBL3.0 x='+xsts['DisplayClaims']['xui'][0]['uhs']+';'+xsts['Token']
        except (KeyError,IndexError,TypeError): raise MinecraftAuthError('Xbox authorization rejected') from None
        mc = self._request('POST','https://api.minecraftservices.com/authentication/login_with_xbox',json={'identityToken':identity})
        if not mc.get('access_token'): raise MinecraftAuthError('Minecraft authentication rejected')
        headers = {'Authorization':'Bearer '+mc['access_token']}
        ownership = self._request('GET','https://api.minecraftservices.com/entitlements/mcstore',headers=headers)
        if not any(i.get('name') in ('game_minecraft','product_minecraft') for i in ownership.get('items',[])): raise MinecraftAuthError('Minecraft Java entitlement required')
        profile = self._request('GET','https://api.minecraftservices.com/minecraft/profile',headers=headers)
        if not re.fullmatch('[0-9a-fA-F]{32}',profile.get('id','')) or not re.fullmatch('[A-Za-z0-9_]{1,16}',profile.get('name','')): raise MinecraftAuthError('Minecraft Java profile unavailable')
        session = {'accessToken':mc['access_token'],'profile':{'id':profile['id'],'name':profile['name']},'expiresAt':self.clock()+min(int(mc.get('expires_in',0)),86400)}
        self.cached = session
        if oauth.get('refresh_token'):
            self.path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            if self.path.is_symlink(): raise MinecraftAuthError('Credential path must be private')
            temp = self.path.with_name(self.path.name+'.'+uuid.uuid4().hex)
            fd = os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'w') as out: json.dump({'clientId':self.client_id,'refreshToken':oauth['refresh_token'],'profile':session['profile']},out)
            os.replace(temp,self.path)
        return session

    def _stored(self):
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd) as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 65536:
                    raise MinecraftAuthError('Credential file must be private')
                stored = json.load(stream)
            if stored.get('clientId') != self.client_id or not isinstance(stored.get('refreshToken'), str) or not stored['refreshToken']:
                raise MinecraftAuthError('Sign in required for configured client')
            return stored
        except (OSError, ValueError, TypeError, AttributeError):
            raise MinecraftAuthError('Sign in required') from None

    def remembered(self):
        """Previously verified identity only; not current entitlement/session validity."""
        try:
            stored = self._stored()
            profile = stored.get('profile', {})
            if not re.fullmatch('[0-9a-fA-F]{32}', profile.get('id','')) or not re.fullmatch('[A-Za-z0-9_]{1,16}', profile.get('name','')):
                return None
            return {'id':profile['id'], 'name':profile['name']}
        except (MinecraftAuthError, TypeError, AttributeError):
            return None

    def session(self):
        if self.cached and self.cached['expiresAt'] > self.clock()+60: return self.cached
        stored = self._stored()
        oauth = self._request('POST',AUTH+'token',data={'client_id':self.client_id,'grant_type':'refresh_token','refresh_token':stored['refreshToken'],'scope':SCOPE})
        try:
            return self._exchange(oauth)
        except MinecraftAuthError as error:
            # Transient network failures preserve remembered login for retry.
            # Rejected credentials or entitlement/profile checks require login.
            if str(error) != 'Identity provider request failed':
                self.logout()
            raise

    def logout(self):
        self.pending = self.cached = None
        self.path.unlink(missing_ok=True)
        return {'status':'signed_out'}
