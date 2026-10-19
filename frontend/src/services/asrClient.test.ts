// ASR 客户端纯函数单测：内置事件解析 / 转写 URL 归一 / 能量 VAD / WAV 封装。
// WS 与 HTTP 的真实行为由 e2e 覆盖（需要真 backend）。
import { describe, expect, it } from "vitest";

import {
  EnergyVad,
  parseBuiltinEvent,
  pcm16ToWav,
  transcriptionUrl,
} from "./asrClient";

describe("parseBuiltinEvent", () => {
  it("解析 transcript / speech_started / error", () => {
    expect(parseBuiltinEvent('{"type":"transcript","text":"你好"}')).toEqual({
      type: "transcript",
      text: "你好",
      message: undefined,
    });
    expect(parseBuiltinEvent('{"type":"speech_started"}')?.type).toBe(
      "speech_started",
    );
    expect(
      parseBuiltinEvent('{"type":"error","message":"模型缺失"}')?.message,
    ).toBe("模型缺失");
  });

  it("非法 JSON / 缺 type 一律 null（协议演进时静默忽略）", () => {
    expect(parseBuiltinEvent("not json")).toBeNull();
    expect(parseBuiltinEvent("[]")).toBeNull();
    expect(parseBuiltinEvent('{"text":"x"}')).toBeNull();
  });
});

describe("transcriptionUrl", () => {
  it("base 是 /v1 → 补 /audio/transcriptions", () => {
    expect(transcriptionUrl("http://localhost:8080/v1")).toBe(
      "http://localhost:8080/v1/audio/transcriptions",
    );
  });

  it("裸 host → 补 /v1/audio/transcriptions", () => {
    expect(transcriptionUrl("http://localhost:8080")).toBe(
      "http://localhost:8080/v1/audio/transcriptions",
    );
  });

  it("已经是完整端点 → 原样", () => {
    expect(
      transcriptionUrl("https://api.openai.com/v1/audio/transcriptions"),
    ).toBe("https://api.openai.com/v1/audio/transcriptions");
  });
});

describe("EnergyVad", () => {
  const loud = (): Int16Array => {
    const f = new Int16Array(320);
    for (let i = 0; i < f.length; i++) f[i] = Math.round(8000 * Math.sin(i / 4));
    return f;
  };
  const quiet = (): Int16Array => new Int16Array(320);

  it("静音不触发", () => {
    const vad = new EnergyVad();
    for (let i = 0; i < 50; i++) expect(vad.push(quiet())).toBeNull();
  });

  it("连续两帧过阈值 → 报开始说话", () => {
    const vad = new EnergyVad();
    expect(vad.push(loud())).toBeNull();
    expect(vad.push(loud())).toEqual({ start: true });
  });

  it("说完 600ms 静音 → 吐出整段（含预录，尾部静音被裁掉）", () => {
    const vad = new EnergyVad();
    vad.push(loud());
    vad.push(loud()); // start
    for (let i = 0; i < 20; i++) vad.push(loud()); // 说话 400ms
    let out: Int16Array | null = null;
    for (let i = 0; i < 30; i++) {
      const r = vad.push(quiet());
      if (r?.utterance) out = r.utterance;
    }
    expect(out).not.toBeNull();
    // 20ms 帧：起音 2 帧 + 说话 20 帧（±1 帧取决于阈值判定时序）；
    // 尾部 600ms 静音必须被裁掉，所以上限锁定在 24 帧
    expect(out!.length).toBeGreaterThanOrEqual(320 * 21);
    expect(out!.length).toBeLessThanOrEqual(320 * 24);
  });

  it("flush 把没说完的一段吐出来", () => {
    const vad = new EnergyVad();
    vad.push(loud());
    vad.push(loud());
    for (let i = 0; i < 5; i++) vad.push(loud());
    expect(vad.flush()!.length).toBeGreaterThan(0);
    expect(vad.flush()).toBeNull();
  });
});

describe("pcm16ToWav", () => {
  it("写出合法的 RIFF/WAVE 头（44 字节 + 数据）", async () => {
    const pcm = new Int16Array(16000);
    const blob = pcm16ToWav(pcm);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes.length).toBe(44 + 32000);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint16(22, true)).toBe(1); // mono
  });
});
