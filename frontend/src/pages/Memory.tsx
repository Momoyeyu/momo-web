// 记忆面板（设置页 tab）：初始记忆（pin，受控草稿）+
// 普通记忆列表（backend /api/memories REST，检索/手动加/编辑/删除）。
// pin 走设置页统一草稿保存；普通记忆条目级操作直达 backend（同游戏存档管理）。

import { useEffect, useMemo, useState } from "react";
import type { Memory } from "../lib/types";
import { useT, currentLang } from "../i18n";
import "../styles/persona.css";
import "../styles/controls.css";

const API = "/api/memories";

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

export default function MemoryPanel({
  pins,
  onPins,
}: {
  pins: string[];
  onPins: (pins: string[]) => void;
}) {
  const t = useT();

  // ---- 普通记忆（backend REST）----
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [addDraft, setAddDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const refresh = async (): Promise<void> => {
    try {
      const res = await fetch(API);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMemories((await res.json()) as Memory[]);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const shown = useMemo<Memory[]>(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? memories.filter((m) => m.content.toLowerCase().includes(q))
      : memories;
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [memories, query]);

  const addMemory = async (): Promise<void> => {
    const content = addDraft.trim();
    if (!content) return;
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAddDraft("");
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
      const res = await fetch(`${API}/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: editDraft.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch {
      setLoadFailed(true);
    }
  };

  const removeMemory = async (id: string): Promise<void> => {
    try {
      const res = await fetch(`${API}/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch {
      setLoadFailed(true);
    }
  };

  return (
    <div className="persona-tab">
      {/* 1. 初始记忆（pin）：常驻事实，保存后进 system prompt 的「初始记忆」段 */}
      <section className="panel persona-section">
        <h2>{t("memory.pinsTitle")}</h2>
        <p className="muted">{t("memory.pinsDesc")}</p>
        <div className="field">
          {pins.map((p, i) => (
            <div className="pin-row" key={i}>
              <input
                value={p}
                placeholder={t("memory.pinPh")}
                onChange={(e) =>
                  onPins(pins.map((x, j) => (j === i ? e.target.value : x)))
                }
              />
              <button
                className="ghost small"
                onClick={() => onPins(pins.filter((_, j) => j !== i))}
              >
                {t("common.del")}
              </button>
            </div>
          ))}
          <button
            className="ghost small"
            onClick={() => onPins([...pins, ""])}
          >
            {t("memory.pinAdd")}
          </button>
        </div>
      </section>

      {/* 2. 普通记忆：agent 工具写入 + 手动维护，数据在 backend */}
      <section className="panel persona-section">
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
        <div className="row">
          <input
            className="mem-search"
            placeholder={t("memory.addPh")}
            value={addDraft}
            onChange={(e) => setAddDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                void addMemory();
              }
            }}
          />
          <button
            className="small"
            onClick={() => void addMemory()}
            disabled={!addDraft.trim()}
          >
            {t("memory.add")}
          </button>
        </div>

        {loadFailed && <p className="muted">{t("memory.loadFailed")}</p>}
        {!loadFailed && shown.length === 0 && (
          <p className="muted">{t("memory.empty")}</p>
        )}

        {shown.map((m) => (
          <div className="mem-item" key={m.id}>
            {editingId === m.id ? (
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
                        void removeMemory(m.id);
                      }
                    }}
                  >
                    {t("common.del")}
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
