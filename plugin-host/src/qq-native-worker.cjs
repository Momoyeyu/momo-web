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
  let attemptId = null, expectedSelfId = null, active = false, prepared = false, nativeOnline = false, sessionReady = false;
  let engine, login, startup, session, self, connected = false, connectResolve;
  let connectPromise, stopped = false, identityCheck = null;
  const seen = new Set(), outgoing = new Map();
  const emit = (event, data) => send({ event, data: { attemptId, ...data } });
  const state = (status, code) => { if (active) emit('state', { status, ...(code ? { code } : {}) }); };
  const bound = callback => (...args) => { if (active && !stopped) return callback(...args); };
  const notify = () => {};
  const requireAttempt = value => { if (!active || stopped || value !== attemptId) throw issue('ATTEMPT_CANCELLED'); };
  const wire = data => send({ event: 'onebot', data });
  const isFriend = uid => { try { return session.getBuddyService().isBuddy(uid) === true; } catch { return false; } };
  const reply = (echo, result, failed = false) => wire({ echo, status: failed ? 'failed' : 'ok', retcode: failed ? 1 : 0, data: result });
  const fail = code => { state('error', code); active = false; connected = false; if (connectResolve) { connectResolve({ attemptId }); connectResolve = null; } };

  function messageStatus(records) {
    if (!Array.isArray(records)) return;
    for (const record of records) {
      const pending = outgoing.get(record.guildId);
      if (!pending || pending.done || record.senderUid !== self?.uid || record.peerUid !== pending.peerUid) continue;
      if (record.sendStatus === 2 && typeof record.msgId === 'string' && record.msgId) {
        pending.done = true; outgoing.delete(record.guildId); reply(pending.echo, { message_id: record.msgId });
      } else if (record.sendStatus === 0) { pending.done = true; outgoing.delete(record.guildId); reply(pending.echo, {}, true); }
    }
  }
  function incoming(records) {
    if (!active || !connected || !Array.isArray(records)) return;
    for (const record of records) {
      if (record.chatType !== 1 || !isId(record.peerUin) || record.senderUin !== record.peerUin || record.senderUin === self.uin || !isUid(record.peerUid) || record.senderUid !== record.peerUid || !isFriend(record.peerUid) || typeof record.msgId !== 'string' || !record.msgId || record.msgId.length > 200 || !Array.isArray(record.elements) || !record.elements.length || record.elements.some(element => element.elementType !== 1 || typeof element.textElement?.content !== 'string')) continue;
      const text = record.elements.map(element => element.textElement.content).join('');
      const timestamp = typeof record.msgTime === 'string' && /^[1-9]\d{0,12}$/.test(record.msgTime) ? Number(record.msgTime) : NaN;
      if (!Number.isSafeInteger(timestamp) || timestamp > Math.floor(now() / 1000) + 300) continue;
      if (!text.trim() || text.length > 32000 || seen.has('in:' + record.msgId)) continue;
      if (seen.size >= 10000) { fail('INBOX_CAPACITY'); return; }
      seen.add('in:' + record.msgId);
      wire({ post_type: 'message', message_type: 'private', sub_type: 'friend', time: timestamp, self_id: self.uin, user_id: record.peerUin, sender: { user_id: record.senderUin }, message_id: record.msgId, raw_message: text, message: [{ type: 'text', data: { text } }] });
    }
  }
  async function verifyIdentity() {
    // Depending on startup timing the online notification may precede the
    // listener. Read the native session status as well; transport alone is not
    // proof that an account logged in.
    if (active && self && sessionReady && session.getMSFService().getMsfStatus?.() === 2) nativeOnline = true;
    if (!active || !self || !nativeOnline || !sessionReady || connected || identityCheck) return;
    identityCheck = (async () => {
      const mapped = await session.getProfileService().getUinByUid('momo-self-verification', [self.uid]);
      if (!active || !nativeOnline || !sessionReady) return;
      if (!(mapped instanceof Map) || String(mapped.get(self.uid) ?? '') !== self.uin) { fail('IDENTITY_UNVERIFIED'); return; }
      session.getMsgService().addKernelMsgListener({ onRecvMsg: incoming, onMsgInfoListUpdate: messageStatus, onAddSendMsg: notify, onMsgSendError: notify, onKickedOffLine: bound(() => { connected = false; state('disconnected'); active = false; }) });
      await onIdentity({ selfId: self.uin, uid: self.uid });
      if (!active || !nativeOnline || !sessionReady) return;
      connected = true; emit('connected', { selfId: self.uin });
    })().catch(() => fail('IDENTITY_UNVERIFIED')).finally(() => { identityCheck = null; });
    await identityCheck;
  }
  function authenticate(result) {
    if (!isId(result?.uin) || !isUid(result?.uid)) { fail('IDENTITY_UNVERIFIED'); return; }
    if (expectedSelfId && result.uin !== expectedSelfId) { fail('ACCOUNT_MISMATCH'); return; }
    if (self) { if (self.uin !== result.uin || self.uid !== result.uid) fail('IDENTITY_UNVERIFIED'); return; }
    self = { uin: result.uin, uid: result.uid }; state('verifying');
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
    session.init(sessionConfig,
      { onMSFStatusChange: bound(status => { nativeOnline = status === 2; if (!nativeOnline && connected) { connected = false; state('disconnected'); } void verifyIdentity(); }), onMSFSsoError: bound(() => fail('NATIVE_NETWORK_FAILED')), getGroupCode: notify },
      // Optional UI notifications only. No synthetic signing or success reply.
      { dispatchRequest: notify, dispatchCall: notify, dispatchCallWithJson: notify },
      { onNTSessionCreate: notify, onGProSessionCreate: notify, onSessionInitComplete: bound(() => { sessionReady = true; void verifyIdentity(); }), onOpentelemetryInit: bound(info => { if (info?.is_init !== true) { fail('NATIVE_SESSION_FAILED'); return; } sessionReady = true; void verifyIdentity(); }), onUserOnlineResult: notify, onGetSelfTinyId: notify });
    startup.start();
  }
  function prepare(value, expected) {
    if (!safeAttempt(value)) throw issue('INPUT');
    if (expected !== undefined && expected !== null && !isId(expected)) throw issue('INPUT');
    if (attemptId && value !== attemptId) throw issue('FRESH_PROCESS_REQUIRED');
    if (prepared) { requireAttempt(value); return { attemptId }; }
    attemptId = value; expectedSelfId = expected ?? null; active = true; prepared = true;
    engine = api.NodeIQQNTWrapperEngine.get(); login = api.NodeIKernelLoginService.get();
    startup = api.NodeIQQNTStartupSessionWrapper.create(); session = api.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1');
    const dataGlobal = path.join(dataRoot, 'global');
    engine.initWithDeskTopConfig({ base_path_prefix: '', platform_type: 4, app_type: 4, app_version: PIN.fullVersion, os_version: os.release(), use_xlog: false, qua: PIN.qua, global_path_config: { desktopGlobalPath: dataGlobal }, thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 } },
      { onLog: notify, onGetSrvCalTime: notify, onShowErrUITips: notify, fixPicImgType: notify, getAppSetting: notify, onInstallFinished: notify, onUpdateGeneralFlag: notify, onGetOfflineMsg: notify });
    login.initConfig({ machineId: '', appid: PIN.appid, platVer: os.release(), commonPath: dataGlobal, clientVer: PIN.fullVersion, hostName: os.hostname(), externalVersion: false });
    const listener = Object.fromEntries(['onLoginConnecting', 'onQRCodeLoginPollingStarted', 'onLogoutFailed', 'onLoginRecordUpdate', 'onLoginState'].map(name => [name, notify]));
    listener.onLoginConnected = bound(() => {
      // Resume only the explicitly bound account, using this plugin's private
      // credential store. A missing/revoked ticket falls back to the QR flow.
      void (async () => {
        if (!expectedSelfId || typeof login.getLoginList !== 'function') return;
        const records = await login.getLoginList();
        if (!active) return;
        const account = records?.LocalLoginInfoList?.find(item => item.uin === expectedSelfId && item.isQuickLogin === true && isUid(item.uid));
        if (!account) return;
        const result = await login.quickLoginWithUin(expectedSelfId);
        if (active && result?.result === '0') authenticate(account);
      })().catch(() => {}).finally(() => { connectResolve?.({ attemptId }); connectResolve = null; });
    });
    listener.onLoginDisConnected = bound(() => { connected = false; state('disconnected'); active = false; });
    listener.onQRCodeGetPicture = bound(value => {
      const base64 = typeof value?.pngBase64QrcodeData === 'string' ? value.pngBase64QrcodeData.replace(/^data:image\/png;base64,/, '') : '';
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length > 384 * 1024) { fail('QR_INVALID'); return; }
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length <= 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { fail('QR_INVALID'); return; }
      emit('qr', { dataUrl: 'data:image/png;base64,' + base64, expiresAt: now() + 90_000 });
    });
    listener.onQRCodeSessionUserScaned = bound(() => state('awaiting_confirmation'));
    listener.onQRCodeLoginSucceed = bound(result => { try { authenticate(result); } catch { fail('NATIVE_SESSION_FAILED'); } });
    listener.onQRCodeSessionFailed = bound(() => { if (!self) { state('expired'); active = false; } });
    for (const name of ['onLoginFailed', 'onLogoutSucceed', 'onUserLoggedIn', 'onQRCodeSessionQuickLoginFailed', 'onPasswordLoginFailed', 'OnConfirmUnusualDeviceFailed', 'onQQLoginNumLimited']) listener[name] = bound(() => fail('NATIVE_LOGIN_FAILED'));
    login.addKernelLoginListener(listener);
    return { attemptId };
  }
  async function onebot(params) {
    if (!connected || !active || !self) throw issue('PLUGIN_UNAVAILABLE');
    const ownedAttempt = attemptId;
    const requireConnection = () => { requireAttempt(ownedAttempt); if (!connected) throw issue('PLUGIN_UNAVAILABLE'); };
    const { action, echo } = params;
    if (typeof echo !== 'string' || !echo || echo.length > 200) throw issue('INPUT');
    if (action === 'get_login_info') { await verifyLiveIdentity(); reply(echo, { user_id: self.uin }); return { attemptId }; }
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
    seen.add('send:' + echo); outgoing.set(unique, { echo, peerUid, done: false });
    try {
      const result = await messages.sendMsg('0', { chatType: 1, peerUid, guildId: unique }, [{ elementType: 1, elementId: '', textElement: { content: params.params.message, atType: 0, atUid: '', atTinyId: '', atNtUid: '' } }], new Map());
      if (Number.isInteger(result?.result) && result.result !== 0) { const pending=outgoing.get(unique); if (pending && !pending.done) { pending.done=true; outgoing.delete(unique); reply(echo, {}, true); } }
    } catch { /* An ambiguous native submission never becomes a false failure. */ }
    return { attemptId };
  }
  async function verifyLiveIdentity() {
    const mapped = await session.getProfileService().getUinByUid('momo-self-verification', [self.uid]);
    if (!(mapped instanceof Map) || String(mapped.get(self.uid) ?? '') !== self.uin || !connected || !active) throw issue('IDENTITY_UNVERIFIED');
  }
  return {
    async request(method, params = {}) {
      if (method === 'prepare') return prepare(params.attemptId, params.expectedSelfId);
      if (method === 'onebot') return onebot(params);
      if (method === 'status') return { attemptId, connected, selfId: connected ? self.uin : null };
      if (method === 'cancel' || method === 'stop') {
        if (params.attemptId !== undefined && params.attemptId !== attemptId) throw issue('ATTEMPT_CANCELLED');
        active = false; connected = false;
        try { login?.abortPolling(); login?.cancel(); } catch {}
        connectResolve?.({ attemptId }); connectResolve = null;
        if (method === 'stop') { stopped = true; try { startup?.stop?.(); } catch {} }
        return { attemptId, stopped: method === 'stop' };
      }
      requireAttempt(params.attemptId);
      if (method === 'connect') {
        if (connectPromise) return connectPromise;
        connectPromise = new Promise(resolve => { connectResolve = resolve; });
        if (login.connect() !== true) throw issue('NATIVE_CONNECT_FAILED');
        return connectPromise;
      }
      if (method === 'requestQr') { if (!self && login.getQRCodePicture() !== true) throw issue('NATIVE_QR_FAILED'); return { attemptId }; }
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
    if (Buffer.byteLength(buffer) > 1024 * 1024) process.exit(81);
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
