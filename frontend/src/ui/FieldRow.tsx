// 行式表单项：左标签 + 右控件（+必填 * 标记 + 控件末尾小字）。
import type { ReactNode } from "react";
import Hint from "./Hint";
import "../styles/controls.css";

export default function FieldRow({
  label,
  hint,
  extra,
  required,
  top,
  children,
}: {
  label: string;
  /** 标签旁的小问号说明（悬停展开，不占版面）。 */
  hint?: string;
  /** 控件末尾小字（尽量别用：说明优先走 hint）。 */
  extra?: ReactNode;
  /** 必填项：标签后加 * 标记。 */
  required?: boolean;
  /** 多行控件（键值对编辑器）：标签顶对齐而非居中。 */
  top?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`opt-row${top ? " top" : ""}`}>
      <span className="opt-label">
        {label}
        {required && <span className="req">*</span>}
        {hint && <Hint text={hint} side="down" />}
      </span>
      <div className="opt-ctl">
        {children}
        {extra && <span className="opt-extra">{extra}</span>}
      </div>
    </div>
  );
}
