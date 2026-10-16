// 通用聚焦弹层——所有弹窗统一用它：
//   portal 到 body（祖先的 filter/backdrop-filter/transform 会截断 fixed
//   包含块，portal 保证遮罩铺满全屏视口）；
//   背景「聚焦」处理：轻调暗 + 虚化 + 降饱和（modal.css）；
//   点遮罩关闭、点内容不关闭；role=dialog 语义。
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import "../styles/modal.css";

export default function Modal({
  onClose,
  className,
  children,
}: {
  onClose: () => void;
  /** 弹窗盒子的附加类（用于覆盖尺寸/布局）。 */
  className?: string;
  children: ReactNode;
}) {
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={className ? `modal-box ${className}` : "modal-box"}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
