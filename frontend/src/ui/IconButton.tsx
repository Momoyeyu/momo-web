// 方形纯图标按钮：描边框 + 居中 svg；hover 变金、描边加粗。
// 内置 plus / edit / trash / check；其余图标走 children 传 svg。
// 纯图标没有可见文字，可发现性靠 tip（悬停浮窗）与 label（读屏）两者都给。
import type { MouseEvent, ReactNode } from "react";
import "../styles/controls.css";

const PATHS = {
  plus: ["M12 5v14M5 12h14"],
  edit: ["M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z"],
  trash: [
    "M5 7h14",
    "M10 7V5h4v2",
    "M6.6 7l.8 12.2a1 1 0 0 0 1 .8h7.2a1 1 0 0 0 1-.8L17.4 7",
  ],
  /** 采用 / 选中（如「使用该形象」）。 */
  check: ["M5 13l4 4L19 7"],
} as const;

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
  children,
}: {
  /** aria-label（纯图标按钮必须给读屏一个名字）。 */
  label: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  /** 内置图标名。 */
  icon?: keyof typeof PATHS;
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
  children?: ReactNode;
}) {
  const paths: readonly string[] | undefined = icon ? PATHS[icon] : undefined;
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
      {paths ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {paths.map((d) => (
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
      ) : (
        children
      )}
    </button>
  );
}
