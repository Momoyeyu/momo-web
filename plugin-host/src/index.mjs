import { createInterface } from 'node:readline';
import { PluginHost, HostError } from './host.mjs';

const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const host = new PluginHost({ emit: write });
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  input.close();
  await host.close();
  process.exitCode = 0;
}
input.on('line', line => {
  if (closing) return;
  let message;
  try {
    if (Buffer.byteLength(line) > 20 * 1024 * 1024) throw new HostError('PROTOCOL', 'Message exceeds protocol size limit');
    message = JSON.parse(line);
  } catch {
    write({ v: 1, id: null, ok: false, error: { code: 'PROTOCOL', message: 'Invalid protocol message' } });
    return;
  }
  void host.request(message).then(result => {
    write({ v: 1, id: message.id, ok: true, result });
    if (message.method === 'shutdown') void shutdown();
  }, error => {
    write({ v: 1, id: message.id, ok: false, error: { code: error instanceof HostError ? error.code : 'INTERNAL', message: error instanceof HostError ? error.message : 'Host request failed' } });
  });
});
input.on('close', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
process.stdout.on('error', () => { void shutdown(); });
// Never print exception objects: they may contain a transport URL, headers, or user content.
process.on('uncaughtException', () => { process.stderr.write('Plugin host stopped after an internal failure\n'); void shutdown(); });
process.on('unhandledRejection', () => { process.stderr.write('Plugin host stopped after an internal failure\n'); void shutdown(); });
