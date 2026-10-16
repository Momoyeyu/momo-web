// 方形纯图标按钮：34×34 描边框 + 居中 svg；hover 变金、描边加粗。
// 内置 plus / edit / trash；其余图标走 children 传 svg。
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
} as const;

export default function IconButton({
  label,
  onClick,
  disabled,
  icon,
  tip,
  danger,
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
  children?: ReactNode;
}) {
  const paths: readonly string[] | undefined = icon ? PATHS[icon] : undefined;
  return (
    <button
      type="button"
      className={`icon-btn${danger ? " danger" : ""}${tip ? " tip tip-r" : ""}`}
      aria-label={label}
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
