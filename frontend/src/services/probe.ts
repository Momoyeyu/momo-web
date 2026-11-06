// 端点连通性探测：设置页「测试连接」用。
// 语义：拿到任何 HTTP/WS 响应都算「可达」，detail 记状态码或延迟；
// 网络层失败/超时才算不可达。

import type {
  LlmConfig,
  TtsConfig,
} from "../lib/types";
import { apiJson } from "./http";

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/** base-URL 语义：补 /v1；已含完整资源路径（最后一段非 vN）则原样返回 base。 */
function llmApiBase(cfg: { url: string }): URL {
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
function modelsUrl(cfg: { url: string }): string {
  const u = llmApiBase(cfg);
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/models`;
  return u.toString();
}

const TIMEOUT_MS = 5000;

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
  try {
    const s = await apiJson<{
      configured: boolean;
      reachable: boolean;
      detail: string;
    }>("/api/tts/status");
    if (s.configured && s.reachable) return { ok: true, detail: "gpt-sovits" };
    return { ok: false, detail: s.detail || "未就绪" };
  } catch {
    return { ok: false, detail: "backend unreachable" };
  }
}
