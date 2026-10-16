// 出厂配置的回归保护：新用户从 GitHub clone 下来、首次启动时，
// 项目里不该带任何「开发者的环境信息」或示例数据 —— 全部由用户自己填。
//
// 历史教训：这里曾经预填过 LLM 地址（api.deepseek.com）、本机 asr/tts 端口、
// 一台内网 embedding 服务器地址（10.106.130.222）以及示例偏好/记忆。
// 那些是开发者的环境，随仓库发给每个 clone 的人既误导也不安全。
import { describe, expect, it } from "vitest";

import { DEFAULT_PERSONA, getSettings } from "./store";

describe("出厂配置不含任何预填信息", () => {
  it("服务地址与模型一律为空（输入框的灰色提示负责引导）", () => {
    const s = getSettings();
    expect(s.llm.url).toBe("");
    expect(s.llm.key).toBe("");
    expect(s.llm.model).toBe("");
    expect(s.asr.url).toBe("");
    expect(s.asr.key).toBe("");
    expect(s.tts.url).toBe("");
    expect(s.tts.key).toBe("");
    expect(s.tts.voice).toBe("");
    expect(s.embedding.url).toBe("");
    expect(s.embedding.key).toBe("");
    expect(s.embedding.model).toBe("");
    expect(s.extensions).toEqual([]);
  });

  it("偏好为空：不种任何示例偏好", () => {
    expect(DEFAULT_PERSONA.preferences).toEqual([]);
  });
});
