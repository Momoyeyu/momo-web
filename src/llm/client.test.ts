import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmConfig } from "../lib/types";
import { chatCompletionsUrl, streamChat } from "./client";

const cfg = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  url: "https://api.deepseek.com",
  key: "",
  model: "m",
  ...over,
});

const enc = new TextEncoder();

function sseBody(...lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
}

function chunk(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chatCompletionsUrl", () => {
  it("空 path 补 /chat/completions", () => {
    expect(chatCompletionsUrl(cfg({ url: "https://api.deepseek.com" }))).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
  });

  it("根路径 / 补 /v1/chat/completions", () => {
    expect(chatCompletionsUrl(cfg({ url: "https://api.deepseek.com/" }))).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
  });

  it("以 /v1 结尾追加 /chat/completions", () => {
    expect(chatCompletionsUrl(cfg({ url: "https://api.deepseek.com/v1" }))).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
    expect(
      chatCompletionsUrl(cfg({ url: "https://api.deepseek.com/v1/" })),
    ).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(
      chatCompletionsUrl(cfg({ url: "http://localhost:8080/openai/v1" })),
    ).toBe("http://localhost:8080/openai/v1/chat/completions");
  });

  it("已含 /chat/completions 原样", () => {
    const u = "https://x.com/v1/chat/completions";
    expect(chatCompletionsUrl(cfg({ url: u }))).toBe(u);
  });

  it("其它 path 按 base-URL 语义补全", () => {
    expect(chatCompletionsUrl(cfg({ url: "http://h:1/proxy/path" }))).toBe(
      "http://h:1/proxy/path/v1/chat/completions",
    );
  });
});

describe("streamChat", () => {
  it("累积 delta 并回调，[DONE] 结束", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        sseBody(chunk("你好"), chunk("呀"), "data: [DONE]\n\n", chunk("不应出现")),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const deltas: string[] = [];
    const text = await streamChat(
      cfg({ key: "k1" }),
      [{ role: "user", content: "hi" }],
      { onDelta: (d) => deltas.push(d) },
    );

    expect(text).toBe("你好呀");
    expect(deltas).toEqual(["你好", "呀"]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer k1");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string) as {
      model: string;
      stream: boolean;
      messages: unknown[];
    };
    expect(body.model).toBe("m");
    expect(body.stream).toBe(true);
    expect(body.messages).toHaveLength(1);
  });

  it("key 为空不带 Authorization", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(sseBody("data: [DONE]\n\n")));
    vi.stubGlobal("fetch", fetchMock);
    await streamChat(cfg(), [{ role: "user", content: "x" }], {
      onDelta: () => {},
    });
    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("HTTP 非 2xx 抛出 OpenAI 信封 error.message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "bad key" } }), {
          status: 401,
        }),
      ),
    );
    await expect(
      streamChat(cfg(), [{ role: "user", content: "x" }], { onDelta: () => {} }),
    ).rejects.toThrow("bad key");
  });

  it("非 JSON 错误体兜底 HTTP 状态码", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("oops", { status: 500 })),
    );
    await expect(
      streamChat(cfg(), [{ role: "user", content: "x" }], { onDelta: () => {} }),
    ).rejects.toThrow("500");
  });

  it("abort 返回已累积部分不 throw", async () => {
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!pulled) {
          pulled = true;
          c.enqueue(enc.encode(chunk("前半")));
        } else {
          c.error(new DOMException("aborted", "AbortError"));
        }
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
    const got: string[] = [];
    const text = await streamChat(cfg(), [{ role: "user", content: "x" }], {
      onDelta: (d) => got.push(d),
    });
    expect(text).toBe("前半");
    expect(got).toEqual(["前半"]);
  });

  it("fetch 直接 AbortError 返回空串", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")),
    );
    await expect(
      streamChat(cfg(), [{ role: "user", content: "x" }], { onDelta: () => {} }),
    ).resolves.toBe("");
  });

  it("非字符串 delta 不回调", async () => {
    const raw =
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
      chunk("好");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sseBody(raw))));
    const got: string[] = [];
    await streamChat(cfg(), [{ role: "user", content: "x" }], {
      onDelta: (d) => got.push(d),
    });
    expect(got).toEqual(["好"]);
  });
});
