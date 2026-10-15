// 存档槽位页（#/sessions）：视觉小说式 Save/Load。
// 保存 = 快照当前会话（backend state.json）；读取 = 存档覆盖当前会话并回对话页。
// auto 槽是 load 前的自动备份（不占手动槽位），只可读不可写删。
// 从 chat 还是 title 进来行为一致；返回键按来源页回退。

import { useEffect, useState } from "react";
import type { SessionMeta } from "../lib/types";
import {
  createSession,
  deleteSession,
  listSessions,
  loadSession,
  overwriteSession,
} from "../services/sessionClient";
import { resyncPassthrough } from "../lib/store";
import { loadTranscript } from "../chat/engine";
import { navigate, fromRoute } from "../router";
import { useT, currentLang } from "../i18n";
import "../styles/sessions.css";
import "../styles/persona.css";

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

/** 默认存档名 = 本地时间（与 backend 默认一致）。 */
function defaultTitle(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function Sessions() {
  const t = useT();
  const [slots, setSlots] = useState<SessionMeta[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const refresh = async (): Promise<void> => {
    try {
      setSlots(await listSessions());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const back = (): void =>
    navigate(fromRoute() === "chat" ? "chat" : "title");

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await createSession(draft.trim() || defaultTitle());
      setDraft("");
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  /** 读取：存档覆盖当前会话 → 同步 passthrough → 灌引擎 → 回对话页。 */
  const load = async (s: SessionMeta): Promise<void> => {
    if (!window.confirm(t("sessions.confirmLoad", { title: s.title }))) return;
    setBusy(true);
    try {
      const save = await loadSession(s.id);
      await resyncPassthrough(); // 旧 history 不得随下次 PUT 盖回
      loadTranscript(save.messages ?? []);
      navigate("chat");
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  const overwrite = async (s: SessionMeta): Promise<void> => {
    if (!window.confirm(t("sessions.confirmOverwrite", { title: s.title }))) {
      return;
    }
    setBusy(true);
    try {
      await overwriteSession(s.id);
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const commitRename = async (s: SessionMeta): Promise<void> => {
    const title = renameDraft.trim();
    setRenaming(null);
    setRenameDraft("");
    if (!title || title === s.title) return;
    setBusy(true);
    try {
      await overwriteSession(s.id, title); // PUT：重命名 + 内容随当前会话刷新
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: SessionMeta): Promise<void> => {
    if (!window.confirm(t("sessions.confirmDelete", { title: s.title }))) {
      return;
    }
    setBusy(true);
    try {
      await deleteSession(s.id);
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const sorted = [...slots].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );

  return (
    <div className="sessions-page">
      <div className="sessions-panel">
        <header className="sessions-head">
          <h1>{t("sessions.title")}</h1>
          <button className="ghost" onClick={back}>
            {t(fromRoute() === "chat" ? "common.backChat" : "common.backTitle")}
          </button>
        </header>

        {/* 新建存档：命名输入（留空 = 当前时间），快照当前会话 */}
        <div className="sessions-new">
          <input
            value={draft}
            placeholder={t("sessions.namePh")}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void save();
            }}
          />
          <button onClick={() => void save()} disabled={busy}>
            {t("sessions.newSave")}
          </button>
        </div>

        <div className="sessions-list">
          {failed && (
            <div className="muted sessions-empty">{t("sessions.loadFailed")}</div>
          )}
          {!failed && sorted.length === 0 && (
            <div className="muted sessions-empty">{t("sessions.empty")}</div>
          )}
          {sorted.map((s) => (
            <div key={s.id} className={`slot${s.auto ? " slot-auto" : ""}`}>
              <div className="slot-main">
                {renaming === s.id ? (
                  <div className="slot-rename">
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                          void commitRename(s);
                        }
                        if (e.key === "Escape") setRenaming(null);
                      }}
                    />
                    <button
                      className="ghost small"
                      onClick={() => void commitRename(s)}
                    >
                      {t("common.save")}
                    </button>
                    <button
                      className="ghost small"
                      onClick={() => setRenaming(null)}
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                ) : (
                  <div className="slot-title">
                    {s.auto && (
                      <span className="slot-badge">{t("sessions.auto")}</span>
                    )}
                    {s.title}
                  </div>
                )}
                <div className="slot-meta muted">{formatTime(s.updatedAt)}</div>
                <div className="slot-preview">{s.preview || "…"}</div>
              </div>
              <div className="slot-ops">
                <button
                  className="ghost small"
                  disabled={busy}
                  onClick={() => void load(s)}
                >
                  {t("sessions.load")}
                </button>
                {!s.auto && (
                  <>
                    <button
                      className="ghost small"
                      disabled={busy}
                      onClick={() => void overwrite(s)}
                    >
                      {t("sessions.overwrite")}
                    </button>
                    <button
                      className="ghost small"
                      disabled={busy}
                      onClick={() => {
                        setRenaming(s.id);
                        setRenameDraft(s.title);
                      }}
                    >
                      {t("sessions.rename")}
                    </button>
                    <button
                      className="ghost small danger"
                      disabled={busy}
                      onClick={() => void remove(s)}
                    >
                      {t("common.del")}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
