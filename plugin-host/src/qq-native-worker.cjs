// Original, narrow QQ native client. No NapCat bootstrap, bypasses or signer.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { syncBuiltinESMExports } = require('node:module');
const PIN = Object.freeze({ fullVersion: '6.9.95-48517', appid: '537352498', qua: 'V1_MAC_NQ_6.9.95_48517_GW_B' });
const isId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
const isUid = value => typeof value === 'string' && /^u_[A-Za-z0-9_-]{1,128}$/.test(value);
const issue = code => Object.assign(new Error(code), { code });
const safeAttempt = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(value);

function createNativeWorker({ api, dataRoot, send, now = Date.now, onIdentity = () => {} }) {
  const startedAt=now();
  let attemptId = null, expectedSelfId = null, active = false, prepared = false, sessionReady = false, startupComplete = false;
  let nativeDisconnected = false, everMsfConnected = false;
  let misc, engine, login, startup, session, self, connected = false, connectResolve;
  let connectPromise, stopped = false, identityCheck = null;
  let restoreSession = true, transportReady = false, restoring = false, qrRequested = false;
  const seen = new Set(), outgoing = new Map(), operationStates = new Map(), abandonedDownloads = new Set();
  // Keep callbacks alive for this worker, including unused native SDK slots.
  // No payload from an unused callback is logged or interpreted as success.
  const listeners = new Set();
  const retainListener = callbacks => {
    const listener = new Proxy(callbacks, { get: (target, key) => Reflect.get(target, key) ?? notify });
    listeners.add(listener);
    return listener;
  };
  const emit = (event, data) => send({ event, data: { attemptId, ...data } });
  const state = (status, code) => { if (active) emit('state', { status, ...(code ? { code } : {}) }); };
  const bound = callback => (...args) => { if (active && !stopped) return callback(...args); };
  const notify = () => {};
  // Original, finite milestones only. Never include a native callback payload,
  // account identifier, QR code, path, ticket or arbitrary error message.
  const diagnostic = (phase, code) => { try { send({event:'diagnostic',data:{attemptId,phase,elapsedMs:Math.min(86400000,Math.max(0,now()-startedAt)),...(Number.isSafeInteger(code)?{code}:{})}}); } catch {} };
  const requireAttempt = value => { if (!active || stopped || value !== attemptId) throw issue('ATTEMPT_CANCELLED'); };
  const wire = data => send({ event: 'onebot', data });
  const isFriend = uid => { try { return session.getBuddyService().isBuddy(uid) === true; } catch { return false; } };
  const reply = (echo, result, failed = false) => wire({ echo, status: failed ? 'failed' : 'ok', retcode: failed ? 1 : 0, data: result });
  const fail = code => { state('error', code); active = false; connected = false; if (connectResolve) { connectResolve({ attemptId }); connectResolve = null; } };

  function messageStatus(records) {
    diagnostic('outbound_update', Array.isArray(records) ? records.length : -1);
    if (!Array.isArray(records)) return;
    const outcomes = new Map();
    const data = (record, key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor && !('value' in descriptor)) throw issue('INPUT');
      return descriptor?.value;
    };
    for (let index = 0; index < records.length; index++) {
      try {
        const record = records[index];
        if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
        const key = data(record, 'guildId'), pending = outgoing.get(key);
        if (!pending || pending.done || data(record, 'senderUid') !== self?.uid || data(record, 'peerUid') !== pending.peerUid) continue;
        const chatType = data(record, 'chatType'), status = data(record, 'sendStatus');
        if (chatType !== undefined && chatType !== (pending.chatType??1)) continue;
        if (status === 2) {
          const messageId = data(record, 'msgId');
          if (typeof messageId !== 'string' || !messageId || messageId.length > 200) continue;
          if (!outcomes.get(key)?.messageId) outcomes.set(key, { pending, messageId });
        } else if (status === 0 && !outcomes.has(key)) outcomes.set(key, { pending });
      } catch { /* Malformed native rows cannot settle an admitted operation. */ }
    }
    // Inspect the whole batch before settling: a genuine matched success wins
    // over failure rows, and its first valid receipt retains the command echo.
    for (const [key, outcome] of outcomes) {
      const { pending, messageId } = outcome;
      if (outgoing.get(key) !== pending || pending.done) continue;
      pending.done = true; outgoing.delete(key);
      if(pending.stagedFile)try{fs.rmSync(pending.stagedFile,{force:true});}catch{}
      reply(pending.echo, messageId ? { message_id: messageId } : {}, !messageId);
    }
  }
  const inboundQueue = [];
  let inboundRunning = false;
  const missingUin = value => value === undefined || (typeof value === 'string' && (value === '' || /^0+$/.test(value)));
  const incomingCurrent = value => active && connected && !stopped && !nativeDisconnected && attemptId === value.attemptId && self === value.self;
  const incomingKey = value => `in:${value.chatType??1}:${value.peerUin??value.uid}:${value.msgId}`;
  async function drainIncoming() {
    if (inboundRunning) return;
    inboundRunning = true;
    try {
      while (inboundQueue.length) {
        const value = inboundQueue.shift();
        if (!incomingCurrent(value)) { inboundQueue.length = 0; return; }
        if (seen.has(incomingKey(value))) { diagnostic('inbound_rejected', 10); continue; }
        if(value.extended){
          let sender=value.senderUin;
          if(!isId(sender)||value.chatType===2){try{const resolved=await session.getUixConvertService().getUin([value.senderUid]),canonical=resolved?.uinInfo?.get(value.senderUid);if(isId(sender)&&sender!==canonical)continue;sender=canonical;}catch{continue;}}
          if(!incomingCurrent(value)||!isId(sender)||sender===self.uin)continue;
          if(value.chatType===2){try{const rows=await groupsNow(()=>{if(!incomingCurrent(value))throw issue('ATTEMPT_CANCELLED');});if(!rows.some(row=>row.groupCode===value.peerUin))continue;}catch{continue;}}
          else if(!isFriend(value.uid)||isId(value.peerUin)&&sender!==value.peerUin)continue;
          if(!incomingCurrent(value))continue;
          if(seen.size>=10000){inboundQueue.length=0;fail('INBOX_CAPACITY');return;}
          seen.add(incomingKey(value));
          const parts=[...(value.text?[{type:'text',data:{text:value.text}}]:[]),...value.attachments.map(item=>({type:item.kind,data:{element_id:item.elementId,name:item.name,size:item.size,message_id:value.msgId}}))];
          wire({post_type:'message',message_type:value.chatType===2?'group':'private',sub_type:value.chatType===2?'normal':'friend',time:value.timestamp,self_id:self.uin,user_id:sender,...(value.chatType===2?{group_id:value.peerUin}:{}),sender:{user_id:sender},message_id:value.msgId,raw_message:value.text,message:parts});
          continue;
        }
        let peerUin = value.peerUin, senderUin = value.senderUin;
        if (!isId(peerUin) || !isId(senderUin)) {
          let timer;
          try {
            // Exact native UixConvert result; never fall back to profile caches
            // or invent numeric identities for an unresolved peer.
            const result = await Promise.race([
              session.getUixConvertService().getUin([value.uid]),
              new Promise((_, reject) => { timer = setTimeout(() => reject(issue('IDENTITY_UNVERIFIED')), 10000); timer.unref?.(); }),
            ]);
            if (!incomingCurrent(value)) { inboundQueue.length = 0; return; }
            const resolved = result?.uinInfo instanceof Map ? result.uinInfo.get(value.uid) : undefined;
            if (!isId(resolved)) { diagnostic('inbound_rejected', 11); continue; }
            if ((isId(peerUin) && peerUin !== resolved) || (isId(senderUin) && senderUin !== resolved)) { diagnostic('inbound_rejected', 3); continue; }
            peerUin = resolved; senderUin = resolved;
          } catch { diagnostic('inbound_rejected', 11); continue; }
          finally { clearTimeout(timer); }
        }
        if (!incomingCurrent(value)) { inboundQueue.length = 0; return; }
        if (peerUin !== senderUin) { diagnostic('inbound_rejected', 3); continue; }
        if (senderUin === self.uin || value.uid === self.uid) { diagnostic('inbound_rejected', 4); continue; }
        if (!isFriend(value.uid)) { diagnostic('inbound_rejected', 6); continue; }
        if (!incomingCurrent(value)) { inboundQueue.length = 0; return; }
        if (seen.size >= 10000) { inboundQueue.length = 0; fail('INBOX_CAPACITY'); return; }
        seen.add(incomingKey(value));
        diagnostic('inbound_accepted');
        wire({ post_type: 'message', message_type: 'private', sub_type: 'friend', time: value.timestamp, self_id: self.uin, user_id: peerUin, sender: { user_id: senderUin }, message_id: value.msgId, raw_message: value.text, message: [{ type: 'text', data: { text: value.text } }] });
      }
    } finally { inboundRunning = false; }
  }
  function incoming(records) {
    diagnostic('inbound_batch', Array.isArray(records) ? records.length : -1);
    if (!active || !connected || !Array.isArray(records)) { diagnostic('inbound_rejected', 0); return; }
    for (const record of records) {
      // Include the one in-flight lookup. Only captured, bounded text is queued;
      // a burst cannot retain arbitrary native arrays or an unlimited backlog.
      if (inboundQueue.length + (inboundRunning ? 1 : 0) >= 64) { diagnostic('inbound_rejected', 12); break; }
      try {
        if(record&&(record.chatType===2||record.chatType===1&&Array.isArray(record.elements)&&record.elements.some(item=>[2,3,4,5].includes(item?.elementType)))){
          const chatType=record.chatType,uid=record.peerUid,senderUid=record.senderUid;
          if(!isUid(senderUid)||senderUid===self.uid||chatType===2&&!isId(uid)||chatType===1&&(!isUid(uid)||uid!==senderUid||!isFriend(uid)))continue;
          const peerUin=chatType===2?uid:record.peerUin;if(!isId(peerUin)&&!(chatType===1&&missingUin(peerUin)))continue;
          const content=normalizedElements(record.elements),timestamp=Number(record.msgTime),msgId=record.msgId;
          if(typeof msgId!=='string'||!msgId||msgId.length>200||!Number.isSafeInteger(timestamp)||timestamp<0||timestamp>Math.floor(now()/1000)+300||!content.text.trim()&&!content.attachments.length)continue;
          const value={attemptId,self,uid,senderUid,peerUin,senderUin:record.senderUin,msgId,timestamp,chatType,extended:true,...content};
          if(seen.has(incomingKey(value)))continue;inboundQueue.push(value);void drainIncoming().catch(()=>{inboundQueue.length=0;});continue;
        }
        if (!record || record.chatType !== 1) { diagnostic('inbound_rejected', 1); continue; }
        const peerUin = record.peerUin, senderUin = record.senderUin, uid = record.peerUid, senderUid = record.senderUid;
        const rejected = (!isId(peerUin) && !missingUin(peerUin)) || (!isId(senderUin) && !missingUin(senderUin)) ? 2 : isId(peerUin) && isId(senderUin) && peerUin !== senderUin ? 3 : senderUin === self.uin || uid === self.uid ? 4 : !isUid(uid) || senderUid !== uid ? 5 : !isFriend(uid) ? 6 : 0;
        if (rejected) { diagnostic('inbound_rejected', rejected); continue; }
        const msgId = record.msgId, msgTime = record.msgTime, elements = record.elements;
        if (typeof msgId !== 'string' || !msgId || msgId.length > 200) { diagnostic('inbound_rejected', 7); continue; }
        if (!Array.isArray(elements) || !elements.length || elements.length > 32000) { diagnostic('inbound_rejected', 8); continue; }
        let text = '', valid = true;
        for (const element of elements) {
          const content = element?.textElement?.content;
          if (element?.elementType !== 1 || typeof content !== 'string') { valid = false; break; }
          text += content; if (text.length > 32000) break;
        }
        if (!valid) { diagnostic('inbound_rejected', 8); continue; }
        const timestamp = typeof msgTime === 'string' && /^[1-9]\d{0,12}$/.test(msgTime) ? Number(msgTime) : NaN;
        if (!Number.isSafeInteger(timestamp) || timestamp > Math.floor(now() / 1000) + 300) { diagnostic('inbound_rejected', 9); continue; }
        const value = { attemptId, self, uid, peerUin, senderUin, msgId, timestamp, text };
        if (!text.trim() || text.length > 32000 || seen.has(incomingKey(value))) { diagnostic('inbound_rejected', 10); continue; }
        inboundQueue.push(value);
        void drainIncoming().catch(() => { inboundQueue.length = 0; fail('NATIVE_SESSION_FAILED'); });
      } catch { diagnostic('inbound_rejected', 11); }
    }
  }
  async function verifyIdentity() {
    // Account identity comes from the native authentication callback. Native
    // session readiness and successful start completion are separate gates.
    // The friend UID cache does not contain self and is not a self-auth API.
    if (!active || !self || nativeDisconnected || !sessionReady || !startupComplete || connected || identityCheck) return;
    identityCheck = (async () => {
      diagnostic('identity_begin');
      session.getMsgService().addKernelMsgListener(retainListener({ onRecvMsg: incoming, onMsgInfoListUpdate: messageStatus, onRichMediaDownloadComplete:bound(value=>{if(abandonedDownloads.has(value?.filePath)){try{fs.rmSync(value.filePath,{force:true});}catch{}abandonedDownloads.delete(value.filePath);}for(const waiter of [...downloadWaiters])waiter.accept(value);}), onAddSendMsg: notify, onMsgSendError: notify, onKickedOffLine: bound(() => { connected = false; state('disconnected'); active = false; }) }));
      await onIdentity({ selfId: self.uin, uid: self.uid });
      if (!active || nativeDisconnected || !sessionReady || !startupComplete) return;
      diagnostic('identity_end');
      connected = true; emit('connected', { selfId: self.uin });
    })().catch(() => fail('IDENTITY_UNVERIFIED')).finally(() => { identityCheck = null; });
    await identityCheck;
  }
  function authenticate(result) {
    restoring = false;
    diagnostic('qr_authenticated');
    if (!isId(result?.uin) || !isUid(result?.uid)) { fail('IDENTITY_UNVERIFIED'); return; }
    if (expectedSelfId && result.uin !== expectedSelfId) { fail('ACCOUNT_MISMATCH'); return; }
    if (self) { if (self.uin !== result.uin || self.uid !== result.uid) fail('IDENTITY_UNVERIFIED'); return; }
    self = { uin: result.uin, uid: result.uid };
    emit('state', { status: 'verifying', authenticated: true });
    const authenticatedSelf = self;
    // Native success callbacks only report login. Initialize on the next event
    // loop turn, after the native login callback has fully unwound.
    setImmediate(() => {
      if (!active || stopped || self !== authenticatedSelf) return;
      try { initializeSession(); } catch { fail('NATIVE_SESSION_FAILED'); }
    });
  }
  function initializeSession() {
    const guidRaw = login.getMachineGuid();
    if (typeof guidRaw !== 'string' || !/^[a-fA-F0-9]{32}$/.test(guidRaw)) { fail('IDENTITY_UNVERIFIED'); return; }
    const guid = [guidRaw.slice(0, 8), guidRaw.slice(8, 12), guidRaw.slice(12, 16), guidRaw.slice(16, 20), guidRaw.slice(20)].join('-');
    const sessionConfig = {
      selfUin: self.uin, selfUid: self.uid, desktopPathConfig: { account_path: dataRoot },
      clientVer: PIN.fullVersion, appid: PIN.appid, a2: '', d2: '', d2Key: '', machineId: '',
      platform: 4, platVer: os.release(), defaultFileDownloadPath: path.join(dataRoot, 'downloads'),
      rdeliveryConfig: { appKey: '', systemId: 0, appId: '', logicEnvironment: '', platform: 4, language: '', sdkVersion: '', userId: '', appVersion: '', osVersion: '', bundleId: '', serverUrl: '', fixedAfterHitKeys: [''] },
      deviceInfo: { guid, buildVer: PIN.fullVersion, localId: 2052, devName: os.hostname(), devType: 'Mac', vendorName: '', osVer: os.release(), vendorOsName: 'macOS', setMute: false, vendorType: 0 },
      deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}',
    };
    diagnostic('session_init');
    session.init(sessionConfig,
      { onMSFStatusChange: bound((status, reason) => {
        diagnostic('msf_notification', status);
        if (status === 2) { everMsfConnected = true; void verifyIdentity(); return; }
        // The initial disconnected snapshot precedes account session startup;
        // it is not a transition away from a verified live account.
        if (status === 1 && reason === 0 && !connected && !everMsfConnected) return;
        nativeDisconnected = true; connected = false; state('disconnected'); active = false;
      }), onMSFSsoError: bound(code => {diagnostic('native_failure',code);fail('NATIVE_NETWORK_FAILED');}), getGroupCode: notify },
      // Optional UI notifications only. No synthetic signing or success reply.
      { dispatchRequest: notify, dispatchCall: notify, dispatchCallWithJson: notify },
      { onNTSessionCreate: notify, onGProSessionCreate: notify, onSessionInitComplete: bound(() => { diagnostic('session_ready'); }), onOpentelemetryInit: bound(info => { diagnostic('telemetry_ready',info?.is_init===true?1:0);if (info?.is_init !== true) { fail('NATIVE_SESSION_FAILED'); return; } sessionReady = true; void verifyIdentity(); }), onUserOnlineResult: notify, onGetSelfTinyId: notify });
    diagnostic('session_configured');
    if (!active || stopped || nativeDisconnected) return;
    Promise.resolve(startup.start()).then(() => {
      if (!active || stopped) return;
      startupComplete = true; diagnostic('startup_started'); void verifyIdentity();
    }, () => { if (active && !stopped) fail('NATIVE_SESSION_FAILED'); });
  }
  function requestQr() {
    if (!active || self || restoring || qrRequested) return;
    qrRequested = true; state('qr_pending'); diagnostic('qr_request');
    if (login.getQRCodePicture() !== true) throw issue('NATIVE_QR_FAILED');
  }
  function prepare(value, expected, restore = true) {
    if (!safeAttempt(value) || typeof restore !== 'boolean') throw issue('INPUT');
    if (expected !== undefined && expected !== null && !isId(expected)) throw issue('INPUT');
    if (attemptId && value !== attemptId) throw issue('FRESH_PROCESS_REQUIRED');
    if (prepared) { requireAttempt(value); return { attemptId }; }
    for(const name of ['outbox','downloads']){const dir=path.join(dataRoot,name);try{const stat=fs.lstatSync(dir);if(stat.isDirectory()&&!stat.isSymbolicLink()&&fs.realpathSync(dir)===path.join(fs.realpathSync(dataRoot),name)){for(const file of fs.readdirSync(dir)){if(/^momo-media-[0-9a-f-]{36}$/.test(file)){try{fs.rmSync(path.join(dir,file),{force:true});}catch{}}}}}catch{}}
    attemptId = value; expectedSelfId = expected ?? null; restoreSession = restore; active = true; prepared = true;
    diagnostic('prepare');
    // This native listener initializes event dispatch for a standalone host.
    // It supplies no opaque data, signatures or manufactured native response.
    misc = api.NodeIO3MiscService.get();
    misc.addO3MiscListener({ getOnAmgomDataPiece: notify });
    engine = api.NodeIQQNTWrapperEngine.get(); login = api.NodeIKernelLoginService.get();
    startup = api.NodeIQQNTStartupSessionWrapper.create(); session = api.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1');
    const dataGlobal = path.join(dataRoot, 'global');
    engine.initWithDeskTopConfig({ base_path_prefix: '', platform_type: 4, app_type: 4, app_version: PIN.fullVersion, os_version: os.release(), use_xlog: false, qua: PIN.qua, global_path_config: { desktopGlobalPath: dataGlobal }, thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 } },
      { onLog: notify, onGetSrvCalTime: notify, onShowErrUITips: notify, fixPicImgType: notify, getAppSetting: notify, onInstallFinished: notify, onUpdateGeneralFlag: notify, onGetOfflineMsg: notify });
    login.initConfig({ machineId: '', appid: PIN.appid, platVer: os.release(), commonPath: dataGlobal, clientVer: PIN.fullVersion, hostName: os.hostname(), externalVersion: false });
    const listener = Object.fromEntries(['onLoginConnecting', 'onQRCodeLoginPollingStarted', 'onLogoutFailed', 'onLoginRecordUpdate', 'onLoginState'].map(name => [name, notify]));
    listener.onLoginConnected = bound(() => {
      if (transportReady) return;
      transportReady = true;
      diagnostic('transport_connected');
      restoring = restoreSession && !!expectedSelfId && typeof login.getLoginList === 'function' && typeof login.quickLoginWithUin === 'function';
      if (restoring) state('verifying');
      // This ACK proves transport only. Cached native APIs may settle after
      // authentication, or never settle; neither may hold a control request.
      connectResolve?.({ attemptId }); connectResolve = null;
      if (!restoring) return;
      void (async () => {
        diagnostic('cached_list_begin');
        const records = await login.getLoginList();
        if (!active || self) return;
        diagnostic('cached_list_end');
        const account = records?.LocalLoginInfoList?.find(item => item.uin === expectedSelfId && item.isQuickLogin === true && isUid(item.uid));
        if (!account) { restoring = false; requestQr(); return; }
        diagnostic('cached_login_begin');
        const result = await login.quickLoginWithUin(expectedSelfId);
        if (!active) return;
        diagnostic('cached_login_end', typeof result?.result === 'string' && /^-?\d{1,10}$/.test(result.result) ? Number(result.result) : undefined);
        // Only onQRCodeLoginSucceed can establish the actual identity. Cached
        // metadata plus an accepted quick-login call is not authentication.
        if (!self && (result?.result !== '0' || result?.loginErrorInfo?.errMsg)) { restoring = false; requestQr(); }
      })().catch(() => {
        if (!active || self) return;
        diagnostic('cached_login_failure'); restoring = false;
        try { requestQr(); } catch { fail('NATIVE_QR_FAILED'); }
      });
    });
    listener.onLoginDisConnected = bound(() => { connected = false; state('disconnected'); active = false; });
    listener.onQRCodeGetPicture = bound(value => {
      if (self) return;
      diagnostic('qr_received');
      const base64 = typeof value?.pngBase64QrcodeData === 'string' ? value.pngBase64QrcodeData.replace(/^data:image\/png;base64,/, '') : '';
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length > 384 * 1024) { fail('QR_INVALID'); return; }
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length <= 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { fail('QR_INVALID'); return; }
      emit('qr', { dataUrl: 'data:image/png;base64,' + base64, expiresAt: now() + 90_000 });
    });
    listener.onQRCodeSessionUserScaned = bound(() => {if (self) return;diagnostic('qr_scanned');state('awaiting_confirmation');});
    listener.onQRCodeLoginSucceed = bound(result => { try { authenticate(result); } catch { fail('NATIVE_SESSION_FAILED'); } });
    listener.onQRCodeSessionFailed = bound((_type,code) => {diagnostic('qr_failure',code);if (!self) { state('expired'); active = false; } });
    for (const name of ['onLoginFailed', 'onLogoutSucceed', 'onUserLoggedIn', 'onQRCodeSessionQuickLoginFailed', 'onPasswordLoginFailed', 'OnConfirmUnusualDeviceFailed', 'onQQLoginNumLimited']) listener[name] = bound(code => {diagnostic('login_failure',code);fail('NATIVE_LOGIN_FAILED');});
    login.addKernelLoginListener(listener);
    return { attemptId };
  }
  // Reviewed fixed-version QQNT APIs. No generic native method/path escape.
  const groupWaiters = new Set(), buddyWaiters = new Set(), downloadWaiters = new Set();
  let groupListenerReady = false, buddyListenerReady = false;
  const trimText = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : '';
  const groupCode = peer => typeof peer === 'string' && /^group:[1-9]\d{0,19}$/.test(peer) ? peer.slice(6) : null;
  const pageLimit = (value, maximum) => value === undefined ? Math.min(maximum, 50) : Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : (()=>{throw issue('INPUT');})();
  const sdkResult = result => { if (!result || (result.result !== 0 && result.errCode !== 0)) throw issue('PROVIDER_REJECTED'); return result; };
  function nativeWait(waiters, invoke, predicate = () => true) {
    return new Promise((resolve,reject)=>{
      const entry = {accept:value=>{if(!predicate(value))return;clearTimeout(timer);waiters.delete(entry);resolve(value);},cancel:()=>{clearTimeout(timer);waiters.delete(entry);reject(issue('ATTEMPT_CANCELLED'));}};
      const timer=setTimeout(()=>{waiters.delete(entry);reject(issue('TIMEOUT'));},10000);timer.unref?.();waiters.add(entry);
      try{Promise.resolve(invoke()).catch(()=>{clearTimeout(timer);waiters.delete(entry);reject(issue('PROVIDER_REJECTED'));});}
      catch{clearTimeout(timer);waiters.delete(entry);reject(issue('PROVIDER_REJECTED'));}
    });
  }
  function ensureGroupListener() {
    if(groupListenerReady)return;
    session.getGroupService().addKernelGroupListener(retainListener({onGroupListUpdate:bound((type,rows)=>{if((type===0||type===1)&&Array.isArray(rows))for(const waiter of [...groupWaiters])waiter.accept(rows);})}));groupListenerReady=true;
  }
  function ensureBuddyListener() {
    if(buddyListenerReady)return;
    session.getBuddyService().addKernelBuddyListener(retainListener({onBuddyReqChange:bound(value=>{if(Array.isArray(value?.buddyReqs))for(const waiter of [...buddyWaiters])waiter.accept(value.buddyReqs);})}));buddyListenerReady=true;
  }
  async function groupsNow(requireConnection) {
    ensureGroupListener();const rows=await nativeWait(groupWaiters,()=>session.getGroupService().getGroupList(true));requireConnection();
    if(rows.length>5000)throw issue('INPUT');return rows.filter(row=>isId(row?.groupCode));
  }
  async function nativePeer(peerId, requireConnection) {
    const group=groupCode(peerId);
    if(group){const joined=(await groupsNow(requireConnection)).find(row=>row.groupCode===group);if(!joined)throw issue('PEER_UNVERIFIED');return{chatType:2,peerUid:group,guildId:'',joined};}
    if(!isId(peerId)||peerId===self.uin)throw issue('INPUT');
    const map=await session.getProfileService().getUidByUin('momo-private-recipient',[peerId]);requireConnection();const uid=map instanceof Map?map.get(peerId):null;
    if(!isUid(uid)||!isFriend(uid))throw issue('PEER_UNVERIFIED');return{chatType:1,peerUid:uid,guildId:''};
  }
  const peerArgument = peer => ({chatType:peer.chatType,peerUid:peer.peerUid,guildId:''});
  function normalizedElements(elements) {
    if(!Array.isArray(elements)||elements.length>256)return{ text:'', attachments:[] };
    let text='';const attachments=[];
    for(const item of elements){
      if(item?.elementType===1&&typeof item.textElement?.content==='string')text+=item.textElement.content;
      else if([2,3,4,5].includes(item?.elementType)&&typeof item.elementId==='string'&&item.elementId.length<=200){
        const kind=({2:'image',3:'file',4:'audio',5:'video'})[item.elementType];const data=item.picElement??item.fileElement??item.pttElement??item.videoElement??{};
        const size=Number(data.fileSize??0);attachments.push({elementId:item.elementId,kind,name:trimText(data.fileName||kind,160),size:Number.isSafeInteger(size)&&size>=0?size:0});
      }
    }
    return{text:text.slice(0,32000),attachments:attachments.slice(0,10)};
  }
  async function normalizedHistory(rows,peer,requireConnection){
    if(!Array.isArray(rows)||rows.length>1000)throw issue('INPUT');const out=[];
    for(const row of rows){
      if(row?.chatType!==peer.chatType||row.peerUid!==peer.peerUid||typeof row.msgId!=='string')continue;
      let sender=row.senderUid===self.uid?self.uin:row.senderUin;
      if(!isId(sender)&&isUid(row.senderUid)){const resolved=await session.getUixConvertService().getUin([row.senderUid]);requireConnection();sender=resolved?.uinInfo instanceof Map?resolved.uinInfo.get(row.senderUid):null;}
      if(!isId(sender))continue;const content=normalizedElements(row.elements);
      out.push({messageId:row.msgId,senderId:sender,time:trimText(row.msgTime,20),...content});
    }
    return out;
  }
  async function friendRequests(requireConnection){
    ensureBuddyListener();const rows=await nativeWait(buddyWaiters,()=>session.getBuddyService().getBuddyReq());requireConnection();
    if(rows.length>2000)throw issue('INPUT');return rows.filter(row=>isUid(row?.friendUid)&&typeof row.reqTime==='string'&&/^\d{1,20}$/.test(row.reqTime));
  }
  async function membersNow(code,requireConnection){
    const result=sdkResult(await session.getGroupService().getAllMemberList(code,true));requireConnection();
    if(!(result.result?.infos instanceof Map)||result.result.infos.size>10000)throw issue('INPUT');return result.result.infos;
  }
  function privateMediaDir(name){
    const dir=path.join(dataRoot,name);fs.mkdirSync(dir,{recursive:true,mode:0o700});const stat=fs.lstatSync(dir);
    if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(dir)!==path.join(fs.realpathSync(dataRoot),name)||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw issue('RESOURCE_INVALID');return dir;
  }
  function pageResult(key,items,p,maximum){
    const offset=p.cursor===undefined?0:typeof p.cursor==='string'&&/^(0|[1-9][0-9]{0,4})$/.test(p.cursor)&&Number(p.cursor)<=10000?Number(p.cursor):(()=>{throw issue('INPUT');})();
    const limit=pageLimit(p.limit,maximum),end=offset+limit;return{[key]:items.slice(offset,end),...(end<items.length?{cursor:String(end)}:{})};
  }
  function imageInfo(bytes){
    if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);if(width&&height&&width<=16384&&height<=16384)return{width,height,mime:'image/png'};}
    // Google WebP RIFF container: bounded chunk lengths and 1-based canvas dimensions.
    if(bytes.length>=20&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)+8===bytes.length){
      for(let offset=12;offset+8<=bytes.length;){const kind=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8,end=start+size;if(end>bytes.length)break;let width=0,height=0;
        if(kind==='VP8X'&&size>=10){width=bytes.readUIntLE(start+4,3)+1;height=bytes.readUIntLE(start+7,3)+1;}
        else if(kind==='VP8L'&&size>=5&&bytes[start]===47){const bits=bytes.readUInt32LE(start+1);if((bits>>>29)===0){width=(bits&16383)+1;height=((bits>>>14)&16383)+1;}}
        else if(kind==='VP8 '&&size>=10&&(bytes[start]&1)===0&&bytes[start+3]===157&&bytes[start+4]===1&&bytes[start+5]===42){width=bytes.readUInt16LE(start+6)&16383;height=bytes.readUInt16LE(start+8)&16383;}
        if(width&&height&&width<=16384&&height<=16384)return{width,height,mime:'image/webp',picType:1002};offset=end+(size&1);
      }
    }
    if(bytes.length>4&&bytes[0]===255&&bytes[1]===216){for(let i=2;i+9<bytes.length;){if(bytes[i++]!==255)break;const type=bytes[i++];if(type===216||type===217)continue;const length=bytes.readUInt16BE(i);if(length<2||i+length>bytes.length)break;if([192,193,194].includes(type)){const height=bytes.readUInt16BE(i+3),width=bytes.readUInt16BE(i+5);if(width&&height&&width<=16384&&height<=16384)return{width,height,mime:'image/jpeg'};break;}i+=length;}}
    return null;
  }
  async function commitOperation(operation,requireConnection){
    requireConnection();
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{operation.commitResolve=null;operation.commitReject=null;reject(issue('TIMEOUT'));},10000);timer.unref?.();
      operation.commitResolve=()=>{clearTimeout(timer);operation.commitResolve=null;operation.commitReject=null;resolve();};
      operation.commitReject=()=>{clearTimeout(timer);operation.commitResolve=null;operation.commitReject=null;reject(issue('ATTEMPT_CANCELLED'));};
      emit('channelReady',{echo:operation.echo});
    });
    requireConnection();operation.submitted=true;
  }
  async function fullAction(action,p,echo,requireConnection,admission){
    await verifyLiveIdentity();requireConnection();
    const scope=p.scopePeerIds===undefined?null:Array.isArray(p.scopePeerIds)&&p.scopePeerIds.length<=200&&p.scopePeerIds.every(id=>action==='groups.list'?!!groupCode(id):isId(id))?new Set(p.scopePeerIds):(()=>{throw issue('INPUT');})();
    if(action==='contacts.list'){
      const limit=pageLimit(p.limit,200);if(scope?.size===0){reply(echo,{contacts:[]});return;}
      const rows=sdkResult(await session.getBuddyService().getBuddyListV2('0',true,0));requireConnection();
      if(!Array.isArray(rows.data)||rows.data.length>1000)throw issue('INPUT');let uids=[...new Set(rows.data.flatMap(row=>Array.isArray(row.buddyUids)?row.buddyUids.filter(uid=>isUid(uid)&&uid!==self.uid):[]))];
      if(uids.length>10000)throw issue('INBOX_CAPACITY');
      if(scope){const mapping=await session.getProfileService().getUidByUin('momo-contacts-scope',[...scope]);requireConnection();if(!(mapping instanceof Map))throw issue('INPUT');const allowed=new Set([...mapping.values()].filter(isUid));uids=uids.filter(uid=>allowed.has(uid));}
      const infos=await session.getProfileService().getCoreAndBaseInfo('nodeStore',uids);requireConnection();
      if(!(infos instanceof Map))throw issue('INPUT');const contacts=[];
      for(const uid of uids){const info=infos.get(uid),core=info?.coreInfo??info;if((!scope||scope.has(core?.uin))&&uid!==self.uid&&core?.uin!==self.uin&&isId(core?.uin)&&(core.uid===undefined||core.uid===uid)&&isFriend(uid))contacts.push({peerId:core.uin,name:trimText(core.nick),remark:trimText(core.remark)});}
      reply(echo,pageResult('contacts',contacts,p,200));return;
    }
    if(action==='groups.list'){
      const groups=(scope?.size===0?[]:await groupsNow(requireConnection)).filter(row=>!scope||scope.has(`group:${row.groupCode}`)).map(row=>({peerId:`group:${row.groupCode}`,name:trimText(row.groupName),memberCount:Number.isSafeInteger(row.memberCount)?row.memberCount:0,role:row.memberRole}));reply(echo,pageResult('groups',groups,p,200));return;
    }
    if(action==='friends.listRequests'||action==='friends.respond'){
      const rows=await friendRequests(requireConnection);
      if(action==='friends.listRequests'){
        const limit=pageLimit(p.limit,100),requests=[];
        if(scope?.size===0){reply(echo,pageResult('requests',requests,p,100));return;}
        const pending=rows.filter(row=>row.isDecide===false&&!row.isInitiator);
        for(let index=0;index<pending.length;index+=200){
          const batch=pending.slice(index,index+200),resolved=await session.getUixConvertService().getUin([...new Set(batch.map(row=>row.friendUid))]);requireConnection();
          if(!(resolved?.uinInfo instanceof Map))throw issue('INPUT');
          for(const row of batch){const peerId=resolved.uinInfo.get(row.friendUid);if(isId(peerId)&&(!scope||scope.has(peerId))){requests.push({peerId,requestId:`${row.friendUid}:${row.reqTime}`,name:trimText(row.friendNick),message:trimText(row.extWords,1000)});}}
        }
        reply(echo,pageResult('requests',requests,p,100));return;
      }
      if(!isId(p.peerId)||typeof p.requestId!=='string'||typeof p.approve!=='boolean')throw issue('INPUT');
      const row=rows.find(row=>`${row.friendUid}:${row.reqTime}`===p.requestId&&row.isDecide===false&&!row.isInitiator);if(!row)throw issue('PEER_UNVERIFIED');
      const resolved=await session.getUixConvertService().getUin([row.friendUid]);requireConnection();if(resolved?.uinInfo?.get(row.friendUid)!==p.peerId)throw issue('PEER_UNVERIFIED');
      await commitOperation(admission,requireConnection);await session.getBuddyService().approvalFriendRequest({friendUid:row.friendUid,reqTime:row.reqTime,accept:p.approve});requireConnection();
      const refreshed=await friendRequests(requireConnection),after=refreshed.find(item=>`${item.friendUid}:${item.reqTime}`===p.requestId);
      const decidedAsRequested=p.approve?isFriend(row.friendUid):after?.isDecide===true&&after.reqType===7&&after.isAgreed!==true&&!isFriend(row.friendUid);
      if(!decidedAsRequested)throw issue('OUTCOME_UNKNOWN');reply(echo,{operationStatus:'confirmed',approved:p.approve});return;
    }
    const peer=await nativePeer(p.peerId,requireConnection);
    if(action==='history.list'){
      const limit=pageLimit(p.limit,50);if(p.beforeMessageId!==undefined&&(typeof p.beforeMessageId!=='string'||p.beforeMessageId.length>200))throw issue('INPUT');
      const result=sdkResult(await session.getMsgService().getMsgsIncludeSelf(peerArgument(peer),p.beforeMessageId??'0',limit,true));requireConnection();
      reply(echo,{messages:await normalizedHistory(result.msgList,peer,requireConnection)});return;
    }
    if(action==='groups.members'||action==='groups.manage'){
      if(peer.chatType!==2)throw issue('INPUT');const members=await membersNow(peer.peerUid,requireConnection);
      if(action==='groups.members'){reply(echo,pageResult('members',[...members.values()].filter(row=>isId(row?.uin)).map(row=>({peerId:row.uin,name:trimText(row.nick),card:trimText(row.cardName),role:row.role})),p,200));return;}
      const selfRole=members.get(self.uid)?.role;if(![3,4].includes(selfRole))throw issue('FORBIDDEN');const svc=session.getGroupService();let result;
      if(p.operation==='setName'&&typeof p.name==='string'&&p.name.trim()&&p.name.length<=60){await commitOperation(admission,requireConnection);result=await svc.modifyGroupName(peer.peerUid,p.name,false);}
      else if(p.operation==='muteAll'&&typeof p.enabled==='boolean'){await commitOperation(admission,requireConnection);result=await svc.setGroupShutUp(peer.peerUid,p.enabled);}
      else if(['muteMember','kickMember'].includes(p.operation)&&isId(p.memberId)){
        const member=[...members.values()].find(row=>row.uin===p.memberId);if(!member||!isUid(member.uid)||member.uid===self.uid||!Number.isInteger(member.role)||member.role>=selfRole)throw issue('FORBIDDEN');
        requireConnection();
        if(p.operation==='muteMember'&&Number.isInteger(p.durationSeconds)&&p.durationSeconds>=0&&p.durationSeconds<=2592000){await commitOperation(admission,requireConnection);result=await svc.setMemberShutUp(peer.peerUid,[{uid:member.uid,timeStamp:p.durationSeconds}]);}
        else if(p.operation==='kickMember'){await commitOperation(admission,requireConnection);await svc.kickMember(peer.peerUid,[member.uid],false,'');requireConnection();const after=await membersNow(peer.peerUid,requireConnection);if(after.has(member.uid))throw issue('OUTCOME_UNKNOWN');reply(echo,{operationStatus:'confirmed'});return;}
        else throw issue('INPUT');
      }else throw issue('INPUT');
      requireConnection();sdkResult(result);reply(echo,{operationStatus:'provider_accepted'});return;
    }
    if(action==='media.fetch'){
      if(abandonedDownloads.size>=64)throw issue('INBOX_CAPACITY');
      if(typeof p.messageId!=='string'||!p.messageId||p.messageId.length>200||typeof p.elementId!=='string'||!p.elementId||p.elementId.length>200)throw issue('INPUT');
      const result=sdkResult(await session.getMsgService().getMsgsByMsgId(peerArgument(peer),[p.messageId]));requireConnection();
      const record=result.msgList?.find(row=>row.chatType===peer.chatType&&row.peerUid===peer.peerUid&&row.msgId===p.messageId);const element=record?.elements?.find(item=>item.elementId===p.elementId&&[2,3,4,5].includes(item.elementType));if(!element)throw issue('PEER_UNVERIFIED');
      const metadata=normalizedElements([element]).attachments[0];if(!metadata||metadata.size<=0||metadata.size>8*1024*1024)throw issue('INPUT');
      const dir=privateMediaDir('downloads');const output=path.join(dir,'momo-media-'+require('node:crypto').randomUUID());
      let completed=false;try{
      const complete=await nativeWait(downloadWaiters,()=>session.getMsgService().downloadRichMedia({fileModelId:'0',downSourceType:0,downloadSourceType:0,triggerType:1,msgId:p.messageId,chatType:peer.chatType,peerUid:peer.peerUid,elementId:p.elementId,thumbSize:0,downloadType:1,filePath:output}),value=>value?.msgId===p.messageId&&value?.msgElementId===p.elementId);
      completed=true;requireConnection();if(String(complete.fileErrCode)!=='0'||complete.filePath!==output)throw issue('PROVIDER_REJECTED');
      const handle=fs.openSync(output,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const stat=fs.fstatSync(handle);if(!stat.isFile()||stat.size>8*1024*1024||stat.nlink!==1)throw issue('INPUT');const bytes=Buffer.alloc(stat.size);if(fs.readSync(handle,bytes,0,bytes.length,0)!==bytes.length||fs.fstatSync(handle).size!==stat.size)throw issue('INPUT');reply(echo,{name:metadata.name,mime:imageInfo(bytes)?.mime??'application/octet-stream',dataBase64:bytes.toString('base64')});}finally{fs.closeSync(handle);}
      }finally{if(!completed)abandonedDownloads.add(output);try{fs.rmSync(output,{force:true});}catch{}}return;
    }
    if(!['private.send','group.send','media.send'].includes(action))throw issue('INPUT');
    if(seen.has('send:'+echo))return;
    if(action==='private.send'&&peer.chatType!==1||action==='group.send'&&peer.chatType!==2)throw issue('INPUT');
    let elements,stagedFile;
    if(action==='media.send'){
      if(typeof p.name!=='string'||!p.name||p.name.length>160||/[\\/\x00-\x1f]/.test(p.name)||typeof p.mime!=='string'||p.mime.length>100||typeof p.dataBase64!=='string'||p.dataBase64.length>12*1024*1024||!/^[A-Za-z0-9+/]+={0,2}$/.test(p.dataBase64))throw issue('INPUT');
      const bytes=Buffer.from(p.dataBase64,'base64');if(!bytes.length||bytes.length>8*1024*1024||bytes.toString('base64')!==p.dataBase64)throw issue('INPUT');
      const dir=privateMediaDir('outbox');stagedFile=path.join(dir,'momo-media-'+require('node:crypto').randomUUID());fs.writeFileSync(stagedFile,bytes,{flag:'wx',mode:0o600});
      // Media bytes are uploaded as native QQ attachments. Never treat the
      // MIME label or filename as a native executable path or remote URL.
      const image=imageInfo(bytes);
      if(p.mime.startsWith('image/')&&!image){fs.rmSync(stagedFile,{force:true});throw issue('INPUT');}
      elements=image?[{elementType:2,elementId:'',picElement:{md5HexStr:require('node:crypto').createHash('md5').update(bytes).digest('hex'),fileSize:String(bytes.length),picWidth:image.width,picHeight:image.height,fileName:p.name,sourcePath:stagedFile,original:true,picType:image.picType??1000,picSubType:0,fileUuid:'',fileSubId:'',thumbFileSize:0,summary:''}}]:[{elementType:3,elementId:'',fileElement:{fileName:p.name,folderId:'',filePath:stagedFile,fileSize:String(bytes.length)}}];
    }else{if(typeof p.text!=='string'||!p.text.trim()||p.text.length>32000)throw issue('INPUT');elements=[{elementType:1,elementId:'',textElement:{content:p.text,atType:0,atUid:'',atTinyId:'',atNtUid:''}}];}
    const messages=session.getMsgService();let unique;try{unique=String(await messages.generateMsgUniqueId(peer.chatType,session.getMSFService().getServerTime()));requireConnection();}catch(cause){if(stagedFile)fs.rmSync(stagedFile,{force:true});throw cause;}
    if(!unique||outgoing.has(unique)||outgoing.size>=512){if(stagedFile)fs.rmSync(stagedFile,{force:true});throw issue('NATIVE_CORRELATION_FAILED');}
    try{await commitOperation(admission,requireConnection);}catch(cause){if(stagedFile)fs.rmSync(stagedFile,{force:true});throw cause;}
    if(outgoing.has(unique)){if(stagedFile)fs.rmSync(stagedFile,{force:true});throw issue('NATIVE_CORRELATION_FAILED');}
    seen.add('send:'+echo);outgoing.set(unique,{echo,peerUid:peer.peerUid,chatType:peer.chatType,stagedFile,done:false});
    try{const result=await messages.sendMsg('0',{...peerArgument(peer),guildId:unique},elements,new Map());if(Number.isInteger(result?.result)&&result.result!==0){const pending=outgoing.get(unique);if(pending&&!pending.done){pending.done=true;outgoing.delete(unique);if(stagedFile)fs.rmSync(stagedFile,{force:true});reply(echo,{},true);}}}catch{/* Submission ambiguity keeps original correlation and file until stop/receipt. */}
  }

  async function onebot(params) {
    if (!connected || !active || !self) throw issue('PLUGIN_UNAVAILABLE');
    const ownedAttempt = attemptId;let operation=null;
    const requireConnection = () => { requireAttempt(ownedAttempt); if (!connected) throw issue('PLUGIN_UNAVAILABLE');if(operation?.cancelled)throw issue('ATTEMPT_CANCELLED'); };
    const { action, echo } = params;
    if (typeof echo !== 'string' || !echo || echo.length > 200) throw issue('INPUT');
    if(operationStates.has(echo))throw issue('INPUT');operation={echo,submitted:false,cancelled:false};operationStates.set(echo,operation);
    try{
    if (action === 'get_login_info') { await verifyLiveIdentity(); requireConnection(); reply(echo, { user_id: self.uin }); return { attemptId }; }
    if (['contacts.list','history.list','private.send','group.send','media.send','media.fetch','friends.listRequests','friends.respond','groups.list','groups.members','groups.manage'].includes(action)) { const admission=operation;try{await fullAction(action,params.params??{},echo,requireConnection,admission);}catch(cause){if(!admission.submitted&&['INPUT','FORBIDDEN','PEER_UNVERIFIED','PROVIDER_REJECTED','ATTEMPT_CANCELLED'].includes(cause?.code)){reply(echo,{errorCode:cause.code},true);}else throw cause;}return {attemptId}; }
    if (action !== 'send_private_msg' || !isId(params.params?.user_id) || params.params.user_id === self.uin || typeof params.params.message !== 'string' || !params.params.message.trim() || params.params.message.length > 32000) throw issue('INPUT');
    if (seen.has('send:' + echo)) return { attemptId };
    if (seen.size >= 10000 || outgoing.size >= 512) throw issue('INBOX_CAPACITY');
    await verifyLiveIdentity();
    const map = await session.getProfileService().getUidByUin('momo-private-recipient', [params.params.user_id]);
    requireConnection();
    const peerUid = map instanceof Map ? map.get(params.params.user_id) : null;
    if (!isUid(peerUid) || !isFriend(peerUid)) throw issue('PEER_UNVERIFIED');
    const messages = session.getMsgService();
    const unique = String(await messages.generateMsgUniqueId(1, session.getMSFService().getServerTime()));
    // Nothing asynchronous may intervene between this final ownership check
    // and the native side effect. Cancel can happen during either lookup.
    requireConnection();
    if (!isFriend(peerUid)) throw issue('PEER_UNVERIFIED');
    if (!unique || outgoing.has(unique)) throw issue('NATIVE_CORRELATION_FAILED');
    await commitOperation(operation,requireConnection);
    seen.add('send:' + echo); outgoing.set(unique, { echo, peerUid, done: false });
    try {
      const result = await messages.sendMsg('0', { chatType: 1, peerUid, guildId: unique }, [{ elementType: 1, elementId: '', textElement: { content: params.params.message, atType: 0, atUid: '', atTinyId: '', atNtUid: '' } }], new Map());
      if (Number.isInteger(result?.result) && result.result !== 0) { const pending=outgoing.get(unique); if (pending && !pending.done) { pending.done=true; outgoing.delete(unique); reply(echo, {}, true); } }
    } catch { /* An ambiguous native submission never becomes a false failure. */ }
    return { attemptId };
    }catch(cause){if(active&&connected&&operation.cancelled&&!operation.submitted&&cause?.code==='ATTEMPT_CANCELLED'){reply(echo,{errorCode:'ATTEMPT_CANCELLED'},true);return{attemptId};}throw cause;}finally{operation.commitReject?.();operationStates.delete(echo);}
  }
  async function verifyLiveIdentity() {
    if (!self || !connected || !active || nativeDisconnected || !sessionReady || !startupComplete || (expectedSelfId && self.uin !== expectedSelfId)) throw issue('IDENTITY_UNVERIFIED');
  }

  return {
    async request(method, params = {}) {
      if (method === 'prepare') return prepare(params.attemptId, params.expectedSelfId, params.restoreSession);
      if(method==='cancelChannel'||method==='commitChannel'){
        requireAttempt(params.attemptId);if(typeof params.echo!=='string'||!params.echo||params.echo.length>200)throw issue('INPUT');const op=operationStates.get(params.echo);
        if(method==='cancelChannel'){if(op&&!op.submitted){op.cancelled=true;op.commitReject?.();}const submitted=op?.submitted===true||[...outgoing.values()].some(item=>item.echo===params.echo);return{attemptId,cancelled:!submitted,submitted};}
        if(!op||op.cancelled||op.submitted||!op.commitResolve)throw issue('ATTEMPT_CANCELLED');op.commitResolve();return{attemptId,committed:true};
      }
      if (method === 'onebot') return onebot(params);
      if (method === 'status') return { attemptId, connected, selfId: connected ? self.uin : null };
      if (method === 'cancel' || method === 'stop') {
        if (params.attemptId !== undefined && params.attemptId !== attemptId) throw issue('ATTEMPT_CANCELLED');
        active = false; connected = false;
        for(const op of operationStates.values()){if(!op.submitted){op.cancelled=true;op.commitReject?.();}}
        for(const collection of [groupWaiters,buddyWaiters,downloadWaiters])for(const waiter of [...collection])waiter.cancel?.();
        try { login?.abortPolling(); login?.cancel(); } catch {}
        connectResolve?.({ attemptId }); connectResolve = null;
        if (method === 'stop') { stopped = true; try { startup?.stop?.(); } catch {} }
        return { attemptId, stopped: method === 'stop' };
      }
      requireAttempt(params.attemptId);
      if (method === 'connect') {
        if (connectPromise) return connectPromise;
        connectPromise = new Promise(resolve => { connectResolve = resolve; });
        diagnostic('transport_connect');
        if (login.connect() !== true) throw issue('NATIVE_CONNECT_FAILED');
        return connectPromise;
      }
      if (method === 'requestQr') { requestQr(); return { attemptId }; }
      throw issue('METHOD');
    },
  };
}

