// 分页契约：一页 5 条，且与 .list-body 的预留高度成对绑定。
//
// 这两处必须同时改（CSS 注释里也写了「改一处必须改另一处」），但注释挡不住手滑，
// 所以在这里用测试钉住：卡片高度 70 + 间距 8，一页 5 条 ⇒ 390px。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CARD_PAGE_SIZE, clampPage } from "./paging";

const CSS = readFileSync(
  fileURLToPath(new URL("../styles/controls.css", import.meta.url)),
  "utf8",
);

const CARD_HEIGHT = 70; // .list-item 的 min-height
const CARD_GAP = 8; // .list-item 的 margin-bottom

describe("分页", () => {
  it("一页 5 条（Live2D 与 MCP 共用）", () => {
    expect(CARD_PAGE_SIZE).toBe(5);
  });

  it(".list-body 的预留高度 = 一页条数 × (卡片高 + 间距)", () => {
    const want = CARD_PAGE_SIZE * (CARD_HEIGHT + CARD_GAP);
    expect(want).toBe(390);
    expect(CSS).toMatch(new RegExp(`min-height:\\s*${want}px`));
    expect(CSS).toMatch(new RegExp(`\\.list-item[^}]*min-height:\\s*${CARD_HEIGHT}px`));
  });

  it("总页数至少 1 页，当前页越界时钳回末页", () => {
    expect(clampPage(0, 0, CARD_PAGE_SIZE)).toEqual({ page: 0, pages: 1 }); // 空集仍 1 页
    expect(clampPage(2, 6, CARD_PAGE_SIZE)).toEqual({ page: 1, pages: 2 });
    expect(clampPage(9, 12, CARD_PAGE_SIZE)).toEqual({ page: 2, pages: 3 }); // 越界钳回末页
    expect(clampPage(-1, 12, CARD_PAGE_SIZE)).toEqual({ page: 0, pages: 3 }); // 负数钳回首
  });
});
