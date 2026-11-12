let bridgeEpoch = Date.now();
/** Bounded Fabric transport adapter. No inference, login, downloads, or code execution. */
export function createMinecraftAdapter({ transport, authorize, now = Date.now } = {}) {
  let epoch = ++bridgeEpoch;
  let stopped = true;
  let stopVerified = false;
  let observation = null;
  let busy = false;
  const controls = new Set(['respawn', 'screenClick', 'screenScroll', 'screenText', 'screenKey', 'resume', 'forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint', 'look', 'attack', 'mine', 'use', 'eat', 'hotbar', 'inventory', 'close', 'slot', 'quickMove', 'drop', 'swapHands']);
  const movement = new Set(['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']);
  const available = () => Boolean(transport && typeof transport.request === 'function' && typeof authorize === 'function');
  const status = () => ({ available: available(), stopped, stopVerified, epoch, runtime: 'fabric', liveValidated: false });
  async function request(command) {
    let timeout;
    try {
      return await Promise.race([
        transport.request(command),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Minecraft bridge timed out')), 3000); }),
      ]);
    } finally { clearTimeout(timeout); }
  }
  async function stop() {
    epoch = bridgeEpoch = Math.max(bridgeEpoch, epoch) + 1;
    stopped = true;
    stopVerified = false;
    observation = null;
    if (!available()) return status();
    const version = epoch;
    const result = await request({ type: 'stop', epoch: version });
    stopVerified = epoch === version && result?.epoch === version && result?.stopped === true && result?.heldControls === 0;
    if (!stopVerified) throw new Error('Minecraft stop was not acknowledged');
    return status();
  }
  async function execute(type, args, permission) {
    if (!available()) throw new Error('Managed Fabric runtime is not installed');
    if (busy) throw new Error('Minecraft action already in progress');
    const version = epoch;
    busy = true;
    try {
      const grant = await authorize({ type, permission });
      if (!grant || version !== epoch) throw new Error('Minecraft authorization revoked');
      if (!permission?.world || !permission?.account) throw new Error('Minecraft world and account must be bound');
      if (type !== 'observe' && (!observation || observation.world !== permission.world || observation.account !== permission.account || now() - observation.observedAt > (type === 'play' ? 30000 : 2000))) throw new Error('Fresh matching Minecraft observation required');
      stopped = false;
      stopVerified = false;
      const result = await request({ type, ...args, epoch: version, world: permission.world, account: permission.account, leaseMs: 1500 });
      if (version !== epoch) throw new Error('Late Minecraft result rejected');
      if (result?.epoch !== version || result?.world !== permission.world || result?.account !== permission.account) throw new Error('Minecraft bridge identity mismatch');
      if (type === 'observe') {
        if (!Number.isFinite(result.observedAt) || now() - result.observedAt > 2000 || result.observedAt > now()) throw new Error('Stale Minecraft observation');
        observation = { ...result, source: 'minecraft-fabric', untrusted: true };
        return observation;
      }
      return result;
    } catch (error) {
      // Stop invalidates in-flight work; do not silently restore authority on late replies.
      if (version === epoch) { try { await stop(); } catch { /* status exposes unverified stop */ } }
      throw error;
    } finally { busy = false; }
  }
  return {
    status, stop,
    observe: permission => execute('observe', {}, permission),
    chat(text, permission) {
      if (typeof text !== 'string' || !text.trim() || text.length > 256 || /[\r\n\x00-\x1f]/u.test(text) || text.trimStart().startsWith('/')) return Promise.reject(new Error('Only bounded plain Minecraft chat is allowed'));
      return execute('chat', { text }, permission);
    },
    play({ control, held = [], durationMs = 500, yaw = 0, pitch = 0, slot = 0, button = 0, x = 0.5, y = 0.5, scroll = 0, text = '', key = 'enter' }, permission) {
      if (!controls.has(control) || !Array.isArray(held) || held.length > 7 || held.some(key => !movement.has(key))
          || !Number.isInteger(durationMs) || durationMs < 1 || durationMs > 10000
          || !Number.isFinite(yaw) || Math.abs(yaw) > 180 || !Number.isFinite(pitch) || Math.abs(pitch) > 90
          || !Number.isInteger(slot) || slot < 0 || slot > (control === 'hotbar' ? 8 : 255)
          || ![0, 1].includes(button)
          || !Number.isFinite(x) || x < 0 || x > 1 || !Number.isFinite(y) || y < 0 || y > 1
          || !Number.isFinite(scroll) || Math.abs(scroll) > 10
          || typeof text !== 'string' || text.length > 256 || /[\r\n\x00-\x1f]/u.test(text) || text.trimStart().startsWith('/')
          || !['enter', 'backspace', 'tab', 'left', 'right', 'up', 'down'].includes(key)) return Promise.reject(new Error('Invalid gameplay input'));
      return execute('play', { control, held, durationMs, yaw, pitch, slot, button, x, y, scroll, text, key }, permission);
    },
    follow(player, durationMs, permission) {
      if (!/^[A-Za-z0-9_]{1,16}$/u.test(player) || !Number.isInteger(durationMs) || durationMs < 1 || durationMs > 1000) return Promise.reject(new Error('Invalid bounded follow request'));
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
