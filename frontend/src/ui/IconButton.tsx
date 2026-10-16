// 方形纯图标按钮：描边框 + 居中 svg；hover 变金、描边加粗。
// 内置 plus / edit / trash / check 四种图标。
// 纯图标没有可见文字，可发现性靠 tip（悬停浮窗）与 label（读屏）两者都给。
import type { MouseEvent } from "react";

import { ICONS, type IconName } from "./icons";

import "../styles/controls.css";

export default function IconButton({
  label,
  onClick,
  disabled,
  icon,
  tip,
  danger,
  active,
  size = "md",
  className,
}: {
  /** aria-label（纯图标按钮必须给读屏一个名字）。 */
  label: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  /** 内置图标名。 */
  icon?: IconName;
  /** 悬停浮窗文案。 */
  tip?: string;
  /** 危险操作（删除等）：hover 转红。 */
  danger?: boolean;
  /**
   * 已采用 / 已开启。**按钮常驻、只切换外观**，不要用「消失」表达选中态——
   * 那会让同一列后面的按钮位移。
   */
  active?: boolean;
  /** sm = 列表行内（28×28），md = 独立位置（34×34）。 */
  size?: "md" | "sm";
  /** 附加类（多为定位，如存档卡的 .slot-del）。 */
  className?: string;
}) {
  const paths = icon ? ICONS[icon] : undefined;
  const cls = [
    "icon-btn",
    size === "sm" ? "icon-btn-sm" : "",
    active ? "on" : "",
    danger ? "danger" : "",
    tip ? "tip tip-r" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={cls}
      aria-label={label}
      {...(active === undefined ? {} : { "aria-pressed": active })}
      data-tip={tip}
      onClick={onClick}
      disabled={disabled}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {(paths ?? []).map((d) => (
          <path
            key={d}
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
    </button>
  );
}
