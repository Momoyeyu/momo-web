import Modal from "../ui/Modal";
import Button from "../ui/Button";
import { t } from "../i18n";

/**
 * 详情弹窗：聚焦遮罩（Modal）+ 居中弹窗 + 只读全文 + [关闭]。
 * meta 可选（时间等），text 必填。
 */
export default function DetailModal({
  meta,
  text,
  onClose,
}: {
  meta?: string;
  text: string;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose}>
      {meta && <div className="modal-meta muted">{meta}</div>}
      <div className="modal-body">{text}</div>
      <div className="modal-foot">
        <Button onClick={onClose}>{t("common.close")}</Button>
      </div>
    </Modal>
  );
}
