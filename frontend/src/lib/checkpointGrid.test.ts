import { describe, expect, it } from "vitest";
import {
  MAX_PAGES,
  MAX_SLOT,
  PER_PAGE,
  buildCells,
  bySlot,
  pageCount,
} from "./checkpointGrid";
import type { CheckpointMeta } from "./types";

const meta = (slot: number | null, auto = false): CheckpointMeta => ({
  id: `s${slot ?? "auto"}`,
  title: "t",
  auto,
  slot,
  createdAt: "",
  updatedAt: "",
  preview: "",
});

describe("bySlot", () => {
  it("手动存档按 slot 索引，auto 槽与 slot=null 不入格", () => {
    const idx = bySlot([meta(2), meta(5), meta(null, true), meta(null)]);
    expect([...idx.keys()].sort()).toEqual([2, 5]);
  });
});

describe("pageCount", () => {
  it("槽位固定 120 个 → 恒 10 页，空页也完整渲染", () => {
    expect(pageCount()).toBe(MAX_PAGES);
    expect(MAX_PAGES * PER_PAGE).toBe(MAX_SLOT);
  });
});

describe("buildCells", () => {
  it("每页 12 格，槽位号连续，存档落对应格", () => {
    const cells = buildCells([meta(3), meta(14)], 0);
    expect(cells).toHaveLength(PER_PAGE);
    expect(cells[0]).toEqual({ slot: 1, save: null });
    expect(cells[2].save?.slot).toBe(3);
    expect(cells[11]).toEqual({ slot: 12, save: null });
    // 第 1 页不得漏进第 2 页的存档（分页边界）
    expect(cells.some((c) => c.save?.slot === 14)).toBe(false);

    const p2 = buildCells([meta(3), meta(14)], 1);
    expect(p2[0].slot).toBe(13);
    expect(p2[1].save?.slot).toBe(14);
    expect(p2[11].slot).toBe(24);
  });
});
