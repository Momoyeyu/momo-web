import { describe, expect, it } from "vitest";
import type { ChatMessage, PersonaCard } from "../lib/types";
import { DEFAULT_PERSONA } from "../lib/store";
import { buildMessages, buildSystemPrompt } from "./prompt";

const emptyPersona = (over: Partial<PersonaCard> = {}): PersonaCard => ({
  name: "",
  oneLiner: "",
  identity: "",
  likes: [],
  dislikes: [],
  traits: [],
  tone: "",
  taboos: [],
  examples: [],
  ...over,
});

const msg = (role: "user" | "assistant", text: string): ChatMessage => ({
  id: `m_${text}`,
  role,
  text,
  at: new Date().toISOString(),
});

describe("buildSystemPrompt", () => {
  it("渲染非空节、空节跳过", () => {
    const p = emptyPersona({ name: "momo", likes: ["甜食", "下雨天"] });
    const s = buildSystemPrompt(p, "");
    expect(s).toContain("名称：momo");
    expect(s).toContain("喜欢：\n- 甜食\n- 下雨天");
    expect(s).not.toContain("讨厌：");
    expect(s).not.toContain("身份：");
    expect(s).not.toContain("对话例子");
  });

  it("包含情绪指令说明", () => {
    const s = buildSystemPrompt(emptyPersona(), "");
    expect(s).toContain("[情绪与动作指令]");
    expect(s).toContain(
      "neutral happy sad angry surprised thinking shy sleepy",
    );
    expect(s).toContain("不会被展示");
  });

  it("memoryBlock 非空追加 [长期记忆] 段", () => {
    const s = buildSystemPrompt(emptyPersona(), "- 用户画像：阿明\n- 喜欢猫");
    expect(s.endsWith("[长期记忆]\n- 用户画像：阿明\n- 喜欢猫")).toBe(true);
    const empty = buildSystemPrompt(emptyPersona(), "");
    expect(empty).not.toContain("[长期记忆]");
  });

  it("DEFAULT_PERSONA 全量渲染", () => {
    const s = buildSystemPrompt(DEFAULT_PERSONA, "");
    expect(s).toContain("[人设]");
    expect(s).toContain("名称：momo");
    expect(s).toContain("一句话：一个有点宅");
    expect(s).toContain("身份：");
    expect(s).toContain("语气：像认识很久的朋友");
    expect(s).toContain("禁忌：");
    expect(s).toContain("对话例子：");
    expect(s).toContain("用户：你是谁？");
    expect(s).toContain("momo：#surprised 啊？");
  });
});

describe("buildMessages", () => {
  it("历史按序映射 + 末尾新 user", () => {
    const msgs = buildMessages(
      [msg("user", "你好"), msg("assistant", "嗯你好呀"), msg("user", "在吗")],
      "新一句",
    );
    expect(msgs).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "嗯你好呀" },
      { role: "user", content: "在吗" },
      { role: "user", content: "新一句" },
    ]);
  });

  it("空历史只有新消息", () => {
    expect(buildMessages([], "hi")).toEqual([
      { role: "user", content: "hi" },
    ]);
  });
});
