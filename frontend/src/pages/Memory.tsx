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
import { useT, currentLang } from "../i18n";
import "../styles/persona.css";
import "../styles/settings.css";
import "../styles/controls.css";

const LOCALE = { zh: "zh-CN", ja: "ja-JP", en: "en-US" } as const;

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
  const [addDraft, setAddDraft] = useState("");
  const [pinDraft, setPinDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

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

  const add = async (content: string, pinned: boolean): Promise<void> => {
    const c = content.trim();
    if (!c) return;
    try {
      await apiAdd(c, pinned);
      if (pinned) setPinDraft("");
      else setAddDraft("");
      await refresh();
    } catch {
      setLoadFailed(true);
    }
  };

  const startEdit = (m: Memory): void => {
    setEditingId(m.id);
    setEditDraft(m.content);
  };

  const commitEdit = async (): Promise<void> => {
    const id = editingId;
    setEditingId(null);
    setEditDraft("");
    if (!id) return;
    try {
      await apiEdit(id, editDraft.trim());
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
          <button className="ghost small" onClick={() => startEdit(m)}>
            {t("common.edit")}
          </button>
          <button
            className="ghost small danger"
            onClick={() => {
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

  return (
    /* 双栏：初始记忆 | 普通记忆；添加行钉在各面板底缘。 */
    <div className="settings-cols">
      {/* 1. 初始记忆（pin）：常驻事实，保存后进 system prompt 的「初始记忆」段 */}
      <section className="panel persona-section settings-col">
        <h2>{t("memory.pinsTitle")}</h2>
        <p className="muted">{t("memory.pinsDesc")}</p>
        <div className="col-grow">
          {pins.map((m) => (
            <div className="mem-item" key={m.id}>
              {editRow(m)}
            </div>
          ))}
        </div>
        <div className="col-foot">
          <div className="row">
            <input
              className="mem-search"
              placeholder={t("memory.pinPh")}
              value={pinDraft}
              onChange={(e) => setPinDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  void add(pinDraft, true);
                }
              }}
            />
            <button
              className="small"
              onClick={() => void add(pinDraft, true)}
              disabled={!pinDraft.trim()}
            >
              {t("memory.pinAdd")}
            </button>
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
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="col-grow">
          {loadFailed && <p className="muted">{t("memory.loadFailed")}</p>}
          {!loadFailed && shown.length === 0 && (
            <p className="muted">{t("memory.empty")}</p>
          )}

          {shown.map((m) => (
            <div className="mem-item" key={m.id}>
              {editRow(m)}
            </div>
          ))}
        </div>
        <div className="col-foot">
          <div className="row">
            <input
              className="mem-search"
              placeholder={t("memory.addPh")}
              value={addDraft}
              onChange={(e) => setAddDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  void add(addDraft, false);
                }
              }}
            />
            <button
              className="small"
              onClick={() => void add(addDraft, false)}
              disabled={!addDraft.trim()}
            >
              {t("memory.add")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
