// LLM 客户端：OpenAI 兼容 POST {url}/chat/completions，SSE 流式增量。
// url 可以是 base（https://api.deepseek.com）或完整路径（…/v1/chat/completions）。

import type { LlmConfig } from "../lib/types";
import { ServiceError } from "../lib/errors";

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

/** base-URL 语义：补 /v1；已含完整资源路径（最后一段非 vN）则原样返回 base。 */
function apiBase(cfg: LlmConfig): URL {
  const u = new URL(cfg.url);
  const p = u.pathname.replace(/\/+$/, "");
  if (p.endsWith("/chat/completions")) {
    u.pathname = p.slice(0, -"/chat/completions".length);
  } else if (!p.endsWith("/v1")) {
    u.pathname = `${p}/v1`;
  }
  return u;
}

/** 规范化 chat completions url：path 为空/`/`/`/v1` 时补 /chat/completions。 */
export function chatCompletionsUrl(cfg: LlmConfig): string {
  const u = new URL(cfg.url);
  const p = u.pathname.replace(/\/+$/, "");
  if (p.endsWith("/chat/completions")) {
    u.pathname = p;
  } else {
    u.pathname = `${apiBase(cfg).pathname.replace(/\/+$/, "")}/chat/completions`;
  }
  return u.toString();
}

/** 规范化 models url：GET {base}/models，健康探测用。 */
export function modelsUrl(cfg: LlmConfig): string {
  const u = apiBase(cfg);
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/models`;
  return u.toString();
}

function isAbortError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { name?: unknown }).name === "AbortError"
  );
}

/**
 * 流式对话：POST chat/completions {model, messages, stream:true}
 * Authorization: Bearer <key>（key 非空才带）。
 * onDelta 收到每个 content 增量；返回完整文本。
 * HTTP/解析错误 → throw Error；signal abort → 返回已收到部分（不 throw）。
 */
export async function streamChat(
  cfg: LlmConfig,
  messages: ChatMsg[],
  opts: { signal?: AbortSignal; onDelta: (delta: string) => void },
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.key) headers["Authorization"] = `Bearer ${cfg.key}`;

  let res: Response;
  try {
    res = await fetch(chatCompletionsUrl(cfg), {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.model, messages, stream: true }),
      signal: opts.signal ?? null,
    });
  } catch (e) {
    if (isAbortError(e) || opts.signal?.aborted) return "";
    throw new ServiceError("llm", "unreachable");
  }

  if (!res.ok) {
    // OpenAI 信封：{error:{message}} 优先，兜底 HTTP 状态码
    let message = "";
    try {
      const body = (await res.json()) as { error?: { message?: unknown } };
      if (typeof body?.error?.message === "string" && body.error.message) {
        message = body.error.message;
      }
    } catch {
      // 错误体不是 JSON：用兜底文案
    }
    throw new ServiceError("llm", "http", res.status, message || undefined);
  }

  let acc = "";
  if (!res.body) return acc;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done = false;

  const handleLine = (line: string): void => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const data = t.slice(5).trim();
    if (data === "[DONE]") {
      done = true;
      return;
    }
    if (!data) return;
    try {
      const j = JSON.parse(data) as {
        choices?: { delta?: { content?: unknown } }[];
      };
      const c = j.choices?.[0]?.delta?.content;
      if (typeof c === "string" && c) {
        acc += c;
        opts.onDelta(c);
      }
    } catch {
      // 半截 JSON 行：忽略
    }
  };

  try {
    while (!done) {
      const r = await reader.read();
      if (r.done) break;
      buf += decoder.decode(r.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    }
  } catch (e) {
    if (isAbortError(e) || opts.signal?.aborted) return acc;
    throw e;
  }
  if (buf.trim()) handleLine(buf);
  return acc;
}
