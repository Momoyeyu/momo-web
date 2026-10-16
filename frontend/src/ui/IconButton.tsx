// 方形纯图标按钮：34×34 描边框 + 居中 svg；hover 变金、描边加粗。
// icon="plus" 内置加号；其余图标走 children 传 svg。
import type { ReactNode } from "react";
import "../styles/controls.css";

export default function IconButton({
  label,
  onClick,
  disabled,
  icon,
  children,
}: {
  /** aria-label（纯图标按钮必须给读屏一个名字）。 */
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** 内置图标名；目前只有 "plus"。 */
  icon?: "plus";
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {icon === "plus" ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 5v14M5 12h14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        children
      )}
    </button>
  );
}
