// 迷你翻页器 ‹ n/N ›：设置页长列表（偏好/初始记忆/普通记忆）共用。
// 单页时不渲染；页码超界由调用方 clamp（见 lib/paging.ts）。

import { useT } from "../i18n";

export default function Pager({
  page,
  pages,
  onChange,
}: {
  page: number;
  pages: number;
  onChange: (page: number) => void;
}) {
  const t = useT();
  if (pages <= 1) return null;
  return (
    <span className="list-pager">
      <button
        type="button"
        className="ghost small"
        disabled={page <= 0}
        onClick={() => onChange(page - 1)}
      >
        ‹
      </button>
      <span className="pager-text">
        {t("common.pageOf", { cur: String(page + 1), total: String(pages) })}
      </span>
      <button
        type="button"
        className="ghost small"
        disabled={page >= pages - 1}
        onClick={() => onChange(page + 1)}
      >
        ›
      </button>
    </span>
  );
}
