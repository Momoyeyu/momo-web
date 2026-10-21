// backend chat 客户端：POST /api/chat {text} → SSE（text/event-stream）。
// ReAct 循环、prompt 组装、切句、记忆工具调用全部在 backend；
// 前端只消费**句事件**（sentence）并逐句上屏/朗读。
//
// SSE 协议（每行 `data: <json>`）：
//   {"t":"sentence","no","text","cues","at"}  一句话已落账（正文已剥离指令，
//                                         cues 是该句要触发的表情/动作及句内偏移）
//   {"t":"done"}                       回合结束
//   {"t":"error","message":"…"}        回合失败（yield 给调用方映射成 Error）

import { ServiceError } from "../lib/errors";

/**
 * 打断回传：本回合用户输入 + 用户实际看到的 assistant 文本（可空）。
 * backend 据此修正 live 尾对（截断/补写），保证两侧落账一致。
 * 返回在回传完成（响应体收完）后兑现的 Promise——调用方可 await 它来
 * 给「打断 → 新回合」排序；失败静默（打断本身已本地生效，backend 幂等调和）。
 */
export function interrupt(user: string, assistant: string): Promise<void> {
  try {
    return fetch("/api/chat/interrupt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user, assistant }),
      keepalive: true,
    }).then(
      (r) => r.arrayBuffer().then(() => undefined),
      () => undefined,
    );
  } catch {
    // 同步异常（如已 unload）忽略
    return Promise.resolve();
  }
}

import type { PerformanceCue, PresentationSnapshot } from "../live2d/performanceTypes";

export type ChatEvent =
  | { t: "sentence"; no: number; text: string; cues: PerformanceCue[]; at: string }
  | { t: "done" }
  | { t: "error"; message: string };

function isAbortError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { name?: unknown }).name === "AbortError"
  );
}

/** 解析一行 SSE data 负载为 ChatEvent；不可识别返回 null。 */
function parseEvent(data: string): ChatEvent | null {
  try {
    const j = JSON.parse(data) as {
      t?: unknown;
      text?: unknown;
      message?: unknown;
      no?: unknown;
      cues?: unknown;
      at?: unknown;
    };
    if (j.t === "sentence" && typeof j.text === "string") {
      return {
        t: "sentence",
        no: typeof j.no === "number" ? j.no : 0,
        text: j.text,
        cues: Array.isArray(j.cues) ? (j.cues as PerformanceCue[]) : [],
        at: typeof j.at === "string" ? j.at : "",
      };
    }
    if (j.t === "done") return { t: "done" };
    if (j.t === "error") {
      return {
        t: "error",
        message: typeof j.message === "string" ? j.message : "backend error",
      };
    }
  } catch {
    // 半截/非 JSON 行：忽略
  }
  return null;
}

/**
 * 跑一个对话回合：逐条 yield SSE 事件，done/error 后结束。
 * fetch 失败/HTTP 非 2xx → throw ServiceError("llm", …)；
 * signal abort → 静默结束（不 throw）。
 */
export async function* chat(
  text: string,
  signal?: AbortSignal,
  presentation: PresentationSnapshot | null = null,
): AsyncGenerator<ChatEvent> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, presentation }),
      signal: signal ?? null,
    });
  } catch (e) {
    if (isAbortError(e) || signal?.aborted) return;
    throw new ServiceError("llm", "unreachable");
  }
  if (!res.ok) throw new ServiceError("llm", "http", res.status);
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const lines: string[] = [];
  const handleLine = (line: string): ChatEvent | null => {
    const t = line.trim();
    if (!t.startsWith("data:")) return null;
    return parseEvent(t.slice(5).trim());
  };

  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      buf += decoder.decode(r.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      while (lines.length) {
        const ev = handleLine(lines.shift()!);
        if (!ev) continue;
        yield ev;
      }
    }
  } catch (e) {
    if (isAbortError(e) || signal?.aborted) return;
    throw e;
  }
  // 流尾残余半行补一刀
  if (buf.trim()) {
    const ev = handleLine(buf);
    if (ev) yield ev;
  }
}
