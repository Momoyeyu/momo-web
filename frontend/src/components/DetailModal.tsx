import Modal from "../ui/Modal";
import DialogBackButton from "../ui/DialogBackButton";

/**
 * 详情弹窗：聚焦遮罩（Modal）+ 居中弹窗 + 只读全文 + 返回上一层。
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
        <DialogBackButton onClick={onClose}/>
      </div>
    </Modal>
  );
}
