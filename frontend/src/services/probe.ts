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

export async function probeLlm(cfg: LlmConfig, signal?: AbortSignal): Promise<ProbeResult> {
  if (!cfg.url) return {ok: false, detail: "unconfigured"};
  try { return await apiJson<ProbeResult>("/api/probe/llm", {
    method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(cfg), signal,
  }); } catch { return {ok: false, detail: "backend unreachable"}; }
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
