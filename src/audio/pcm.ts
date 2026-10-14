// PCM 整形纯函数：Float32 ↔ s16le、重采样、定长切帧。vitest 直接对拍。
// 可参考 momo/app/web/src/audio/pcm.ts 的 Resampler/UplinkFramer 设计。

/** ASR 上行采样率（protocol：16kHz mono）。 */
export const ASR_SAMPLE_RATE = 16000;

/** Float32(-1..1) → PCM s16le 字节；超界 clip。 */
export function floatToS16le(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/**
 * 流式线性插值重采样器：分块喂入原生采样率，产出目标采样率 Float32。
 * 跨块边界的插值用上一块末尾 sample 衔接，输出与一次性整段重采样一致。
 */
export class Resampler {
  /** 源流中的下一读取位置（相对下一块输入起点；负值表示与 tail 跨界插值）。 */
  private pos = 0;
  /** 上一块输入的最后一个 sample（跨界插值锚点）。 */
  private tail = 0;
  private readonly step: number;

  constructor(srcRate: number, dstRate: number = ASR_SAMPLE_RATE) {
    if (srcRate <= 0 || dstRate <= 0) throw new Error("sample rates must be positive");
    this.step = srcRate / dstRate;
  }

  push(input: Float32Array): Float32Array {
    const out: number[] = [];
    let pos = this.pos;
    // 源位置 t 读取 input[floor(t)] 与 input[floor(t)+1]；
    // 只有 floor(t)+1 落在本块内才能产出（否则留给下一块）。
    while (pos < input.length - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i < 0 ? this.tail : input[i];
      const b = input[i + 1];
      out.push(a + (b - a) * frac);
      pos += this.step;
    }
    this.pos = pos - input.length;
    if (input.length > 0) this.tail = input[input.length - 1];
    return new Float32Array(out);
  }
}

/** 重采样 + 定长切帧：push 原生 Float32，吐出 frameMs 毫秒的 s16le 完整帧。 */
export class S16leFramer {
  private readonly resampler: Resampler;
  private readonly frameSamples: number;
  private buf: Float32Array = new Float32Array(0);

  constructor(srcRate: number, dstRate: number = ASR_SAMPLE_RATE, frameMs: number = 50) {
    this.resampler = new Resampler(srcRate, dstRate);
    this.frameSamples = Math.max(1, Math.round((dstRate * frameMs) / 1000));
  }

  /** 喂入一段原生采样率 Float32，返回 0..n 个完整帧（s16le，2×frameSamples 字节/帧）。 */
  push(input: Float32Array): Uint8Array[] {
    const resampled = this.resampler.push(input);
    if (resampled.length === 0) return [];
    const merged = new Float32Array(this.buf.length + resampled.length);
    merged.set(this.buf);
    merged.set(resampled, this.buf.length);
    const frames: Uint8Array[] = [];
    const whole = Math.floor(merged.length / this.frameSamples) * this.frameSamples;
    for (let off = 0; off < whole; off += this.frameSamples) {
      frames.push(floatToS16le(merged.subarray(off, off + this.frameSamples)));
    }
    this.buf = merged.subarray(whole);
    return frames;
  }

  /** 收尾残余（不足一帧也返回）；无残余返回 null。 */
  flush(): Uint8Array | null {
    if (this.buf.length === 0) return null;
    const out = floatToS16le(this.buf);
    this.buf = new Float32Array(0);
    return out;
  }
}

/** s16le 字节流 → Float32(-1..1)；奇数尾字节丢弃。 */
export function s16leToFloat32(pcm: Uint8Array): Float32Array {
  const n = Math.floor(pcm.byteLength / 2);
  const out = new Float32Array(n);
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  for (let i = 0; i < n; i++) {
    out[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return out;
}
