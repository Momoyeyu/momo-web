import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("migrates retired service secrets out of local state and persistence", async () => {
  vi.resetModules();
  const saved = new Map<string, string>();
  saved.set("momo-web.v1", JSON.stringify({ settings: {
    llm: { url: "https://api.deepseek.com", key: "keep", model: "deepseek-chat" },
    tts: { url: "http://tts.local", key: "keep-tts", voice: "voice.wav" },
    asr: { mode: "openai", url: "http://asr.local", key: "retired-asr" },
    embedding: { url: "http://embed.local", key: "retired-embedding" },
    general: { voiceInput: false },
  }}));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
  const { getState, update } = await import("./store");
  const state = getState();
  expect(state.settings).not.toHaveProperty("asr");
  expect(state.settings).not.toHaveProperty("embedding");
  expect(state.settings.llm).toEqual({ url: "https://api.deepseek.com", key: "keep", model: "deepseek-chat", thinking: false });
  expect(state.settings.general.voiceInput).toBe(false);
  expect(state.settings.tts.voice).toBe("voice.wav");
  update({});
  expect(saved.get("momo-web.v1")).not.toContain("retired-asr");
  expect(saved.get("momo-web.v1")).not.toContain("retired-embedding");
});
