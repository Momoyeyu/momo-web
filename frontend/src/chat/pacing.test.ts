import { describe, expect, it } from "vitest";
import { charsPerSec, dwellMs, sentencePauseMs } from "./pacing";

describe("pacing", () => {
  it("文字速度：0%≈15字/秒，100%=不限速，单调递增", () => {
    expect(charsPerSec(0)).toBeCloseTo(15);
    expect(charsPerSec(100)).toBe(Infinity);
    expect(charsPerSec(50)).toBeGreaterThan(charsPerSec(0));
    expect(charsPerSec(50)).toBeCloseTo(15 * Math.pow(8, 0.5), 1); // ≈42.4
    expect(charsPerSec(150)).toBe(Infinity); // 越界钳制
  });

  it("切句速度：0%≈2s，100%≈0.1s，线性", () => {
    expect(sentencePauseMs(0)).toBe(2000);
    expect(sentencePauseMs(100)).toBe(100);
    expect(sentencePauseMs(50)).toBeCloseTo(1050, -2);
    expect(sentencePauseMs(-50)).toBe(2000); // 越界钳制：低于 0% 仍按 0% 算
  });

  it("无 TTS 驻留 = 停顿基准 × (1 + 句长折算)", () => {
    expect(dwellMs(0, 0)).toBe(2000);
    expect(dwellMs(0, 10)).toBe(4000);
    expect(dwellMs(100, 30)).toBe(400); // 100ms × (1+3)
  });
});
