// 存档槽位网格：视觉小说式 3 行 × 4 列 = 12 格/页，最多 10 页（手动槽位 1–120）。
// 纯函数模块——分页/槽位映射逻辑独立于组件，便于单测。

import type { CheckpointMeta } from "./types";

const GRID_COLS = 4;
const GRID_ROWS = 3;
export const PER_PAGE = GRID_COLS * GRID_ROWS;
export const MAX_PAGES = 10;
export const MAX_SLOT = PER_PAGE * MAX_PAGES;

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
 * 可翻页数：槽位固定 120 个 = 恒 10 页。
 * 空页也完整渲染（空槽位可见可存），翻页器始终显示 1/10–10/10；
 * 视觉上「10 页转满一圈」的 RoPE 节奏也依赖这个固定值。
 */
export function pageCount(): number {
  return MAX_PAGES;
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
