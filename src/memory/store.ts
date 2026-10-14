// 记忆语义操作层（持久化走 lib/store）：
// add 去重（归一化全等 + bigram Jaccard>0.85）、invalidate/supersede、
// 软删、关键词召回注入段。参考 momo feat/memory 的语义，简化实现。

import { getMemories, newId, update } from "../lib/store";
import type { Memory, MemoryKind } from "../lib/types";

/** 召回注入段总长上限。 */
const MAX_BLOCK_LEN = 2000;
const SEMANTIC_LIMIT = 20;
const PROCEDURAL_LIMIT = 10;
const EPISODIC_LIMIT = 5;
/** bigram Jaccard 去重阈值。 */
const DUP_JACCARD = 0.85;

/** 归一化：小写 + 去标点/符号/空白，用于等价判定。 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

/** 字符 bigram 集合（中英通用；单字符退化为自身）。 */
function bigrams(s: string): Set<string> {
  const n = normalize(s);
  const set = new Set<string>();
  if (n.length === 1) set.add(n);
  for (let i = 0; i + 2 <= n.length; i++) set.add(n.slice(i, i + 2));
  return set;
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const inter = overlapCount(a, b);
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

const newestFirst = (a: Memory, b: Memory): number =>
  b.createdAt.localeCompare(a.createdAt);

/** 新增记忆；重复时返回 null。source 一般为回合号或 "manual"。 */
export function addMemory(
  kind: MemoryKind,
  content: string,
  source: string,
): Memory | null {
  const c = content.trim();
  if (!c) return null;
  const nc = normalize(c);
  const cb = bigrams(c);
  for (const m of getMemories()) {
    if (!m.valid) continue;
    if (normalize(m.content) === nc) return null;
    if (cb.size > 0 && jaccard(cb, bigrams(m.content)) > DUP_JACCARD) {
      return null;
    }
  }
  const now = new Date().toISOString();
  const mem: Memory = {
    id: newId("mem"),
    kind,
    content: c,
    createdAt: now,
    updatedAt: now,
    source,
    valid: true,
  };
  update({ memories: [...getMemories(), mem] });
  return mem;
}

/** 标记失效（supersededBy=by，by 为新条目 id 或 "void:xxx"）。 */
export function invalidateMemory(id: string, by: string): void {
  const list = getMemories();
  const idx = list.findIndex((m) => m.id === id);
  if (idx < 0) return;
  const next = list.slice();
  next[idx] = {
    ...next[idx],
    valid: false,
    supersededBy: by,
    updatedAt: new Date().toISOString(),
  };
  update({ memories: next });
}

/** 编辑 = 新增一条（source="manual"）并让旧条 supersededBy 指向新条。 */
export function editMemory(id: string, content: string): Memory | null {
  const old = getMemories().find((m) => m.id === id);
  if (!old) return null;
  const created = addMemory(old.kind, content, "manual");
  if (!created) return null; // 去重跳过：编辑失败
  invalidateMemory(id, created.id);
  return created;
}

/** 用户删除：supersededBy="void:delete"，valid=false（审计可见）。 */
export function deleteMemory(id: string): void {
  invalidateMemory(id, "void:delete");
}

/** 全部记忆（含失效，供审计视图）。 */
export function listMemories(includeInvalid = false): Memory[] {
  return getMemories()
    .filter((m) => includeInvalid || m.valid)
    .sort(newestFirst);
}

/** 关键词检索（大小写不敏感的子串 + 分词重叠）。 */
export function searchMemories(query: string): Memory[] {
  const q = query.trim();
  if (!q) return listMemories();
  const lower = q.toLowerCase();
  const qb = bigrams(q);
  return getMemories()
    .filter((m) => m.valid)
    .map((m) => {
      const hit = m.content.toLowerCase().includes(lower);
      const ov = qb.size ? overlapCount(qb, bigrams(m.content)) : 0;
      // 子串命中优先，其余按 bigram 重叠数排序
      return { m, score: (hit ? 1_000_000 : 0) + ov };
    })
    .filter((x) => x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || b.m.createdAt.localeCompare(a.m.createdAt),
    )
    .map((x) => x.m);
}

/**
 * 召回注入段：近 N 条 semantic/procedural +
 * 与 userText 有 token 重叠的 episodic top-K。无内容返回 ""。
 * 输出形如 "- …\n- …"（不含 "[长期记忆]" 标题，由 prompt.ts 加）。
 * 用户身份不在此——由 prompt.ts 的 [用户] 段固定注入，不受截断影响。
 */
export function recallBlock(userText: string): string {
  const lines: string[] = [];

  const valid = getMemories().filter((m) => m.valid);
  const recent = (kind: MemoryKind, n: number): Memory[] =>
    valid
      .filter((m) => m.kind === kind)
      .sort(newestFirst)
      .slice(0, n);

  for (const m of recent("semantic", SEMANTIC_LIMIT)) {
    lines.push(`- ${m.content}`);
  }
  for (const m of recent("procedural", PROCEDURAL_LIMIT)) {
    lines.push(`- ${m.content}`);
  }

  // episodic：与 userText 有 bigram 重叠的 top-5（同分取新）
  const qb = bigrams(userText);
  if (qb.size) {
    const eps = valid
      .filter((m) => m.kind === "episodic")
      .map((m) => ({ m, score: overlapCount(qb, bigrams(m.content)) }))
      .filter((x) => x.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || b.m.createdAt.localeCompare(a.m.createdAt),
      )
      .slice(0, EPISODIC_LIMIT);
    for (const { m } of eps) lines.push(`- ${m.content}`);
  }

  // 总长上限：从最末条往前丢
  let text = lines.join("\n");
  while (text.length > MAX_BLOCK_LEN && lines.length > 0) {
    lines.pop();
    text = lines.join("\n");
  }
  return text;
}
