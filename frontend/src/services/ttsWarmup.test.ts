import { afterEach, expect, it, vi } from "vitest";
import { auditionVoice, invalidateWarmup, warmVoice } from "./ttsWarmup";
import { streamSpeech } from "./ttsClient";
const { settings } = vi.hoisted(() => ({ settings: {
  general: { lang: "en", chatLang: "auto", voiceVolume: 80 },
  tts: { url: "http://voice", key: "", voice: "ref.wav", prompt: "" },
} }));
vi.mock("../lib/store", () => ({ getState: () => ({ settings }), getSettings: () => settings, flushPendingState: async () => {}, subscribe: () => () => {} }));
vi.mock("./ttsClient", () => ({ streamSpeech: vi.fn() }));
afterEach(() => { invalidateWarmup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("cancels a cold audition promptly even when synthesis never settles", async () => {
  const close = vi.fn(async () => {});
  vi.stubGlobal("AudioContext", class {
    state = "running"; destination = {};
    close = close; resume = async () => {};
    createGain = () => ({ gain: { value: 1 }, connect: () => {} });
  });
  let requestSignal: AbortSignal | undefined;
  vi.mocked(streamSpeech).mockImplementation((_text, options) => {
    requestSignal = options.signal;
    return new Promise(() => {});
  });
  const controller = new AbortController();
  const result = auditionVoice(controller.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(requestSignal).toBeDefined());
  controller.abort();
  await rejected;
  expect(requestSignal?.aborted).toBe(true);
  expect(close).toHaveBeenCalled();
});
it.each(["zh", "en", "ja"] as const)("uses the same spoken introduction for a %s interface", async lang => {
  settings.general.lang = lang;
  vi.mocked(streamSpeech).mockImplementation(async (_text, options) => {
    options.onSampleRate?.(24000);
    options.onChunk(new Uint8Array([0, 0]));
  });
  warmVoice();
  await vi.waitFor(() => expect(streamSpeech).toHaveBeenCalledWith("Hi，我是 momo", expect.objectContaining({ lang: "zh" })));
});

it("keeps a cold synthesis alive past the initial model load", async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  try {
    let requestSignal: AbortSignal | undefined;
    vi.mocked(streamSpeech).mockImplementation(async (_text, options) => {
      requestSignal = options.signal;
      await new Promise(resolve => setTimeout(resolve, 50_000));
      options.onChunk(new Uint8Array([0, 0]));
    });
    warmVoice();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(requestSignal?.aborted).toBe(false);
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
  }
});
