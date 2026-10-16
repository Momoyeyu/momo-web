// SSE 消费的回归守卫。
//
// 背景：delta 事件退役后，一回合会连续来多个 sentence。这里曾经按旧协议写成
// 「遇到非 delta 事件就 return」（delta 曾经是 done 前最后一个事件），
// 于是**第一个句子之后就结束消费** —— 每回合只显示/朗读第一句，
// 打断时 seenText 也只有第一句，后端会把该回合其余句子从库里截掉。
// 单元测试全在 mock 这一层，所以只有这里能守住它。
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "../lib/errors";
import { chat, type ChatEvent } from "./chatClient";

/** 按给定分片喂 SSE 响应，用来同时验证分片边界与事件顺序。 */
function sse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
      c.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const frame = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const sentence = (no: number, text: string) => ({
  t: "sentence",
  no,
  text,
  dirs: [],
  at: "2026-01-01T00:00:00+00:00",
});

async function collect(signal?: AbortSignal): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of chat("hi", signal)) out.push(ev);
  return out;
}

async function drain(response: Response): Promise<ChatEvent[]> {
  vi.stubGlobal("fetch", vi.fn(async () => response));
  return collect();
}

/** 取迭代中抛出的错误（生成器不 reject，错误在迭代时抛出）。 */
async function failureOf(signal?: AbortSignal): Promise<unknown> {
  try {
    await collect(signal);
    return null;
  } catch (e) {
    return e;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("chat 的 SSE 消费", () => {
  it("连续多个 sentence 全部送达（不在第一个句子后结束）", async () => {
    const got = await drain(
      sse([
        frame(sentence(0, "第一句。")),
        frame(sentence(1, "第二句。")),
        frame(sentence(2, "第三句。")),
        frame({ t: "done" }),
      ]),
    );
    expect(got.map((e) => e.t)).toEqual([
      "sentence",
      "sentence",
      "sentence",
      "done",
    ]);
    expect(
      got.flatMap((e) => (e.t === "sentence" ? [e.text] : [])),
    ).toEqual(["第一句。", "第二句。", "第三句。"]);
  });

  it("事件被切在分片边界上也能完整解析", async () => {
    const whole =
      frame(sentence(0, "甲。")) + frame(sentence(1, "乙。")) + frame({ t: "done" });
    const got = await drain(sse([whole.slice(0, 7), whole.slice(7, 40), whole.slice(40)]));
    expect(got.map((e) => e.t)).toEqual(["sentence", "sentence", "done"]);
    // 跨分片时文本最容易粘连/截断，所以文本也要断言
    expect(got.flatMap((e) => (e.t === "sentence" ? [e.text] : []))).toEqual([
      "甲。",
      "乙。",
    ]);
  });

  it("未知事件类型跳过，不影响后续句子", async () => {
    const got = await drain(
      sse([
        frame(sentence(0, "第一句。")),
        frame({ t: "whatever" }),
        frame(sentence(1, "第二句。")),
        frame({ t: "done" }),
      ]),
    );
    // 未知类型插在两句之间：跳过它之后，后面的句子仍要送达
    expect(got.flatMap((e) => (e.t === "sentence" ? [e.text] : []))).toEqual([
      "第一句。",
      "第二句。",
    ]);
  });
});

describe("chat 的错误路径", () => {
  it("HTTP 非 2xx → ServiceError(llm, http, 状态码)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    const err = (await failureOf()) as ServiceError;
    expect(err).toBeInstanceOf(ServiceError);
    expect([err.service, err.failure, err.status]).toEqual(["llm", "http", 503]);
  });

  it("fetch 抛错 → ServiceError(llm, unreachable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    const err = (await failureOf()) as ServiceError;
    expect(err).toBeInstanceOf(ServiceError);
    expect([err.service, err.failure]).toEqual(["llm", "unreachable"]);
  });

  it("error 事件原样送达（由调用方映射成错误）", async () => {
    const got = await drain(
      sse([frame({ t: "error", message: "模型炸了" }), frame({ t: "done" })]),
    );
    expect(got[0]).toEqual({ t: "error", message: "模型炸了" });
  });

  it("中止（AbortError）→ 静默结束，不抛", async () => {
    const ac = new AbortController();
    ac.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }),
    );
    expect(await collect(ac.signal)).toEqual([]);
  });
});
