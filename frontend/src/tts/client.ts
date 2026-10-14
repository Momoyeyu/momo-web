// TTS 客户端：OpenAI 对齐 POST /v1/audio/speech。
// response_format=pcm → chunked 流式 s16le 24kHz mono，逐块回调给播放器。
// AbortSignal 即取消（断连取消在途合成，无单独取消端点）。

import type { EmotionTag, TtsConfig } from "../lib/types";
import { ServiceError } from "../lib/errors";

export interface SpeakOptions {
  signal?: AbortSignal;
  /** 每个到达的 PCM 块。 */
  onChunk: (pcm: Uint8Array) => void;
}

/** 规范化 TTS url：按 base-URL 语义补 /v1/audio/speech。纯函数可测。 */
export function speechUrl(cfg: TtsConfig): string {
  const u = new URL(cfg.url);
  const p = u.pathname.replace(/\/+$/, "");
  if (p.endsWith("/v1/audio/speech")) {
    u.pathname = p;
  } else if (p.endsWith("/v1")) {
    u.pathname = `${p}/audio/speech`;
  } else {
    u.pathname = `${p}/v1/audio/speech`;
  }
  return u.toString();
}

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
 * 请求体：{input, voice?, lang, emotion?, response_format:"pcm"}，
 * voice 为空走服务端缺省；emotion 固定 8 tag。
 * HTTP 错误 → throw Error（带 status 与 OpenAI 信封 message）。
 * signal abort → 静默结束（不 throw）。
 */
export async function streamSpeech(
  cfg: TtsConfig,
  text: string,
  emotion: EmotionTag | undefined,
  opts: SpeakOptions,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`;

  let res: Response;
  try {
    res = await fetch(speechUrl(cfg), {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: text,
        response_format: "pcm",
        lang: cfg.lang,
        voice: cfg.voice || undefined,
        emotion: emotion || undefined,
        model: "momo-tts",
      }),
      signal: opts.signal ?? null,
    });
  } catch (err) {
    if (isAbort(err, opts.signal)) return;
    throw new ServiceError("tts", "unreachable");
  }

  if (!res.ok) {
    // OpenAI 错误信封 {error:{message}}；解析失败退回 statusText。
    let message = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } } | null;
      if (body?.error?.message) message = body.error.message;
    } catch {
      // 非 JSON 错误体：用 statusText
    }
    throw new ServiceError("tts", "http", res.status, message || res.statusText || undefined);
  }
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
