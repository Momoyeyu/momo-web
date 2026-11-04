// One short synthesis per effective voice. Keep PCM only while a listener is
// waiting: a silent warmup never enters playback, history or persistent state.
import { s16leToFloat32 } from "../audio/pcm";
import { resolveChatLang, tFor } from "../i18n";
import { getState, flushPendingState } from "../lib/store";
import { ttsConfigured } from "../lib/asr";
import { streamSpeech } from "./ttsClient";

const freshnessMs = 5 * 60_000;
const retryMs = 15_000;
type Listener = (chunk: Uint8Array, rate: number) => void;
type Sample = { rate: number; chunks: Uint8Array[]; listener?: Listener };
let flight: { key: string; controller: AbortController; sample: Sample; result: Promise<Sample> } | undefined;
let recent = { key: "", until: 0 };

export function cancelWarmup() {
  flight?.controller.abort();
  flight = undefined;
}

export function invalidateWarmup() {
  cancelWarmup();
  recent = { key: "", until: 0 };
}

function prepareVoice(listener?: Listener): Promise<Sample | undefined> {
  const { general, tts } = getState().settings;
  if (!ttsConfigured(tts)) return Promise.resolve(undefined);
  const lang = resolveChatLang(general);
  const key = JSON.stringify([tts.url, tts.key, tts.voice, tts.prompt, lang]);
  if (flight?.key === key) {
    if (listener) {
      flight.sample.listener = listener;
      for (const chunk of flight.sample.chunks) listener(chunk, flight.sample.rate);
    }
    return flight.result;
  }
  cancelWarmup();
  if (!listener && recent.key === key && Date.now() < recent.until) return Promise.resolve(undefined);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
  const sample: Sample = { rate: 0, chunks: [], listener };
  const result = (async () => {
    await flushPendingState(); // speech reads the committed configuration on the server
    signal.throwIfAborted();
    await streamSpeech(tFor(lang, "title.tagline"), {
      lang, signal,
      onSampleRate: rate => { sample.rate = rate; },
      onChunk: chunk => { sample.chunks.push(chunk); sample.listener?.(chunk, sample.rate); },
    });
    signal.throwIfAborted();
    if (!sample.chunks.length) throw new Error("Empty speech");
    recent = { key, until: Date.now() + freshnessMs };
    return sample;
  })().catch(error => {
    if (!controller.signal.aborted) recent = { key, until: Date.now() + retryMs };
    throw error;
  }).finally(() => {
    if (flight?.controller === controller) flight = undefined;
  });
  flight = { key, controller, sample, result };
  return result;
}

export function warmVoice() {
  void prepareVoice().catch(() => {}); // optional background work
}

export async function auditionVoice(signal: AbortSignal) {
  const { tts, general } = getState().settings;
  if (!tts.url.trim()) return { ok: false, detail: "unconfigured" };
  if (!tts.voice) return { ok: false, detail: "未上传参考音频" };
  signal.throwIfAborted();
  const audio = new AudioContext();
  let ownedFlight: typeof flight;
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const stop = () => { if (audio.state !== "closed") void audio.close().catch(() => {}); };
  const onAbort = () => {
    stop();
    if (ownedFlight && flight === ownedFlight) {
      ownedFlight.sample.listener = undefined;
      cancelWarmup();
    }
    rejectAbort(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const gain = audio.createGain();
    gain.gain.value = general.voiceVolume / 100;
    gain.connect(audio.destination);
    let endAt = 0;
    let lastSource: AudioBufferSourceNode | undefined;
    const play = (chunk: Uint8Array, rate: number) => {
      if (signal.aborted) return;
      const buffer = audio.createBuffer(1, chunk.length / 2, rate);
      buffer.getChannelData(0).set(s16leToFloat32(chunk));
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      const start = Math.max(audio.currentTime, endAt);
      source.start(start);
      endAt = start + buffer.duration;
      lastSource = source;
    };
    const prepared = prepareVoice(play);
    ownedFlight = flight;
    const [sample] = await Promise.race([Promise.all([prepared, audio.resume()]), aborted]);
    signal.throwIfAborted();
    if (!sample || !lastSource) throw new Error("Missing voice");
    if (endAt > audio.currentTime) {
      const last = lastSource;
      await new Promise<void>(resolve => {
        last.onended = () => resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return { ok: !signal.aborted, detail: "" };
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (ownedFlight) ownedFlight.sample.listener = undefined;
    stop();
  }
}
