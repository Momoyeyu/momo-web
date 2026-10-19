// ASR 配置判定：内置引擎永远"已配置"（模型缺失由 backend 状态兜底），
// 自定义引擎要求填了 url。设置页的开关门控与对话页的麦克风门控共用这里。
import type { AsrConfig, TtsConfig } from "./types";

export function asrConfigured(cfg: AsrConfig): boolean {
  return cfg.mode === "builtin" ? true : cfg.url.trim() !== "";
}

/**
 * TTS 是否可用：服务地址 + **已上传参考音频**。
 * 只看 url 会漏掉"地址填了但没传音色"的情况——那时 backend 会直接 503，
 * 开关却看起来是好的（用户踩过）。
 */
export function ttsConfigured(cfg: TtsConfig): boolean {
  return cfg.url.trim() !== "" && cfg.voice.trim() !== "";
}
