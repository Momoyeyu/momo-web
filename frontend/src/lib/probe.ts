// 端点连通性探测：设置页「测试连接」用。
// 语义：拿到任何 HTTP/WS 响应都算「可达」，detail 记状态码或延迟；
// 网络层失败/超时才算不可达。

import type { AsrConfig, LlmConfig, TtsConfig } from "./types";
import { asrUrl } from "../asr/client";
import { speechUrl } from "../tts/client";

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/** base-URL 语义：补 /v1；已含完整资源路径（最后一段非 vN）则原样返回 base。 */
function llmApiBase(cfg: LlmConfig): URL {
  const u = new URL(cfg.url);
  const p = u.pathname.replace(/\/+$/, "");
  if (p.endsWith("/chat/completions")) {
    u.pathname = p.slice(0, -"/chat/completions".length);
  } else if (!p.endsWith("/v1")) {
    u.pathname = `${p}/v1`;
  }
  return u;
}

/** 规范化 models url：GET {base}/models，健康探测用。 */
function modelsUrl(cfg: LlmConfig): string {
  const u = llmApiBase(cfg);
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/models`;
  return u.toString();
}

const TIMEOUT_MS = 5000;

/** 由端点 url 推导 healthz：剥掉已知的 API 路径段后在原 base 上拼 /healthz。 */
function healthzUrl(raw: string, apiSuffixes: string[]): string {
  const u = new URL(raw.replace(/^ws(s?):/, "http$1:"));
  let p = u.pathname.replace(/\/+$/, "");
  for (const s of apiSuffixes) {
    if (p.endsWith(s)) {
      p = p.slice(0, -s.length);
      break;
    }
  }
  u.pathname = `${p}/healthz`;
  u.search = "";
  return u.toString();
}

async function get(url: string, headers?: Record<string, string>): Promise<ProbeResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const started = performance.now();
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    const ms = Math.round(performance.now() - started);
    // 405 = 路由存在但方法不对——服务可达；其余状态码原样报告。
    if (res.ok || res.status === 405) return { ok: true, detail: `${ms}ms` };
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch {
    return { ok: false, detail: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeLlm(cfg: LlmConfig): Promise<ProbeResult> {
  if (!cfg.url) return { ok: false, detail: "unconfigured" };
  const headers: Record<string, string> = {};
  if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`;
  return get(modelsUrl(cfg), headers);
}

export async function probeTts(cfg: TtsConfig): Promise<ProbeResult> {
  if (!cfg.url) return { ok: false, detail: "unconfigured" };
  const first = await get(healthzUrl(cfg.url, ["/v1/audio/speech", "/v1"]));
  if (first.ok || first.detail !== "HTTP 404") return first;
  // 无 /healthz 的服务：GET speech 端点本身——405 也算可达。
  return get(speechUrl(cfg));
}

export function probeAsr(cfg: AsrConfig): Promise<ProbeResult> {
  if (!cfg.url) return Promise.resolve({ ok: false, detail: "unconfigured" });
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // 关闭失败忽略
      }
      resolve(r);
    };
    const started = performance.now();
    const timer = setTimeout(() => done({ ok: false, detail: "timeout" }), TIMEOUT_MS);
    let ws: WebSocket;
    try {
      ws = new WebSocket(asrUrl(cfg));
    } catch {
      clearTimeout(timer);
      resolve({ ok: false, detail: "bad url" });
      return;
    }
    ws.onopen = () => done({ ok: true, detail: `${Math.round(performance.now() - started)}ms` });
    ws.onerror = () => done({ ok: false, detail: "connect failed" });
    ws.onclose = (ev) => done({ ok: false, detail: `closed ${ev.code}` });
  });
}
