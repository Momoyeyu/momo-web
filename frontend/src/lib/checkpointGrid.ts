// 存档槽位网格：视觉小说式 3 行 × 4 列 = 12 格/页，最多 10 页（手动槽位 1–120）。
// 纯函数模块——分页/槽位映射逻辑独立于组件，便于单测。

import type { CheckpointMeta } from "./types";
import type { CheckpointMode } from "../router";

export const GRID_COLS = 4;
export const GRID_ROWS = 3;
export const PER_PAGE = GRID_COLS * GRID_ROWS; // 12
export const MAX_PAGES = 10;
export const MAX_SLOT = PER_PAGE * MAX_PAGES; // 120

/** 一格：槽位号 + 该槽存档（空槽为 null）。 */
export interface SlotCell {
  slot: number;
  save: CheckpointMeta | null;
}

/** 手动存档按槽位号索引（auto 槽不入网格）。 */
export function bySlot(manual: CheckpointMeta[]): Map<number, CheckpointMeta> {
  const m = new Map<number, CheckpointMeta>();
  for (const s of manual) {
    if (!s.auto && typeof s.slot === "number") m.set(s.slot, s);
  }
  return m;
}

/**
 * 可翻页数（1–10）：
 * - 读档模式 = 实际存档覆盖的页数，空页不必可达；
 * - 存档模式在最末满页之后多放一页空页（否则页满时无处保存）。
 */
export function pageCount(manual: CheckpointMeta[], mode: CheckpointMode): number {
  const maxUsed = manual.reduce(
    (m, s) => (typeof s.slot === "number" ? Math.max(m, s.slot) : m),
    0,
  );
  const n =
    mode === "save"
      ? Math.floor(maxUsed / PER_PAGE) + 1
      : Math.ceil(maxUsed / PER_PAGE);
  return Math.min(MAX_PAGES, Math.max(1, n));
}

/** 一页的 12 格（page 从 0 起）。 */
export function buildCells(manual: CheckpointMeta[], page: number): SlotCell[] {
  const idx = bySlot(manual);
  const start = page * PER_PAGE + 1;
  return Array.from({ length: PER_PAGE }, (_, i) => {
    const slot = start + i;
    return { slot, save: idx.get(slot) ?? null };
  });
}
