// turn 后异步记忆抽取：LLM 输出 JSON ops → 应用到 store。
// 契约：[{op:"add"|"invalidate", kind?, content?, reason?, target_id?}]
// 解析容错：截取首个 "[" 到末个 "]"；坏项跳过。
// 参考 momo feat/memory memory.md §写路径，简化为单次非流式调用。

import type { LlmConfig, MemoryKind } from "../lib/types";
import { MEMORY_KINDS } from "../lib/types";
import { getMemories } from "../lib/store";
import { streamChat } from "../llm/client";
import { addMemory, invalidateMemory } from "./store";

export interface TranscriptPiece {
  user: string;
  assistant: string;
}

/** 给 LLM 参考的现有记忆条数上限（供 invalidate 引用 id）。 */
const EXISTING_LIMIT = 30;

function toKind(k: unknown): MemoryKind {
  return typeof k === "string" &&
    (MEMORY_KINDS as readonly string[]).includes(k)
    ? (k as MemoryKind)
    : "semantic";
}

/**
 * 抽取并应用；返回应用成功的 op 数。
 * fire-and-forget 调用方 catch 掉错误即可（抽取失败不影响回合）。
 */
export async function extractAndApply(
  cfg: LlmConfig,
  turn: TranscriptPiece,
): Promise<number> {
  const existing = getMemories()
    .filter((m) => m.valid)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, EXISTING_LIMIT)
    .map((m) => `- ${m.id} [${m.kind}] ${m.content}`)
    .join("\n");

  const system = [
    "你负责在一段对话结束后抽取长期记忆。只输出一个 JSON 数组，不要输出任何其它文字。",
    '格式：[{"op":"add","kind":"semantic|episodic|procedural","content":"要记住的内容"},' +
      ' {"op":"invalidate","target_id":"mem_旧条目id","content":"可选的新内容"}]',
    "kind 含义：semantic=用户的事实与偏好；episodic=发生过的具体事件/对话片段；procedural=约定、习惯与相处指令。",
    "只记录与用户有关的事实、偏好、习惯与约定；寒暄、客套、一次性的闲聊不要记。没有值得记的就输出 []。",
    "已有记忆若被新信息取代或更正，用 invalidate 指向它的 id；同时给 content 表示新增一条取代它。",
    existing ? `现有记忆：\n${existing}` : "现有记忆：（空）",
  ].join("\n");

  const user = `用户说：${turn.user}\nmomo 说：${turn.assistant}`;

  let raw = "";
  const ret = await streamChat(
    cfg,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { onDelta: (d) => void (raw += d) },
  );
  // onDelta 累积与返回值等价（完整文本）；任一渠道拿到都算数
  if (!raw && ret) raw = ret;

  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return 0;
  let ops: unknown;
  try {
    ops = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return 0;
  }
  if (!Array.isArray(ops)) return 0;

  let applied = 0;
  for (const item of ops) {
    if (!item || typeof item !== "object") continue;
    const op = item as {
      op?: unknown;
      kind?: unknown;
      content?: unknown;
      target_id?: unknown;
    };
    if (op.op === "add") {
      const content = typeof op.content === "string" ? op.content : "";
      if (addMemory(toKind(op.kind), content, "extract")) applied++;
    } else if (op.op === "invalidate") {
      const tid = typeof op.target_id === "string" ? op.target_id : "";
      if (!tid || !getMemories().some((m) => m.id === tid)) continue;
      const content = typeof op.content === "string" ? op.content : "";
      if (content.trim()) {
        // 先 add 新条，再把 target_id superseded_by 指向新 id
        const created = addMemory(toKind(op.kind), content, "extract");
        invalidateMemory(tid, created ? created.id : "void:invalidate");
      } else {
        invalidateMemory(tid, "void:invalidate");
      }
      applied++;
    }
  }
  return applied;
}
