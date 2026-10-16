// 行式表单项：左标签 + 右控件（+必填 * 标记 + 控件末尾小字）。
import type { ReactNode } from "react";
import "../styles/controls.css";

export default function FieldRow({
  label,
  extra,
  required,
  top,
  children,
}: {
  label: string;
  /** 控件末尾小字（如未配置提示）。 */
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
      </span>
      <div className="opt-ctl">
        {children}
        {extra && <span className="opt-extra">{extra}</span>}
      </div>
    </div>
  );
}
