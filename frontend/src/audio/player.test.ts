import { afterEach, expect, it, vi } from 'vitest';
import { TtsPlayer } from './player';
afterEach(() => vi.unstubAllGlobals());
it('releases the playback queue when browser autoplay remains suspended', async () => {
  vi.stubGlobal('AudioContext', class {
    state = 'suspended';
    audioWorklet = {addModule: async () => {}};
    resume() { return new Promise<void>(() => {}); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  });
  vi.stubGlobal('AudioWorkletNode', class { constructor() { throw new Error('Should not create a node for blocked autoplay'); } });
  const player = new TtsPlayer();
  const unavailable = vi.fn();
  player.onUnavailable = unavailable;
  player.push(new Uint8Array(480));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(unavailable).toHaveBeenCalledOnce();
  expect(player.playing).toBe(false);
  player.dispose();
});
