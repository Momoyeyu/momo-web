// 可编辑列表卡片：常态 = 头部(可选)+截断正文+编辑/删除，点击打开详情；
// editing 时整卡换成 edit 传入的编辑表单。删除可附确认文案。
import type { ReactNode } from "react";
import { t } from "../i18n";
import Button from "./Button";
import "../styles/controls.css";

export default function EditableItem({
  editing,
  onOpen,
  head,
  edit,
  onStartEdit,
  onDelete,
  deleteConfirm,
  children,
}: {
  editing: boolean;
  /** 点击卡片（非编辑态/非按钮区）。 */
  onOpen?: () => void;
  /** 卡片头部行（时间戳、pin 图标等）。 */
  head?: ReactNode;
  /** 编辑态内容（输入框 + 保存/取消行）。 */
  edit: ReactNode;
  onStartEdit: () => void;
  onDelete?: () => void;
  /** 删除前的确认文案；缺省则直接删。 */
  deleteConfirm?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`list-item${editing ? "" : " list-open"}`}
      onClick={() => {
        if (!editing) onOpen?.();
      }}
    >
      {editing ? (
        edit
      ) : (
        <>
          {head && <div className="list-head">{head}</div>}
          <div className="list-content">{children}</div>
          <div className="list-ops">
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onStartEdit();
              }}
            >
              {t("common.edit")}
            </Button>
            {onDelete && (
              <Button
                variant="ghost"
                size="sm"
                danger
                onClick={(e) => {
                  e.stopPropagation();
                  if (!deleteConfirm || window.confirm(deleteConfirm)) {
                    onDelete();
                  }
                }}
              >
                {t("common.del")}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
