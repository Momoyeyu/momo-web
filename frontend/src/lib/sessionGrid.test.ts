import { describe, expect, it } from "vitest";
import {
  MAX_PAGES,
  MAX_SLOT,
  PER_PAGE,
  buildCells,
  bySlot,
  pageCount,
} from "./sessionGrid";
import type { SessionMeta } from "./types";

const meta = (slot: number | null, auto = false): SessionMeta => ({
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
  it("无存档 → 1 页", () => {
    expect(pageCount([], "load")).toBe(1);
    expect(pageCount([], "save")).toBe(1);
  });

  it("读档模式 = 实际存档页数，空页不可达", () => {
    expect(pageCount([meta(5)], "load")).toBe(1);
    expect(pageCount([meta(12)], "load")).toBe(1);
    expect(pageCount([meta(13)], "load")).toBe(2);
    expect(pageCount([meta(120)], "load")).toBe(10);
  });

  it("存档模式在最末满页后多放一页空页", () => {
    expect(pageCount([meta(5)], "save")).toBe(1);
    expect(pageCount([meta(12)], "save")).toBe(2); // 第 1 页满 → 第 2 页可存
    expect(pageCount([meta(13)], "save")).toBe(2);
    expect(pageCount([meta(120)], "save")).toBe(MAX_PAGES); // 上限 10 页
  });
});

describe("buildCells", () => {
  it("每页 12 格，槽位号连续，存档落对应格", () => {
    const cells = buildCells([meta(3), meta(14)], 0);
    expect(cells).toHaveLength(PER_PAGE);
    expect(cells[0]).toEqual({ slot: 1, save: null });
    expect(cells[2].save?.slot).toBe(3);
    expect(cells[11]).toEqual({ slot: 12, save: null });

    const p2 = buildCells([meta(3), meta(14)], 1);
    expect(p2[0].slot).toBe(13);
    expect(p2[1].save?.slot).toBe(14);
    expect(p2[11].slot).toBe(24);
  });

  it("槽位上限 = 页数 × 每页格数 = 120", () => {
    expect(MAX_SLOT).toBe(120);
  });
});
