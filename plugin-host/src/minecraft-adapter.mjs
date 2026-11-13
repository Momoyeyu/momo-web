import {validateSkill} from './minecraft-skills.mjs';
let bridgeEpoch = Date.now();
const problem=(message,code='MINECRAFT_INPUT')=>Object.assign(new Error(message),{code});
const publicCodes=new Set(['MINECRAFT_INPUT','MINECRAFT_STALE','MINECRAFT_REVOKED','MINECRAFT_UNKNOWN','MINECRAFT_BUSY']);
// Preserve known pre-dispatch rejection without exposing arbitrary transport diagnostics.
export const minecraftErrorCode=error=>publicCodes.has(error?.code)?error.code:'MINECRAFT_UNKNOWN';
/** Bounded Fabric transport adapter. No inference, login, downloads, or code execution. */
export function createMinecraftAdapter({ transport, authorize, now = Date.now } = {}) {
  let epoch = ++bridgeEpoch;
  let stopped = true;
  let stopVerified = false;
  let observation = null;
  let aimAvailable = false;
  let busy = false;
  let readers = 0;
  let capabilities = null;
  const ownedTasks=new Set(),retiredTasks=new Map();
  const collectRetired=result=>{for(const task of result?.retiredTasks??[])if(ownedTasks.has(task.taskId))retiredTasks.set(task.taskId,task);};
  const taskReads = new Set(['capabilities', 'recipes', 'task', 'events', 'heartbeat']);
  const continuous = new Set([...taskReads, 'submit', 'pause', 'resumeTask', 'cancel']);
  const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(id);
  const controls = new Set(['aim', 'respawn', 'screenClick', 'screenScroll', 'screenText', 'screenKey', 'resume', 'forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint', 'look', 'attack', 'mine', 'use', 'eat', 'hotbar', 'inventory', 'close', 'slot', 'quickMove', 'drop', 'swapHands']);
  const movement = new Set(['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']);
  const available = () => Boolean(transport && typeof transport.request === 'function' && typeof authorize === 'function');
  const status = () => ({ available: available(), stopped, stopVerified, epoch, runtime: 'fabric', liveValidated: false });
  async function request(command) {
    let timeout;
    try {
      return await Promise.race([
        transport.request(command),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(problem('Minecraft bridge timed out','MINECRAFT_UNKNOWN')), 3000); }),
      ]);
    } finally { clearTimeout(timeout); }
  }
  async function stop() {
    epoch = bridgeEpoch = Math.max(bridgeEpoch, epoch) + 1;
    stopped = true;
    stopVerified = false;
    observation = null;
    capabilities = null;
    aimAvailable = false;
    if (!available()) return status();
    const version = epoch;
    const result = await request({ type: 'stop', epoch: version });
    stopVerified = epoch === version && result?.epoch === version && result?.stopped === true && result?.heldControls === 0;
    if (!stopVerified) throw problem('Minecraft stop was not acknowledged','MINECRAFT_UNKNOWN');
    collectRetired(result);
    return {...status(),retiredTasks:[...retiredTasks.values()]};
  }
  async function execute(type, args, permission) {
    if (!available()) throw new Error('Managed Fabric runtime is not installed');
    const read = taskReads.has(type);
    if (read ? readers >= 2 : busy) throw problem('Minecraft action already in progress','MINECRAFT_BUSY');
    const version = epoch;
    let dispatched=false;
    if (read) readers++; else busy = true;
    try {
      const grant = await authorize({ type, permission });
      if (!grant || version !== epoch) throw problem('Minecraft authorization revoked','MINECRAFT_REVOKED');
      if (!permission?.world || !permission?.account) throw new Error('Minecraft world and account must be bound');
      if (!continuous.has(type) && type !== 'observe' && (!observation || observation.world !== permission.world || observation.account !== permission.account || now() - observation.observedAt > (type === 'play' ? 30000 : 2000))) throw problem('Fresh matching Minecraft observation required','MINECRAFT_STALE');
      stopped = false;
      stopVerified = false;
      if(type==='submit')ownedTasks.add(args.taskId);
      dispatched=true;
      const result = await request({ type, ...args, epoch: version, world: permission.world, account: permission.account, leaseMs: continuous.has(type) ? 10000 : 1500 });
      if (version !== epoch) throw new Error('Late Minecraft result rejected');
      if (result?.epoch !== version || result?.world !== permission.world || result?.account !== permission.account) throw new Error('Minecraft bridge identity mismatch');
      collectRetired(result);
      if(type==='follow'&&result?.task?.taskId)ownedTasks.add(result.task.taskId);
      if (type === 'capabilities') {
        if (result.taskProtocol !== 1 || !Array.isArray(result.skills) || result.skills.some(skill => typeof skill !== 'string')) throw new Error('Unsupported Minecraft task protocol');
        capabilities = {world: permission.world, account: permission.account, skills: [...result.skills]};
      }
      if (type === 'observe') {
        if (!Number.isFinite(result.observedAt) || now() - result.observedAt > 2000 || result.observedAt > now()) throw new Error('Stale Minecraft observation');
        observation = { ...result, source: 'minecraft-fabric', untrusted: true };
        aimAvailable = true;
        return observation;
      }
      if (type === 'play' || type === 'follow') aimAvailable = false;
      return result;
    } catch (error) {
      // Stop invalidates in-flight work; do not silently restore authority on late replies.
      if (version === epoch && (dispatched || error.code==='MINECRAFT_REVOKED')) { try { await stop(); } catch { /* status exposes unverified stop */ } }
      if(!error.code)error.code=dispatched?'MINECRAFT_UNKNOWN':'MINECRAFT_INPUT';
      throw error;
    } finally { if (read) readers--; else busy = false; }
  }
  return {
    status, stop,
    capabilities: permission => execute('capabilities', {}, permission),
    recipes(query, permission) {
      if(typeof query !== 'string' || query.length > 64 || /[\x00-\x1f]/u.test(query))return Promise.reject(problem('Invalid recipe query'));
      return execute('recipes',{query},permission);
    },
    submit({ taskId, skill, args = {} }, permission) {
      if (!capabilities || capabilities.world !== permission?.world || capabilities.account !== permission?.account || !capabilities.skills.includes(skill))
        return Promise.reject(problem('Unsupported Minecraft skill; query capabilities first'));
      if (!validId(taskId)) return Promise.reject(problem('Invalid Minecraft task'));
      try {validateSkill(skill,args);} catch(error) {return Promise.reject(problem(error.message));}
      return execute('submit', {taskId, skill, args, ...(skill === 'navigate' ? args : {})}, permission);
    },
    task(taskId, permission) {
      if (taskId !== null && !validId(taskId)) return Promise.reject(problem('Invalid task identifier'));
      return execute('task', taskId === null ? {} : {taskId}, permission);
    },
    events(after, permission) {
      if (!Number.isSafeInteger(after) || after < 0) return Promise.reject(problem('Invalid event cursor'));
      return execute('events', {after}, permission);
    },
    heartbeat: permission => execute('heartbeat', {}, permission),
    pause: permission => execute('pause', {}, permission),
    resume(permission, issuedAt = 0) {
      if(!Number.isSafeInteger(issuedAt)||issuedAt<0||issuedAt>now()+5000)return Promise.reject(problem('Invalid player input time'));
      return execute('resumeTask', {issuedAt}, permission);
    },
    cancel(taskId, permission) {
      if (!validId(taskId)) return Promise.reject(problem('Invalid task identifier'));
      return execute('cancel', {taskId}, permission);
    },
    observe: permission => execute('observe', {}, permission),
    chat(text, permission) {
      if (typeof text !== 'string' || !text.trim() || text.length > 256 || /[\r\n\x00-\x1f]/u.test(text) || /^[/#]/u.test(text.trimStart())) return Promise.reject(problem('Only bounded plain Minecraft chat is allowed'));
      return execute('chat', { text }, permission);
    },
    play({ control, blockIndex = 0, held = [], durationMs = 500, yaw = 0, pitch = 0, slot = 0, button = 0, x = 0.5, y = 0.5, scroll = 0, text = '', key = 'enter' }, permission) {
      if (control === 'aim') {
        const block = aimAvailable && Number.isInteger(blockIndex) && blockIndex >= 0 && blockIndex < 8 ? observation?.visibleBlocks?.[blockIndex] : null;
        if (!block || !Number.isFinite(block.lookYaw) || Math.abs(block.lookYaw) > 180 || !Number.isFinite(block.lookPitch) || Math.abs(block.lookPitch) > 180)
          return Promise.reject(problem('Fresh visible block required'));
        return execute('play', {control:'look',yaw:block.lookYaw,pitch:Math.max(-90,Math.min(90,block.lookPitch)),durationMs:1}, permission);
      }
      if (!controls.has(control) || !Array.isArray(held) || held.length > 7 || held.some(key => !movement.has(key))
          || !Number.isInteger(durationMs) || durationMs < 1 || durationMs > 10000
          || !Number.isFinite(yaw) || Math.abs(yaw) > 180 || !Number.isFinite(pitch) || Math.abs(pitch) > 90
          || !Number.isInteger(slot) || slot < 0 || slot > (control === 'hotbar' ? 8 : 255)
          || ![0, 1].includes(button)
          || !Number.isFinite(x) || x < 0 || x > 1 || !Number.isFinite(y) || y < 0 || y > 1
          || !Number.isFinite(scroll) || Math.abs(scroll) > 10
          || typeof text !== 'string' || text.length > 256 || /[\r\n\x00-\x1f]/u.test(text) || /^[/#]/u.test(text.trimStart())
          || !['enter', 'backspace', 'tab', 'left', 'right', 'up', 'down'].includes(key)) return Promise.reject(problem('Invalid gameplay input'));
      return execute('play', { control, held, durationMs, yaw, pitch, slot, button, x, y, scroll, text, key }, permission);
    },
    follow(player, durationMs, permission) {
      if (!/^[A-Za-z0-9_]{1,16}$/u.test(player) || !Number.isInteger(durationMs) || durationMs < 1 || durationMs > 1000) return Promise.reject(problem('Invalid bounded follow request'));
      return execute('follow', { player, durationMs }, permission);
    },
  };
}

/** Credentials belong to the managed instance and must not be exposed in settings responses. */
export function createMinecraftTransport({ port = 17643, token, fetchImpl = fetch }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof token !== 'string' || token.length < 32) throw new Error('Invalid Minecraft bridge configuration');
  return { async request(command) {
    const response = await fetchImpl(`http://127.0.0.1:${port}/command`, {
      method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command), signal: AbortSignal.timeout(2800),
    });
    if (!response.ok) throw new Error('Minecraft bridge rejected command');
    const body = await response.text();
    if (body.length > 6_000_000) throw new Error('Minecraft response too large');
    return JSON.parse(body);
  } };
}
