// 视觉小说节奏换算：两个 0–100 旋钮 → 具体时长/速率。
// 文字速度：句内逐字上屏的速率上限（实际受 LLM 产出速度封顶）。
// 切句速度：句间停顿与无 TTS 驻留的统一缩放。

/** 文字速度 → 每秒最多上屏字符数。0% ≈ 15 字/秒，指数曲线；100% = 不限速（贴着生成走）。 */
export function charsPerSec(pct: number): number {
  const p = Math.max(0, Math.min(100, pct));
  if (p >= 100) return Infinity;
  return 15 * Math.pow(8, p / 100); // 0→15, 50→~42, ~99→~118
}

/** 切句速度 → 句间停顿毫秒数。0% ≈ 2s，100% ≈ 0.1s，线性。 */
export function sentencePauseMs(pct: number): number {
  const p = Math.max(0, Math.min(100, pct));
  return Math.round(2000 - 1900 * (p / 100));
}

/** 无 TTS 时当前句的驻留时长：停顿基准 ×（1 + 句长折算），随切句速度统一缩放。 */
export function dwellMs(pct: number, sentenceLen: number): number {
  return Math.round(sentencePauseMs(pct) * (1 + sentenceLen / 10));
}