function boot() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const root = fs.realpathSync(config.privateRoot);
  const within = value => typeof value === 'string' && fs.realpathSync(value).startsWith(root + path.sep);
  // The barrier deliberately denies even metadata for the synthetic canary.
  // Its parent is canonical; the trusted parent process pins the file itself.
  const canary = config.canaryPath;
  if (config.schemaVersion !== 1 || !within(config.dataRoot) || !within(config.wrapperPath) || typeof canary !== 'string' || !path.isAbsolute(canary) || path.normalize(canary) !== canary || !canary.startsWith(root + path.sep) || (fs.realpathSync(path.dirname(canary)) !== root && !within(path.dirname(canary)))) throw issue('RESOURCE_INVALID');
  try { fs.readFileSync(config.canaryPath); throw issue('RESOURCE_INVALID'); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw issue('RESOURCE_INVALID'); }
  for (const [key, value] of Object.entries(config.expectedNativeABI)) if (process.versions[key === 'node' ? 'node' : key] !== value) throw issue('RESOURCE_INVALID');
  for (const name of ['global', 'downloads', 'home']) fs.mkdirSync(path.join(config.dataRoot, name), { recursive: true, mode: 0o700 });
  os.homedir = () => path.join(config.dataRoot, 'home'); syncBuiltinESMExports();
  const native = { exports: {} }; process.dlopen(native, config.wrapperPath);
  const write = value => process.stdout.write('MOMO_QQ_IPC ' + JSON.stringify(value) + '\n');
  const worker = createNativeWorker({ api: native.exports, dataRoot: config.dataRoot, send: write });
  let buffer = '', inflight = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) process.exit(81);
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let input; try { input = JSON.parse(raw); } catch { continue; }
      if (!input || typeof input.id !== 'string' || input.id.length > 200 || ++inflight > 32) process.exit(81);
      Promise.resolve().then(() => worker.request(input.method, input.params)).then(result => {
        write({ id: input.id, result });
        if (input.method === 'stop') setTimeout(() => process.exit(0), 10);
      }, () => write({ id: input.id, error: { code: 'RUNTIME_FAILED' } })).finally(() => { inflight--; });
    }
  });
  process.stdin.on('end', () => { void worker.request('stop').finally(() => process.exit(0)); });
  process.on('uncaughtException', () => { write({ event: 'state', data: { status: 'error', code: 'RUNTIME_FAILED' } }); process.exit(82); });
}
module.exports = { createNativeWorker };
if (require.main === module) { try { boot(); } catch { process.stderr.write('MOMO_QQ_WORKER_START_FAILED\n'); process.exit(80); } }
