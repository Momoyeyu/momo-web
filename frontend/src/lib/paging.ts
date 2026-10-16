/** 设置页长列表共用：每页条数与页码钳制。 */
export const LIST_PAGE_SIZE = 10;

/** 卡片列表（Live2D 模型 / MCP 拓展）：每页 5 条。
 *
 *  与 styles/controls.css 的 .list-body（min-height 按 5 条预留）配套：
 *  一页预留满 5 条的高度，于是面板在 16:9 屏上尽量占满整页、又不到出滚动条的程度；
 *  两侧面板也无论实际有几条都等高。**改这里必须同步改那边的 min-height**。 */
export const CARD_PAGE_SIZE = 5;

/** 命中集 → 总页数（至少 1）；当前页越界时钳回末页。 */
export function clampPage(
  page: number,
  total: number,
  pageSize: number = LIST_PAGE_SIZE,
): {
  page: number;
  pages: number;
} {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return { page: Math.min(Math.max(0, page), pages - 1), pages };
}
