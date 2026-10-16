// 记忆面板（设置页 tab）：全部记忆统一列表——pinned 仅是 DB 字段
// （常驻注入 prompt），前端不分栏；检索 / 弹窗添加（可选 PIN）/
// 编辑 / 删除 / pin 切换 / 分页（每页 5 条），卡片点开详情弹窗。

import { useEffect, useMemo, useState } from "react";
import type { Memory } from "../lib/types";
import {
  addMemory as apiAdd,
  deleteMemory as apiDelete,
  editMemory as apiEdit,
  setMemoryPinned as apiSetPinned,
  listMemories,
} from "../services/memoryClient";
import { clampPage } from "../lib/paging";
import Pager from "../ui/Pager";
import DetailModal from "../components/DetailModal";
import EditableItem from "../ui/EditableItem";
import IconButton from "../ui/IconButton";
import Button from "../ui/Button";
import Modal from "../ui/Modal";
import { useT, currentLang } from "../i18n";
import "../styles/persona.css";
import "../styles/settings.css";
import "../styles/controls.css";

const LOCALE = { zh: "zh-CN", ja: "ja-JP", en: "en-US" } as const;
const PAGE_SIZE = 5;

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(LOCALE[currentLang()] ?? "zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function MemoryPanel() {
  const t = useT();

  const [memories, setMemories] = useState<Memory[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // 「+ 添加」弹窗：内容草稿 + 是否 PIN。
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState("");
  const [addPinned, setAddPinned] = useState(false);
  // 卡片点开的详情弹窗（只读全文）。
  const [detail, setDetail] = useState<Memory | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      setMemories(await listMemories());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // 检索 + 按创建时间倒序（命中集分页，越界钳回末页）
  const shown = useMemo<Memory[]>(() => {
    const q = query.trim().toLowerCase();
    return memories
      .filter((m) => !q || m.content.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [memories, query]);
  const pg = clampPage(page, shown.length, PAGE_SIZE);
  const shownSlice = shown.slice(
    pg.page * PAGE_SIZE,
    (pg.page + 1) * PAGE_SIZE,
  );

  const startEdit = (m: Memory): void => {
    setEditingId(m.id);
    setEditDraft(m.content);
  };

  const cancelEdit = (): void => {
    setEditingId(null);
    setEditDraft("");
  };

  const commitEdit = async (): Promise<void> => {
    const id = editingId;
    cancelEdit();
    if (!id) return;
    try {
      await apiEdit(id, editDraft.trim());
      await refresh();
    } catch {
      setLoadFailed(true);
    }
  };

  const commitAdd = async (): Promise<void> => {
    const c = addDraft.trim();
    const pinned = addPinned;
    setAdding(false);
    setAddDraft("");
    setAddPinned(false);
    if (!c) return;
    try {
      await apiAdd(c, pinned);
      await refresh();
    } catch {
      setLoadFailed(true);
    }
  };

  const togglePin = async (m: Memory): Promise<void> => {
    try {
      await apiSetPinned(m.id, !m.pinned);
      await refresh();
    } catch {
      setLoadFailed(true);
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      await apiDelete(id);
      await refresh();
    } catch {
      setLoadFailed(true);
    }
  };

  /** 非编辑态卡片可点开详情弹窗（操作钮 stopPropagation 不触发）。 */
  const memCard = (m: Memory) => (
    <EditableItem
      key={m.id}
      editing={editingId === m.id}
      onOpen={() => setDetail(m)}
      onStartEdit={() => startEdit(m)}
      onDelete={() => void remove(m.id)}
      deleteConfirm={t("memory.confirmDelete")}
      // 图钉与编辑/删除同列：都是右侧图标操作，垂直居中对齐
      actions={
        <Button
          className={`mem-pinicon tip tip-r${m.pinned ? " on" : ""}`}
          data-tip={t("memory.pinTip")}
          onClick={(e) => {
            e.stopPropagation();
            void togglePin(m);
          }}
        >
          {/* 图钉：pinned=实心金，unpinned=金色描边 */}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M9 4h6l-1.2 6.2L17 13.4V15H7v-1.6l3.2-3.2L9 4z"
              fill={m.pinned ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <path
              d="M12 15v5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </Button>
      }
      head={<span className="muted">{formatTime(m.createdAt)}</span>}
      edit={
        <div className="list-edit">
          <textarea
            rows={3}
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
          />
          <div className="row">
            <Button size="sm" onClick={() => void commitEdit()}>
              {t("common.save")}
            </Button>
            <Button variant="ghost" size="sm" onClick={cancelEdit}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      }
    >
      {m.content}
    </EditableItem>
  );

  return (
    <section className="panel persona-section mem-panel">
      <div className="mem-toolbar">
        <input
          className="mem-search"
          placeholder={t("memory.searchPh")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
        <IconButton
          icon="plus"
          label={t("memory.newTitle")}
          onClick={() => setAdding(true)}
          disabled={editingId !== null}
        />
      </div>
      <div className="col-grow">
        {loadFailed && <p className="muted">{t("memory.loadFailed")}</p>}
        {!loadFailed && shown.length === 0 && (
          <p className="muted">{t("memory.empty")}</p>
        )}
        {shownSlice.map(memCard)}
      </div>
      <div className="col-foot">
        <div className="mem-foot">
          <Pager page={pg.page} pages={pg.pages} onChange={setPage} />
        </div>
      </div>

      {/* 添加记忆弹窗：内容 + PIN 选项 */}
      {adding && (
        <Modal onClose={() => setAdding(false)}>
          <div className="modal-meta muted">{t("memory.newTitle")}</div>
          <textarea
            className="mem-add-text"
            rows={4}
            autoFocus
            value={addDraft}
            onChange={(e) => setAddDraft(e.target.value)}
          />
          <div className="mem-pinopt">
            {/* 与记忆卡片同款图钉：pinned=实心金 / unpinned=金色描边 */}
            <Button
              className={`mem-pinicon tip tip-l${addPinned ? " on" : ""}`}
              data-tip={t("memory.pinTip")}
              aria-pressed={addPinned}
              onClick={() => setAddPinned((v) => !v)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M9 4h6l-1.2 6.2L17 13.4V15H7v-1.6l3.2-3.2L9 4z"
                  fill={addPinned ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
                <path
                  d="M12 15v5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </Button>
            <span>PIN</span>
          </div>
          <div className="modal-foot">
            <Button variant="ghost" onClick={() => setAdding(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void commitAdd()}>{t("common.save")}</Button>
          </div>
        </Modal>
      )}

      {detail && (
        <DetailModal
          meta={formatTime(detail.createdAt)}
          text={detail.content}
          onClose={() => setDetail(null)}
        />
      )}
    </section>
  );
}
