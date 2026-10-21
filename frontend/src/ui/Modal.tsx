// 通用聚焦弹层——所有弹窗统一用它：
//   portal 到 body（祖先的 filter/backdrop-filter/transform 会截断 fixed
//   包含块，portal 保证遮罩铺满全屏视口）；
//   背景「聚焦」处理：轻调暗 + 虚化 + 降饱和（modal.css）；
//   点遮罩关闭、点内容不关闭；role=dialog 语义。
import { createPortal } from "react-dom";
import { useEffect, useRef, type ReactNode, type KeyboardEvent } from "react";
import "../styles/modal.css";

export default function Modal({
  onClose,
  className,
  children,
  label,
}: {
  onClose: () => void;
  /** 弹窗盒子的附加类（用于覆盖尺寸/布局）。 */
  className?: string;
  children: ReactNode;
  label?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    box.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
    if (e.key !== "Tab") return;
    const controls = [...(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? [])].filter(el => el.getClientRects().length);
    const first = controls[0]; const last = controls.at(-1);
    if (!first) { e.preventDefault(); return; }
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || document.activeElement === box.current)) { e.preventDefault(); first.focus(); }
  };
  return createPortal(
    <div className="modal-overlay" onClick={onClose} onKeyDown={onKeyDown}>
      <div
        ref={box}
        tabIndex={-1}
        className={className ? `modal-box ${className}` : "modal-box"}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
