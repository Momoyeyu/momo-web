import { runtimeFetch } from "./runtime";
// TTS 客户端：统一走后端代理 `POST /api/tts/speech`（OpenAI 形状），
// 后端再翻译成 GPT-SoVITS api_v2。这样前端不关心引擎差异，也不会有 CORS /
// 混合内容问题；将来换引擎只改后端。
//
// 响应是裸 PCM（s16le mono），采样率放在 `X-Sample-Rate` 头里——
// GPT-SoVITS 的采样率随模型版本变化（32k/48k），前端据此配置 AudioContext，
// 写死 24k 会变调。
import { ServiceError } from "../lib/errors";

interface SpeakOptions {
  /** 合成语言 = 对话语言（调用方用 resolveChatLang(cfg.general) 解析）。 */
  lang: string;
  signal?: AbortSignal;
  /** 收到采样率（每个响应一次，早于任何 onChunk）。 */
  onSampleRate?: (sampleRate: number) => void;
  /** 每个到达的 PCM 块。 */
  onChunk: (pcm: Uint8Array) => void;
}

const SPEECH_PATH = "/api/tts/speech";

/** 缺省采样率：后端没给头时兜底（老版本后端 / 直连 OpenAI 兼容端点）。 */
const DEFAULT_SR = 24000;

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "AbortError"
  );
}

/**
 * 合成一段文本并把流式 PCM 块回调出去。
 * 请求体：{input, lang}（OpenAI /v1/audio/speech 形状的子集；参考音频由后端管理）。
 * HTTP 错误 → throw ServiceError（带 status 与 detail）。
 * signal abort → 静默结束（不 throw）。
 */
export async function streamSpeech(
  text: string,
  opts: SpeakOptions,
): Promise<void> {
  let res: Response;
  try {
    res = await runtimeFetch(SPEECH_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: text,
        lang: opts.lang,
      }),
      signal: opts.signal ?? null,
    });
  } catch (err) {
    if (isAbort(err, opts.signal)) return;
    throw new ServiceError("tts", "unreachable");
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: string } | null;
      if (body?.detail) detail = body.detail;
    } catch {
      // 非 JSON 错误体：用 statusText
    }
    throw new ServiceError("tts", "http", res.status, detail || res.statusText || undefined);
  }

  const sr = Number(res.headers.get("x-sample-rate"));
  opts.onSampleRate?.(Number.isFinite(sr) && sr > 0 ? sr : DEFAULT_SR);
  if (!res.body) return;

  const reader = res.body.getReader();
  // chunk 边界任意：s16le 需偶数字节对齐，留 1 字节残余与下一块拼接。
  let leftover: Uint8Array | null = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      let buf = value;
      if (leftover) {
        const merged = new Uint8Array(leftover.length + buf.length);
        merged.set(leftover);
        merged.set(buf, leftover.length);
        buf = merged;
        leftover = null;
      }
      const even = buf.byteLength - (buf.byteLength % 2);
      if (even < buf.byteLength) leftover = buf.subarray(even);
      if (even > 0) opts.onChunk(buf.subarray(0, even));
    }
  } catch (err) {
    if (isAbort(err, opts.signal)) return;
    throw err;
  }
  // 流尾单字节残余按协议丢弃。
}

/** 上传参考音频（重复上传覆盖旧文件）。返回落盘后的文件名与大小。 */
export async function uploadRefAudio(
  file: File,
): Promise<{ name: string; size: number }> {
  const form = new FormData();
  form.append("file", file, file.name);
  let res: Response;
  try {
    res = await runtimeFetch("/api/tts/ref", { method: "POST", body: form });
  } catch {
    throw new ServiceError("tts", "unreachable");
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: string } | null;
      if (body?.detail) detail = body.detail;
    } catch {
      // 非 JSON 错误体
    }
    throw new ServiceError("tts", "http", res.status, detail || undefined);
  }
  return (await res.json()) as { name: string; size: number };
}
