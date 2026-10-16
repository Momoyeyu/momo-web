// 「+ 添加条目」弹窗。
//
// 与 ui/IconButton 的 icon="plus" 是**软绑定**关系：两者代码刻意不写在一起
// （加号是通用图标按钮，本组件是通用收集表单），但约定成对出现 ——
//   列表用「+」添加**文本条目**时，内容一律由这个弹窗收集，不要再用
//   「追加空行 + 进编辑态」那种内联添加。
// 例外：添加的不是单条文本，而是文件（形象导入）或键值对（拓展 env/headers）
// 时各走自己的弹窗/内联行 —— 那两种形态本组件收集不了。
// 新增「+ 添加」功能时记得接上它；改本组件时记得所有「+」都在用。
import { useState } from "react";
import type { ReactNode } from "react";
import Modal from "./Modal";
import Button from "./Button";
import { useT } from "../i18n";
import "../styles/modal.css";

export default function AddItemModal({
  title,
  placeholder,
  multiline,
  extra,
  onSave,
  onCancel,
}: {
  /** 弹窗顶部的一行灰字标题。 */
  title: string;
  placeholder?: string;
  /** 多行内容用 textarea（记忆），单行用 input。 */
  multiline?: boolean;
  /** 输入框下方的附加选项（如记忆的 PIN 开关）。 */
  extra?: ReactNode;
  /** 内容已 trim，非空才会回调。 */
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const text = draft.trim();
  // 空内容点保存等同取消（与卡片编辑的既有语义一致）
  const save = (): void => (text ? onSave(text) : onCancel());

  return (
    <Modal onClose={onCancel} className="add-modal">
      <div className="modal-meta muted">{title}</div>
      {multiline ? (
        <textarea
          className="add-field"
          rows={4}
          autoFocus
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
            // 多行用 ⌘/Ctrl+Enter 提交，单 Enter 留给换行
            else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          }}
        />
      ) : (
        <input
          className="add-field"
          autoFocus
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) save();
            else if (e.key === "Escape") onCancel();
          }}
        />
      )}
      {extra}
      <div className="modal-foot">
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button onClick={save} disabled={!text}>
          {t("common.save")}
        </Button>
      </div>
    </Modal>
  );
}
