import { afterEach, expect, it, vi } from "vitest";
import { auditionVoice, invalidateWarmup, warmVoice } from "./ttsWarmup";
import { streamSpeech } from "./ttsClient";
import { tFor } from "../i18n";
const { settings } = vi.hoisted(() => ({ settings: {
  general: { lang: "en", chatLang: "auto", voiceVolume: 80 },
  tts: { url: "http://voice", key: "", voice: "ref.wav", prompt: "" },
} }));
vi.mock("../lib/store", () => ({ getState: () => ({ settings }), getSettings: () => settings, flushPendingState: async () => {} }));
vi.mock("../lib/asr", () => ({ ttsConfigured: () => true }));
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
it.each(["zh", "en", "ja"] as const)("uses the title slogan for %s synthesis", async lang => {
  settings.general.lang = lang;
  vi.mocked(streamSpeech).mockImplementation(async (_text, options) => {
    options.onSampleRate?.(24000);
    options.onChunk(new Uint8Array([0, 0]));
  });
  warmVoice();
  await vi.waitFor(() => expect(streamSpeech).toHaveBeenCalledWith(tFor(lang, "title.tagline"), expect.objectContaining({ lang })));
});
