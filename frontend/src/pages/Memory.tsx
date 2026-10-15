// 记忆面板（设置页 tab）：初始记忆（pin，momo.db pinned 行）+
// 普通记忆列表（backend /api/memories REST，检索/手动加/编辑/删除）。
// 两类记忆都是真实行 id，条目级操作直达 backend。

import { useEffect, useMemo, useState } from "react";
import type { Memory } from "../lib/types";
import {
  addMemory as apiAdd,
  deleteMemory as apiDelete,
  editMemory as apiEdit,
  listMemories,
} from "../services/memoryClient";
import { LIST_PAGE_SIZE, clampPage } from "../lib/paging";
import Pager from "../ui/Pager";
import DetailModal from "../components/DetailModal";
import { useT, currentLang } from "../i18n";
import "../styles/persona.css";
import "../styles/settings.css";
import "../styles/controls.css";

const LOCALE = { zh: "zh-CN", ja: "ja-JP", en: "en-US" } as const;
const NEW_ID = "__new__";

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
  const [pinQuery, setPinQuery] = useState("");
  const [memPage, setMemPage] = useState(0);
  const [pinPage, setPinPage] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // 「+ 添加」挂起的新条目草稿：NEW_ID 占位 id + 所属栏目标记。
  const [draftPinned, setDraftPinned] = useState<boolean | null>(null);
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

  const pins = useMemo(() => memories.filter((m) => m.pinned), [memories]);

  const shown = useMemo<Memory[]>(() => {
    const q = query.trim().toLowerCase();
    const list = memories
      .filter((m) => !m.pinned)
      .filter((m) => !q || m.content.toLowerCase().includes(q));
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [memories, query]);

  // 初始记忆检索 + 两侧分页（命中集分页，越界钳回末页）
  const pinHits = useMemo(() => {
    const q = pinQuery.trim().toLowerCase();
    return pins.filter((m) => !q || m.content.toLowerCase().includes(q));
  }, [pins, pinQuery]);
  const pinPg = clampPage(pinPage, pinHits.length);
  const pinSlice = pinHits.slice(
    pinPg.page * LIST_PAGE_SIZE,
    (pinPg.page + 1) * LIST_PAGE_SIZE,
  );
  const memPg = clampPage(memPage, shown.length);
  const shownSlice = shown.slice(
    memPg.page * LIST_PAGE_SIZE,
    (memPg.page + 1) * LIST_PAGE_SIZE,
  );

  const startAdd = (pinned: boolean): void => {
    // 草稿卡顶到第一页；清掉检索词保证草稿可见
    setDraftPinned(pinned);
    setEditingId(NEW_ID);
    setEditDraft("");
    if (pinned) {
      setPinQuery("");
      setPinPage(0);
    } else {
      setQuery("");
      setMemPage(0);
    }
  };

  const startEdit = (m: Memory): void => {
    setEditingId(m.id);
    setEditDraft(m.content);
  };

  const commitEdit = async (): Promise<void> => {
    const id = editingId;
    const pinned = draftPinned;
    setEditingId(null);
    setEditDraft("");
    setDraftPinned(null);
    if (!id) return;
    try {
      if (id === NEW_ID && pinned !== null) {
        const c = editDraft.trim();
        if (c) await apiAdd(c, pinned);
      } else {
        await apiEdit(id, editDraft.trim());
      }
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

  const editRow = (m: Memory) =>
    editingId === m.id ? (
      <div className="mem-edit">
        <textarea
          rows={3}
          value={editDraft}
          onChange={(e) => setEditDraft(e.target.value)}
        />
        <div className="row">
          <button className="small" onClick={() => void commitEdit()}>
            {t("common.save")}
          </button>
          <button
            className="ghost small"
            onClick={() => {
              setEditingId(null);
              setEditDraft("");
              setDraftPinned(null);
            }}
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    ) : (
      <>
        <div className="mem-head">
          <span className="muted">{formatTime(m.createdAt)}</span>
        </div>
        <div className="mem-content">{m.content}</div>
        <div className="mem-ops">
          <button
            className="ghost small"
            onClick={(e) => {
              e.stopPropagation();
              startEdit(m);
            }}
          >
            {t("common.edit")}
          </button>
          <button
            className="ghost small danger"
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm(t("memory.confirmDelete"))) {
                void remove(m.id);
              }
            }}
          >
            {t("common.del")}
          </button>
        </div>
      </>
    );

  /** 非编辑态卡片可点开详情弹窗（编辑/删除钮 stopPropagation 不触发）。 */
  const memCard = (m: Memory) => (
    <div
      className={`mem-item${editingId === m.id ? "" : " mem-open"}`}
      key={m.id}
      onClick={() => {
        if (editingId !== m.id) setDetail(m);
      }}
    >
      {editRow(m)}
    </div>
  );

  /** 「+ 添加」挂起时的草稿卡（直接编辑态，提交才落 API）。 */
  const draftCard = (pinned: boolean) =>
    draftPinned === pinned && editingId === NEW_ID ? (
      <div className="mem-item" key={NEW_ID}>
        {editRow({
          id: NEW_ID,
          content: "",
          createdAt: "",
          pinned,
        })}
      </div>
    ) : null;

  return (
    /* 双栏：初始记忆 | 普通记忆；添加行钉在各面板底缘。 */
    <div className="settings-cols">
      {/* 1. 初始记忆（pin）：常驻事实，保存后进 system prompt 的「初始记忆」段 */}
      <section className="panel persona-section settings-col">
        <h2>{t("memory.pinsTitle")}</h2>
        <p className="muted">{t("memory.pinsDesc")}</p>
        <div className="mem-toolbar">
          <input
            className="mem-search"
            placeholder={t("memory.pinSearchPh")}
            value={pinQuery}
            onChange={(e) => {
              setPinQuery(e.target.value);
              setPinPage(0);
            }}
          />
        </div>
        <div className="col-grow">
          {draftCard(true)}
          {loadFailed && <p className="muted">{t("memory.loadFailed")}</p>}
          {pinSlice.map(memCard)}
          {pinHits.length === 0 && !loadFailed && (
            <p className="muted">{t("memory.empty")}</p>
          )}
        </div>
        <div className="col-foot">
          <div className="list-foot">
            <button
              className="ghost"
              onClick={() => startAdd(true)}
              disabled={editingId !== null}
            >
              {t("memory.pinAdd")}
            </button>
            <Pager
              page={pinPg.page}
              pages={pinPg.pages}
              onChange={setPinPage}
            />
          </div>
        </div>
      </section>

      {/* 2. 普通记忆：agent 工具写入 + 手动维护，数据在 backend */}
      <section className="panel persona-section settings-col">
        <h2>{t("memory.normalTitle")}</h2>
        <p className="muted">{t("memory.normalDesc")}</p>
        <div className="mem-toolbar">
          <input
            className="mem-search"
            placeholder={t("memory.searchPh")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setMemPage(0);
            }}
          />
        </div>
        <div className="col-grow">
          {draftCard(false)}
          {loadFailed && <p className="muted">{t("memory.loadFailed")}</p>}
          {!loadFailed && shown.length === 0 && (
            <p className="muted">{t("memory.empty")}</p>
          )}

          {shownSlice.map(memCard)}
        </div>
        <div className="col-foot">
          <div className="list-foot">
            <button
              className="ghost"
              onClick={() => startAdd(false)}
              disabled={editingId !== null}
            >
              {t("memory.add")}
            </button>
            <Pager
              page={memPg.page}
              pages={memPg.pages}
              onChange={setMemPage}
            />
          </div>
        </div>
      </section>
      {detail && (
        <DetailModal
          meta={formatTime(detail.createdAt)}
          text={detail.content}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}
