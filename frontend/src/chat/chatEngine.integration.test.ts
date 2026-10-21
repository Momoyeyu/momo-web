// 引擎 × 真实 chatClient 的集成守卫。
//
// 为什么单开一个文件：chatEngine.test.ts 用 vi.mock 把 chatClient 整体替换掉了，
// 于是「引擎消费真实 SSE」这条路径在单测里零覆盖 —— P0（chat() 收到第一个 sentence
// 就结束流，导致每回合只上屏第一句）正是从这个缝里逃逸的：一边用假事件测引擎、
// 一边用真 SSE 测客户端，**两边对 ChatEvent 形状的假设没有任何测试绑定**。
//
// 这里只 stub 全局 fetch，喂后端真实形状的多句 SSE。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSettings, update } from "../lib/store";
import { ChatEngine } from "./chatEngine";

const sentence = (no: number, text: string) => ({
  t: "sentence",
  no,
  text,
  cues: [],
  at: "2026-01-01T00:00:00+00:00",
});

function sse(frames: unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`));
      }
      c.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** 只应答 /api/chat 与 /api/chat/interrupt；其余（TTS 等）404，避免真去合成。 */
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/chat/interrupt")) return new Response(null, { status: 204 });
      if (u.includes("/api/chat")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as { text?: string };
        return body.text === "炸" ? sse([{ t: "error", message: "模型炸了" }]) : sse(frames);
      }
      return new Response(null, { status: 404 });
    }),
  );
}

let frames: unknown[] = [];

function makeEngine() {
  const sentences: string[] = [];
  const errors: Error[] = [];
  const engine = new ChatEngine({
    onStatus: () => {},
    onUserMessage: () => {},
    onAssistantStart: () => {},
    onDisplay: () => {},
    onSentence: (m) => sentences.push(m.text),
    onAssistantDone: () => {},
    onError: (e) => errors.push(e),
  });
  return { engine, sentences, errors };
}

beforeEach(() => {
  frames = [
    sentence(0, "第一句。"),
    sentence(1, "第二句。"),
    sentence(2, "第三句。"),
    { t: "done" },
  ];
  // 引擎在 llm.url 为空时会拒绝发回合；TTS 地址留空以免真的去合成
  update({
    settings: {
      ...getSettings(),
      llm: { url: "http://llm.test", key: "", model: "test-model" },
      tts: { url: "", key: "", voice: "", prompt: "" },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("引擎消费真实 SSE（不 mock chatClient）", () => {
  it("一个回合的多句全部送达引擎 —— P0 回归守卫", async () => {
    stubFetch();
    const { engine, sentences } = makeEngine();

    engine.sendText("你好");
    await vi.waitFor(() => expect(sentences).toHaveLength(3));
    expect(sentences).toEqual(["第一句。", "第二句。", "第三句。"]);
  });

  it("error 事件 → onError（调用方的映射路径）", async () => {
    stubFetch();
    const { engine, errors } = makeEngine();

    engine.sendText("炸");
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
    expect(errors.some((e) => String(e.message).includes("模型炸了"))).toBe(true);
  });
});
