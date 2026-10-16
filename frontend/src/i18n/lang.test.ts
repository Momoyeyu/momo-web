// 对话语言解析：prompt 文案、对话语言、TTS 合成语言共用这一个入口，
// 语义必须与后端 prompt._lang_of 保持一致。

import { describe, expect, it } from "vitest";
import { resolveChatLang } from "./index";
import type { GeneralConfig } from "../lib/types";

/**
 * 构造用例输入。类型上 GeneralConfig.chatLang 是 Lang | "auto"，但运行时
 * 必须兼容脏值（空串、区域码、未知语言码）——这些正是本测试要覆盖的，
 * 所以这里刻意绕过字面量类型。
 */
const g = (partial: Record<string, unknown>): GeneralConfig =>
  ({ lang: "zh", chatLang: "auto", ...partial }) as unknown as GeneralConfig;

describe("resolveChatLang", () => {
  it("显式对话语言优先于界面语言", () => {
    expect(resolveChatLang(g({ lang: "zh", chatLang: "ja" }))).toBe("ja");
    expect(resolveChatLang(g({ lang: "ja", chatLang: "en" }))).toBe("en");
  });

  it("auto / 空 → 回落界面语言", () => {
    expect(resolveChatLang(g({ lang: "ja", chatLang: "auto" }))).toBe("ja");
    expect(resolveChatLang(g({ lang: "en", chatLang: "" }))).toBe("en");
  });

  it("未知或缺失 → zh", () => {
    expect(resolveChatLang(g({ lang: "zh", chatLang: "fr" }))).toBe("zh");
    expect(resolveChatLang(g({ lang: "kl", chatLang: "auto" }))).toBe("zh");
    expect(resolveChatLang({} as GeneralConfig)).toBe("zh");
  });

  it("区域码按前缀归一（zh-CN / ja-JP）", () => {
    expect(resolveChatLang(g({ chatLang: "zh-CN" }))).toBe("zh");
    expect(resolveChatLang(g({ chatLang: "JA-jp" }))).toBe("ja");
  });
});
