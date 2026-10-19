// TTS 客户端单测：后端代理协议（X-Sample-Rate 头 + s16le 偶数对齐 + 错误映射）。
// 端点固定为 /api/tts/speech，不再有 URL 拼接逻辑（引擎细节归 backend）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "../lib/errors";
import { streamSpeech } from "./ttsClient";

const LANG = "zh";

function streamResponse(chunks: Uint8Array[], sr = 32000): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "x-sample-rate": String(sr) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamSpeech", () => {
  it("把采样率头交给调用方（早于第一个 chunk）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([new Uint8Array([1, 2])], 48000)));
    const order: string[] = [];
    let sr = 0;
    await streamSpeech("hi", {
      lang: LANG,
      onSampleRate: (hz) => {
        sr = hz;
        order.push(`sr:${hz}`);
      },
      onChunk: () => order.push("chunk"),
    });
    expect(sr).toBe(48000);
    expect(order[0]).toBe("sr:48000");
    expect(order).toContain("chunk");
  });

  it("缺头时回落 24000", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2]));
        c.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));
    let sr = 0;
    await streamSpeech("hi", {
      lang: LANG,
      onSampleRate: (hz) => (sr = hz),
      onChunk: () => {},
    });
    expect(sr).toBe(24000);
  });

  it("chunk 对齐到偶数 s16 字节边界", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamResponse([new Uint8Array([1]), new Uint8Array([2, 3]), new Uint8Array([4, 5])]),
      ),
    );
    const got: number[][] = [];
    await streamSpeech("hi", {
      lang: LANG,
      onChunk: (pcm) => got.push([...pcm]),
    });
    expect(got).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("后端 503 的 detail 映射成 ServiceError(http)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: "未配置参考音频（音色）" }), {
            status: 503,
          }),
      ),
    );
    const err = await streamSpeech("hi", { lang: LANG, onChunk: () => {} }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({ service: "tts", failure: "http", status: 503 });
    expect((err as Error).message).toContain("未配置参考音频");
  });

  it("网络失败 → ServiceError(unreachable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const err = await streamSpeech("hi", { lang: LANG, onChunk: () => {} }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({ service: "tts", failure: "unreachable" });
  });

  it("abort 时静默结束（不抛错）", async () => {
    const ctl = new AbortController();
    ctl.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }),
    );
    await expect(
      streamSpeech("hi", { lang: LANG, signal: ctl.signal, onChunk: () => {} }),
    ).resolves.toBeUndefined();
  });

  it("请求体只带 input/lang（参考音频由后端管理）", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)));
        return streamResponse([new Uint8Array([1, 2])]);
      }),
    );
    await streamSpeech("你好", { lang: "ja", onChunk: () => {} });
    expect(calls[0]).toEqual({ input: "你好", lang: "ja" });
  });
});
