import { describe, expect, it } from "vitest";
import {
  ASR_SAMPLE_RATE,
  Resampler,
  S16leFramer,
  floatToS16le,
  s16leToFloat32,
} from "./pcm";

describe("floatToS16le / s16leToFloat32", () => {
  it("roundtrips within quantization error", () => {
    const input = new Float32Array([0, 0.5, -0.5, 0.25, -0.25, 0.001]);
    const back = s16leToFloat32(floatToS16le(input));
    expect(back.length).toBe(input.length);
    for (let i = 0; i < input.length; i++) {
      expect(back[i]).toBeCloseTo(input[i], 4);
    }
  });

  it("clips out-of-range samples to s16 bounds", () => {
    const pcm = floatToS16le(new Float32Array([2, -2]));
    const view = new DataView(pcm.buffer);
    expect(view.getInt16(0, true)).toBe(0x7fff);
    expect(view.getInt16(2, true)).toBe(-0x8000);
  });

  it("writes little-endian bytes", () => {
    const pcm = floatToS16le(new Float32Array([1]));
    expect(pcm[0]).toBe(0xff);
    expect(pcm[1]).toBe(0x7f);
  });

  it("s16leToFloat32 drops a dangling odd byte", () => {
    expect(s16leToFloat32(new Uint8Array([1, 0, 2])).length).toBe(1);
  });
});

describe("Resampler", () => {
  it("decimates 3x (48k→16k) to roughly a third of the input", () => {
    const r = new Resampler(48000, ASR_SAMPLE_RATE);
    const out = r.push(new Float32Array(4800)); // 100ms @48k
    expect(Math.abs(out.length - 1600)).toBeLessThanOrEqual(2);
  });

  it("decimates 2x (32k→16k) to roughly half the input", () => {
    const r = new Resampler(32000, 16000);
    const out = r.push(new Float32Array(2000));
    expect(Math.abs(out.length - 1000)).toBeLessThanOrEqual(2);
  });

  it("produces the same total length whether fed whole or split", () => {
    const input = new Float32Array(4800);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(i / 10);
    const whole = new Resampler(48000, 16000).push(input).length;

    const split = new Resampler(48000, 16000);
    let n = 0;
    for (let off = 0; off < input.length; off += 777) {
      n += split.push(input.subarray(off, off + 777)).length;
    }
    expect(Math.abs(n - whole)).toBeLessThanOrEqual(1);
  });

  it("interpolates linearly between samples", () => {
    // 2k→1k（step 2）：斜坡 0,1,2,3,4 → 输出取 0,2 位置的值。
    const r = new Resampler(2000, 1000);
    const out = r.push(new Float32Array([0, 1, 2, 3, 4]));
    expect(out.length).toBe(2);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(2);
  });
});

describe("S16leFramer", () => {
  it("emits fixed-length s16le frames and flushes the remainder", () => {
    // 16k→16k，50ms/帧 = 800 samples = 1600B。
    const f = new S16leFramer(16000, 16000, 50);
    const frames = f.push(new Float32Array(2000));
    // 恒等重采样产出 1999 samples（末点留作跨界锚点）→ 2 完整帧 + 399 残余。
    expect(frames.length).toBe(2);
    for (const frame of frames) expect(frame.byteLength).toBe(1600);

    const tail = f.flush();
    expect(tail).not.toBeNull();
    expect(tail!.byteLength % 2).toBe(0);
    expect(tail!.byteLength).toBeLessThan(1600);
    expect(tail!.byteLength).toBeGreaterThan(0);
    expect(f.flush()).toBeNull();
  });

  it("resamples then frames: 48k input → 16k 50ms frames", () => {
    const f = new S16leFramer(48000); // 默认 16k / 50ms
    const frames = f.push(new Float32Array(4800)); // 100ms @48k → 1600 @16k
    expect(frames.length).toBe(2);
    for (const frame of frames) expect(frame.byteLength).toBe(1600);
    expect(f.flush()).toBeNull();
  });

  it("carries partial frames across pushes", () => {
    const f = new S16leFramer(16000, 16000, 10); // 160 samples/帧 = 320B
    expect(f.push(new Float32Array(100)).length).toBe(0);
    const frames = f.push(new Float32Array(200));
    // 累计 99 + 200 = 299 samples → 1 帧 + 139 残余。
    expect(frames.length).toBe(1);
    expect(frames[0].byteLength).toBe(320);
    const tail = f.flush();
    expect(tail!.byteLength).toBe(139 * 2);
  });
});
