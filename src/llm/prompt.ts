// system prompt 组装：persona card + 情绪标记指令 + [长期记忆] 段 + 对话历史。
// 纯函数可测。

import type { ChatMessage, PersonaCard } from "../lib/types";
import type { ChatMsg } from "./client";

function listBlock(label: string, items: string[]): string {
  return `${label}：\n${items.map((s) => `- ${s}`).join("\n")}`;
}

/**
 * 人设 → system prompt。包含：
 * - 身份/性格/语气/禁忌/例子（persona card 各节，空节跳过）
 * - 情绪标记指令：回复中可用 [neutral|happy|sad|angry|surprised|thinking|shy|sleepy]
 *   内联标记当前情绪（句首/句中均可），标记本身不会被读出
 * - memoryBlock 非空时追加 "[长期记忆]" 段
 */
export function buildSystemPrompt(
  persona: PersonaCard,
  memoryBlock: string,
): string {
  const sections: string[] = [];

  const card: string[] = [];
  if (persona.name.trim()) card.push(`名称：${persona.name.trim()}`);
  if (persona.oneLiner.trim()) card.push(`一句话：${persona.oneLiner.trim()}`);
  if (persona.identity.trim()) card.push(`身份：${persona.identity.trim()}`);
  if (persona.likes.length) card.push(listBlock("喜欢", persona.likes));
  if (persona.dislikes.length) card.push(listBlock("讨厌", persona.dislikes));
  if (persona.traits.length) card.push(listBlock("性格", persona.traits));
  if (persona.tone.trim()) card.push(`语气：${persona.tone.trim()}`);
  if (persona.taboos.length) card.push(listBlock("禁忌", persona.taboos));
  if (persona.examples.length) {
    const name = persona.name.trim() || "momo";
    const ex = persona.examples
      .map((e) => `用户：${e.user}\n${name}：${e.assistant}`)
      .join("\n\n");
    card.push(`对话例子：\n${ex}`);
  }
  if (card.length) sections.push(`[人设]\n${card.join("\n")}`);

  sections.push(
    "[情绪与动作指令]\n" +
      "情绪变化时，在对应句子之前插入独立的指令 `#tag`，" +
      "tag 取值：neutral happy sad angry surprised thinking shy sleepy。" +
      "例如「#happy 今天好开森！」「#thinking 让我想想……」。" +
      "指令不会被展示，也不会被朗读，只用于切换表情与动作。" +
      "正文里不要出现任何 # 或方括号标记。",
  );

  if (memoryBlock.trim()) {
    sections.push(`[长期记忆]\n${memoryBlock}`);
  }

  return sections.join("\n\n");
}

/** 历史消息 → ChatMsg[]（system 由调用方前置）。 */
export function buildMessages(
  history: ChatMessage[],
  userText: string,
): ChatMsg[] {
  const msgs: ChatMsg[] = history.map((m) => ({
    role: m.role,
    content: m.text,
  }));
  msgs.push({ role: "user", content: userText });
  return msgs;
}
