// 详情弹窗（统一机制）：偏好条目 / 记忆卡片点开的只读全文展示。
// 背景整体变暗、点背景任意处关闭；弹窗内只读展示 + [关闭]，
// 编辑/删除不进弹窗——仍在列表卡片上操作。

import { t } from "../i18n";

export default function DetailModal({
  meta,
  text,
  onClose,
}: {
  /** 正文上方的辅助信息行（如记忆创建时间），可省略。 */
  meta?: string;
  /** 全文正文（保留换行）。 */
  text: string;
  onClose: () => void;
}) {
  return (
    <div className="detail-overlay" onClick={onClose}>
      <div
        className="detail-modal"
        role="dialog"
        onClick={(e) => e.stopPropagation()}
      >
        {meta && <div className="detail-meta muted">{meta}</div>}
        <div className="detail-body">{text}</div>
        <div className="detail-foot">
          <button className="ghost small" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
