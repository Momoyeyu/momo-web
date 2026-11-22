// TTS readiness: endpoint plus uploaded reference audio. ASR is always built in.
import type { TtsConfig } from "./types";

export function ttsEndpoint(cfg: TtsConfig): {url: string; key: string} {
  return cfg.engine === "index-tts"
    ? {url: cfg.indexUrl ?? "", key: cfg.indexKey ?? ""}
    : {url: cfg.url, key: cfg.key};
}

/**
 * TTS 是否可用：服务地址 + **已上传参考音频**。
 * 只看 url 会漏掉"地址填了但没传音色"的情况——那时 backend 会直接 503，
 * 开关却看起来是好的（用户踩过）。
 */
export function ttsConfigured(cfg: TtsConfig): boolean {
  return ttsEndpoint(cfg).url.trim() !== "" && cfg.voice.trim() !== "";
}
