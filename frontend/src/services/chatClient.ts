// backend chat 客户端：POST /api/chat {text} → SSE（text/event-stream）。
// ReAct 循环、prompt 组装、记忆工具调用全部在 backend；
// 前端只消费最终回答的增量 token。
//
// SSE 协议（每行 `data: <json>`）：
//   {"t":"delta","text":"…"}            回答增量（<exp>/<motion> 指令内联在 text 里）
//   {"t":"done"}                       回合结束
//   {"t":"error","message":"…"}        回合失败（yield 给调用方映射成 Error）

import { ServiceError } from "../lib/errors";

/**
 * 打断回传：本回合用户输入 + 用户实际看到的 assistant 文本（可空）。
 * backend 据此修正 live 尾对（截断/补写），保证两侧落账一致。
 * 尽力发送、失败静默（打断本身已本地生效，backend 侧幂等调和）。
 */
export function interrupt(user: string, assistant: string): void {
  try {
    void fetch("/api/chat/interrupt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user, assistant }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // 同步异常（如已 unload）忽略
  }
}

type ChatEvent =
  | { t: "delta"; text: string }
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
    const j = JSON.parse(data) as { t?: unknown; text?: unknown; message?: unknown };
    if (j.t === "delta" && typeof j.text === "string") {
      return { t: "delta", text: j.text };
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
): AsyncGenerator<ChatEvent> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
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

  // 逐行解析：一行一个 data: 事件
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
        if (ev.t !== "delta") return;
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
