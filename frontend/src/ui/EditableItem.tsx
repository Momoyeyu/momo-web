// 可编辑列表卡片：左侧正文（可选头部行 + 截断正文）+ 右侧图标操作列。
// 操作图标化并与正文垂直居中，故单行正文在卡片里也是居中的；
// 点击卡片打开详情；editing 时整卡换成 edit 传入的编辑表单（纵向）。
import type { ReactNode } from "react";
import { t } from "../i18n";
import IconButton from "./IconButton";
import "../styles/controls.css";

export default function EditableItem({
  editing,
  onOpen,
  head,
  edit,
  onStartEdit,
  onDelete,
  deleteConfirm,
  actions,
  children,
}: {
  editing: boolean;
  /** 点击卡片（非编辑态/非按钮区）。 */
  onOpen?: () => void;
  /** 卡片头部行（时间戳等）。 */
  head?: ReactNode;
  /** 编辑态内容（输入框 + 保存/取消行）。 */
  edit: ReactNode;
  onStartEdit: () => void;
  onDelete?: () => void;
  /** 删除前的确认文案；缺省则直接删。 */
  deleteConfirm?: string;
  /** 附加操作，排在编辑/删除之前（如记忆的图钉）。 */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`list-item${editing ? " list-editing" : " list-open"}`}
      onClick={() => {
        if (!editing) onOpen?.();
      }}
    >
      {editing ? (
        edit
      ) : (
        <>
          <div className="list-main">
            {head && <div className="list-head">{head}</div>}
            <div className="list-content">{children}</div>
          </div>
          <div className="list-ops">
            {actions}
            <IconButton
              icon="edit"
              label={t("common.edit")}
              tip={t("common.edit")}
              onClick={(e) => {
                e.stopPropagation();
                onStartEdit();
              }}
            />
            {onDelete && (
              <IconButton
                icon="trash"
                danger
                label={t("common.del")}
                tip={t("common.del")}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!deleteConfirm || window.confirm(deleteConfirm)) {
                    onDelete();
                  }
                }}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
