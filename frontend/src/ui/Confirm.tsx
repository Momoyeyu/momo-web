// 通用确认弹窗——全站替代原生 window.confirm：
// 标题 + 说明 + [取消][确认]；危险操作（删除）走红色主按钮。
// 用自定义 UI 而不是浏览器弹窗：文案换行、字距、按钮顺序都可控，i18n 长度差异也好排。
// Esc / 点遮罩 = 取消；busy 时确认键置灰防重复提交。

import { useId } from "react";
import Modal from "./Modal";
import Button from "./Button";
import { t } from "../i18n";
import "../styles/modal.css";

export default function Confirm({
  title,
  subject,
  message,
  error,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  subject?: string;
  message: string;
  error?: string;
  /** 确认键文案：写清楚会发生什么（「覆盖」「读取」「删除」），不用「确定」。 */
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const descriptionId = useId();
  const close = () => {if (!busy) onCancel();};
  return (
    <Modal onClose={close} label={title} describedBy={subject ? descriptionId + "-subject " + descriptionId : descriptionId} className="confirm-box">
      <h2 className="confirm-title">{title}</h2>
      {subject && <p id={descriptionId + "-subject"} className="confirm-subject">{subject}</p>}
      <p id={descriptionId} className="confirm-text">{message}</p>
      {error && <p className="probe-err" role="alert">{error}</p>}
      <div className="modal-foot">
        <Button variant="ghost" disabled={busy} onClick={close}>
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
