// 记忆面板（设置页 tab）：用户身份（称呼/关系/画像，受控草稿）+
// 长期记忆列表（kind 过滤、检索、编辑、删除；可展开失效审计）。
// 用户身份走设置页统一草稿；记忆条目级编辑/删除是即时操作（同游戏存档管理）。

import { useMemo, useState, useSyncExternalStore } from "react";
import { getMemories, subscribe } from "../lib/store";
import type { Memory, MemoryKind, UserProfile } from "../lib/types";
import { MEMORY_KINDS } from "../lib/types";
import {
  deleteMemory,
  editMemory,
  listMemories,
  searchMemories,
} from "../memory/store";
import { useT, currentLang } from "../i18n";
import "../styles/persona.css";
import "../styles/controls.css";

type KindFilter = MemoryKind | "all";

const KIND_FILTERS: readonly KindFilter[] = ["all", ...MEMORY_KINDS];

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
  user,
  onUser,
}: {
  user: UserProfile;
  onUser: (u: UserProfile) => void;
}) {
  const t = useT();
  const memories = useSyncExternalStore(subscribe, getMemories);

  // ---- 记忆列表状态 ----
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [showInvalid, setShowInvalid] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const shown = useMemo<Memory[]>(() => {
    const q = query.trim();
    let list: Memory[];
    if (q) {
      // valid 条目走打分检索；失效条目只做子串命中（审计用）
      const lower = q.toLowerCase();
      const hits = searchMemories(q);
      const extras = listMemories(true).filter(
        (m) => !m.valid && m.content.toLowerCase().includes(lower),
      );
      list = [...hits, ...extras];
    } else {
      list = listMemories(true);
    }
    if (!showInvalid) list = list.filter((m) => m.valid);
    if (kindFilter !== "all") list = list.filter((m) => m.kind === kindFilter);
    return list;
  }, [memories, query, showInvalid, kindFilter]);

  const startEdit = (m: Memory): void => {
    setEditingId(m.id);
    setEditDraft(m.content);
  };

  const commitEdit = (): void => {
    if (editingId) editMemory(editingId, editDraft);
    setEditingId(null);
    setEditDraft("");
  };

  return (
    <div className="persona-tab">
      {/* 1. 用户身份：称呼/关系/补充画像 */}
      <section className="panel persona-section">
        <h2>{t("memory.userTitle")}</h2>
        <p className="muted">{t("memory.userDesc")}</p>
        <div className="fields-grid">
          <label className="field">
            <span className="field-label">{t("memory.userName")}</span>
            <input
              value={user.name}
              placeholder={t("memory.userNamePh")}
              onChange={(e) => onUser({ ...user, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">{t("memory.userRelation")}</span>
            <input
              value={user.relation}
              placeholder={t("memory.userRelationPh")}
              onChange={(e) => onUser({ ...user, relation: e.target.value })}
            />
          </label>
          <label className="field span2">
            <span className="field-label">{t("memory.userNote")}</span>
            <textarea
              rows={3}
              value={user.note}
              placeholder={t("memory.userNotePh")}
              onChange={(e) => onUser({ ...user, note: e.target.value })}
            />
          </label>
        </div>
      </section>

      {/* 2. 长期记忆 */}
      <section className="panel persona-section">
        <h2>{t("memory.ltTitle")}</h2>
        <div className="mem-toolbar">
          <div className="chips">
            {KIND_FILTERS.map((k) => (
              <button
                key={k}
                className={`chip${kindFilter === k ? " on" : ""}`}
                onClick={() => setKindFilter(k)}
              >
                {k === "all" ? t("memory.filterAll") : k}
              </button>
            ))}
          </div>
          <input
            className="mem-search"
            placeholder={t("memory.searchPh")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="show-invalid">
            <input
              type="checkbox"
              className="ckbox"
              checked={showInvalid}
              onChange={(e) => setShowInvalid(e.target.checked)}
            />
            {t("memory.showInvalid")}
          </label>
        </div>

        {shown.length === 0 && <p className="muted">{t("memory.empty")}</p>}

        {shown.map((m) => (
          <div className={`mem-item${m.valid ? "" : " invalid"}`} key={m.id}>
            {editingId === m.id ? (
              <div className="mem-edit">
                <textarea
                  rows={3}
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                />
                <div className="row">
                  <button className="small" onClick={commitEdit}>
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
                  <span className={`badge kind-${m.kind}`}>{m.kind}</span>
                  {!m.valid && (
                    <span className="badge badge-invalid">
                      {t("memory.invalidated")}
                    </span>
                  )}
                  <span className="muted">
                    {t("memory.source")}：{m.source}
                  </span>
                  <span className="muted">{formatTime(m.createdAt)}</span>
                </div>
                <div className="mem-content">{m.content}</div>
                {m.supersededBy && (
                  <div className="muted superseded">→ {m.supersededBy}</div>
                )}
                {m.valid && (
                  <div className="mem-ops">
                    <button className="ghost small" onClick={() => startEdit(m)}>
                      {t("common.edit")}
                    </button>
                    <button
                      className="ghost small danger"
                      onClick={() => {
                        if (window.confirm(t("memory.confirmDelete"))) {
                          deleteMemory(m.id);
                        }
                      }}
                    >
                      {t("common.del")}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
