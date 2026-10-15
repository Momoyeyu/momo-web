import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "../lib/errors";
import { speechUrl, streamSpeech } from "./ttsClient";

const CFG = { key: "", voice: "", lang: "zh" };

function streamResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("speechUrl", () => {
  it("appends /v1/audio/speech when url has no path", () => {
    expect(speechUrl({ url: "http://127.0.0.1:7811", ...CFG })).toBe(
      "http://127.0.0.1:7811/v1/audio/speech",
    );
  });

  it("treats a bare '/' path as missing", () => {
    const u = new URL(speechUrl({ url: "http://127.0.0.1:7811/", ...CFG }));
    expect(u.pathname).toBe("/v1/audio/speech");
  });

  it("keeps an existing path untouched", () => {
    const u = new URL(speechUrl({ url: "https://tts.example.com/v1/audio/speech", ...CFG }));
    expect(u.pathname).toBe("/v1/audio/speech");
    const u2 = new URL(speechUrl({ url: "https://tts.example.com/other", ...CFG }));
    expect(u2.pathname).toBe("/other/v1/audio/speech");
  });
});

describe("streamSpeech", () => {
  it("realigns chunks to even s16le byte boundaries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamResponse([new Uint8Array([1]), new Uint8Array([2, 3]), new Uint8Array([4, 5])]),
      ),
    );
    const got: number[][] = [];
    await streamSpeech({ url: "http://h", ...CFG }, "hi", {
      onChunk: (pcm) => got.push([...pcm]),
    });
    // [1] 滞留 → [1,2] 对齐下送；[3] 滞留 → [3,4] 下送；尾 [5] 单字节丢弃。
    expect(got).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("passes through even chunks without buffering", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])])),
    );
    const got: number[][] = [];
    await streamSpeech({ url: "http://h", ...CFG }, "hi", {
      onChunk: (pcm) => got.push([...pcm]),
    });
    expect(got).toEqual([
      [1, 2, 3, 4],
      [5, 6],
    ]);
  });

  it("throws ServiceError(http) carrying status on OpenAI error envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "voice not found" } }), {
            status: 400,
          }),
      ),
    );
    const err = await streamSpeech(
      { url: "http://h", ...CFG },
      "hi",
      { onChunk: () => {} },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({
      service: "tts",
      failure: "http",
      status: 400,
    });
    expect((err as Error).message).toContain("voice not found");
  });

  it("throws ServiceError(unreachable) on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const err = await streamSpeech(
      { url: "http://h", ...CFG },
      "hi",
      { onChunk: () => {} },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({ service: "tts", failure: "unreachable" });
  });

  it("sends Authorization only when key is set", async () => {
    const spy = vi.fn(async (_url: string, _init: RequestInit) => streamResponse([]));
    vi.stubGlobal("fetch", spy);
    await streamSpeech({ url: "http://h", key: "k1", voice: "", lang: "zh" }, "hi", {
      onChunk: () => {},
    });
    const init = spy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer k1");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      input: "hi",
      response_format: "pcm",
      lang: "zh",
      model: "momo-tts",
    });
  });

  it("returns quietly when the signal aborts mid-stream", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            init.signal?.addEventListener("abort", () =>
              c.error(new DOMException("aborted", "AbortError")),
            );
            c.enqueue(new Uint8Array([1, 2]));
          },
        });
        controller.abort();
        return new Response(stream, { status: 200 });
      }),
    );
    await expect(
      streamSpeech({ url: "http://h", ...CFG }, "hi", {
        signal: controller.signal,
        onChunk: () => {},
      }),
    ).resolves.toBeUndefined();
  });
});
