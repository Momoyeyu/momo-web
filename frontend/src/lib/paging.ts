/** 设置页长列表共用：每页条数与页码钳制。 */
export const LIST_PAGE_SIZE = 10;

/** 「偏好 / Live2D 模型」这类卡片列表：每页 3 条。
 *  与 styles/controls.css 的 .list-reserve（按 3 条预留高度）配套，
 *  两侧面板因此无论几条都等高。 */
export const CARD_PAGE_SIZE = 3;

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
