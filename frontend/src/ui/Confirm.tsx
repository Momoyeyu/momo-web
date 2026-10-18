// 通用确认弹窗——全站替代原生 window.confirm：
// 标题 + 说明 + [取消][确认]；危险操作（删除）走红色主按钮。
// 用自定义 UI 而不是浏览器弹窗：文案换行、字距、按钮顺序都可控，i18n 长度差异也好排。
// Esc / 点遮罩 = 取消；busy 时确认键置灰防重复提交。

import { useEffect } from "react";
import Modal from "./Modal";
import Button from "./Button";
import { t } from "../i18n";
import "../styles/modal.css";

export default function Confirm({
  title,
  message,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  /** 确认键文案：写清楚会发生什么（「覆盖」「读取」「删除」），不用「确定」。 */
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <Modal onClose={onCancel} className="confirm-box">
      <h2 className="confirm-title">{title}</h2>
      <p className="confirm-text">{message}</p>
      <div className="modal-foot">
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button
          className={danger ? "btn-danger" : undefined}
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
