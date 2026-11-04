/** Managed offline execution adapter; Internet networking is unavailable. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const run = (args, input = '') => new Promise((resolve, reject) => {
  const child = execFile('docker', args, { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  child.stdin.end(input);
});
export class BrowserPrototype {
  constructor(checkPermit, execute = run) { this.execute = execute; this.checkPermit = checkPermit; this.name = 'momo-browser-probe-' + randomUUID(); this.generation = 0; this.active = false; this.version = 0; this.busy = false; this.elements = new Map(); }
  async start() {
    await this.execute(['run','--pull','never','-d','--name',this.name,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','512m','--cpus','1','--tmpfs','/tmp:rw,noexec,nosuid,size=128m','momo-browser-prototype:local']);
    this.active = true; this.started = Date.now(); this.count = 0;
    this.expiry = setTimeout(() => { void this.stop().catch(() => {}); }, 120000);
    this.expiry.unref();
  }
  async action(command, permit, expectedVersion) {
    this.checkPermit(permit);
    if (!this.active || this.busy || this.count >= 30 || Date.now()-this.started > 120000) throw new Error('PROBE_UNAVAILABLE');
    if (!['load','observe','inspect','click','type','scroll','elementClick','elementFill'].includes(command.action)) throw new Error('UNSUPPORTED_ACTION');
    if (command.action !== 'load' && !['observe','inspect'].includes(command.action) && (expectedVersion !== this.version || Date.now()-this.observed > 15000)) throw new Error('STALE_OBSERVATION');
    if (['elementClick','elementFill'].includes(command.action)) {
      const target = this.elements.get(command.elementId);
      if (!target || command.action === 'elementFill' && !['textbox','searchbox','combobox'].includes(target.role)) throw new Error('UNKNOWN_ELEMENT');
      command = { action: command.action, backendNodeId: target.backendNodeId, text: command.text };
    }
    this.elements.clear();
    const generation = this.generation;
    this.busy = true; this.count++;
    try {
      const result = JSON.parse(await this.execute(['exec','-i',this.name,'python3','/opt/action.py'], JSON.stringify(command)));
      this.checkPermit(permit);
      if (!this.active || generation !== this.generation) throw new Error('REVOKED');
      this.observed = Date.now(); this.version++;
      if (Array.isArray(result.elements)) {
        result.elements = result.elements.slice(0,60).map(element => {
          const id = randomUUID();
          this.elements.set(id, element);
          return { id, role: String(element.role).slice(0,40), name: String(element.name).slice(0,160) };
        });
      }
      return { ...result, version: this.version, observedAt: this.observed, source: this.name };
    } finally { this.busy = false; }
  }
  async stop() {
    if (this.stopPromise) { await this.stopPromise; return { stopped: true, generation: this.generation }; }
    clearTimeout(this.expiry);
    this.generation++; this.active = false; this.elements.clear();
    this.stopPromise = this.execute(['rm','-f',this.name]);
    try { await this.stopPromise; }
    catch (error) { this.stopPromise = null; throw error; }
    // rm success means the exact owned container was killed and removed.
    return { stopped: true, generation: this.generation };
  }
}
