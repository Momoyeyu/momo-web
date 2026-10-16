// 迷你翻页器 ‹ n/N ›：设置页长列表（记忆 / Live2D / MCP）与存档页槽位网格共用。
// 始终渲染——单页时显示 1/1、两侧箭头置灰；页码超界由调用方 clamp。

import { useT } from "../i18n";
import Button from "./Button";
import "../styles/controls.css";

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
  return (
    <span className="list-pager">
      <Button
        className="pager-btn"
        disabled={page <= 0}
        onClick={() => onChange(page - 1)}
      >
        ‹
      </Button>
      <span className="pager-text">
        {t("common.pageOf", { cur: String(page + 1), total: String(pages) })}
      </span>
      <Button
        className="pager-btn"
        disabled={page >= pages - 1}
        onClick={() => onChange(page + 1)}
      >
        ›
      </Button>
    </span>
  );
}
