/** 设置页长列表共用：每页条数与页码钳制。 */
export const LIST_PAGE_SIZE = 10;

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
