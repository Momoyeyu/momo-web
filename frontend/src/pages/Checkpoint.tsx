// 存档槽位页（#/checkpoint）：视觉小说式 3×4 槽位网格，存档/读档双模式。
// 保存 = 快照当前会话（backend state.json）；读取 = 存档覆盖当前会话并回对话页。
// auto 槽是 load 前的自动备份（不占 120 手动槽位），固定置顶网格上方、只可读。
// 模式由入口决定（标题菜单/对话工具条的「存档」「读档」），页内亦可切换；
// 返回键按来源页回退。

import { useEffect, useState, type ReactNode } from "react";
import type { CheckpointMeta } from "../lib/types";
import {
  createCheckpoint,
  deleteCheckpoint,
  listCheckpoints,
  loadCheckpoint,
  overwriteCheckpoint,
} from "../services/checkpointClient";
import { resyncPassthrough } from "../lib/store";
import { loadTranscript } from "../chat/engine";
import {
  navigate,
  fromRoute,
  checkpointEntryMode,
  type CheckpointMode,
} from "../router";
import {
  MAX_PAGES,
  buildCells,
  pageCount,
  type SlotCell,
} from "../lib/checkpointGrid";
import { useT, currentLang } from "../i18n";
import "../styles/checkpoint.css";
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

const slotNo = (n: number): string => `No.${String(n).padStart(3, "0")}`;

export default function Checkpoint() {
  const t = useT();
  const [mode, setMode] = useState<CheckpointMode>(checkpointEntryMode());
  const [slots, setSlots] = useState<CheckpointMeta[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pageIdx, setPageIdx] = useState(0);

  const refresh = async (): Promise<void> => {
    try {
      setSlots(await listCheckpoints());
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

  const auto = slots.find((s) => s.auto) ?? null;
  const manual = slots.filter((s) => !s.auto);
  const pages = pageCount(manual, mode);
  const page = Math.min(pageIdx, pages - 1);
  const cells = buildCells(manual, page);

  /** 存档模式点空槽：快照写入该槽。 */
  const saveTo = async (slot: number): Promise<void> => {
    setBusy(true);
    try {
      await createCheckpoint(undefined, slot);
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  /** 存档模式点已占槽：确认后覆盖。 */
  const overwrite = async (s: CheckpointMeta): Promise<void> => {
    if (!window.confirm(t("checkpoint.confirmOverwrite", { title: s.title }))) {
      return;
    }
    setBusy(true);
    try {
      await overwriteCheckpoint(s.id);
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  /** 读档模式点已占槽（含 auto）：确认 → 覆盖当前会话 → 灌引擎 → 回对话页。 */
  const load = async (s: CheckpointMeta): Promise<void> => {
    if (!window.confirm(t("checkpoint.confirmLoad", { title: s.title }))) return;
    setBusy(true);
    try {
      const save = await loadCheckpoint(s.id);
      await resyncPassthrough(); // 旧 history 不得随下次 PUT 盖回
      loadTranscript(save.messages ?? []);
      navigate("chat");
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  /** 读档模式卡片删除钮：确认后释放槽位。 */
  const remove = async (s: CheckpointMeta): Promise<void> => {
    if (!window.confirm(t("checkpoint.confirmDelete", { title: s.title }))) {
      return;
    }
    setBusy(true);
    try {
      await deleteCheckpoint(s.id);
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const openCell = (c: SlotCell): void => {
    if (busy) return;
    if (mode === "save") {
      void (c.save ? overwrite(c.save) : saveTo(c.slot));
    } else if (c.save) {
      void load(c.save);
    }
  };

  /** 已占槽卡片体：槽位号 + 时间 + 末句预览（网格卡与 auto 卡共用）。 */
  const cardBody = (s: CheckpointMeta, no: string): ReactNode => (
    <>
      <div className="slot-card-top">
        <span className="slot-no">{no}</span>
        <span className="slot-time muted">{formatTime(s.updatedAt)}</span>
      </div>
      <div className="slot-preview">{s.preview || "…"}</div>
    </>
  );

  return (
    <div className="checkpoint-page">
      <div className={`checkpoint-panel checkpoint-${mode}`}>
        <header className="checkpoint-head">
          <h1>{t(`checkpoint.${mode}`)}</h1>
          <div className="checkpoint-mode" role="tablist">
            <button
              className={`seg${mode === "save" ? " seg-on" : ""}`}
              onClick={() => setMode("save")}
            >
              {t("checkpoint.save")}
            </button>
            <button
              className={`seg${mode === "load" ? " seg-on" : ""}`}
              onClick={() => setMode("load")}
            >
              {t("checkpoint.load")}
            </button>
          </div>
          <button className="ghost" onClick={back}>
            {t(fromRoute() === "chat" ? "common.backChat" : "common.backTitle")}
          </button>
        </header>

        <div className="checkpoint-body">
          {failed && (
            <div className="muted checkpoint-empty">{t("checkpoint.loadFailed")}</div>
          )}

          {/* AUTO 自动存档槽：置顶于网格上方、独立于分页，只读不写 */}
          {auto && (
            <div
              className={`slot-card slot-auto${
                mode === "load" && !busy ? " slot-clickable" : ""
              }`}
              onClick={() => {
                if (mode === "load" && !busy) void load(auto);
              }}
            >
              <span className="slot-badge">{t("checkpoint.autoBadge")}</span>
              {cardBody(auto, "")}
            </div>
          )}

          <div className="checkpoint-grid">
            {cells.map((c) =>
              c.save ? (
                <div
                  key={c.slot}
                  className={`slot-card slot-filled${
                    !busy ? " slot-clickable" : ""
                  }`}
                  onClick={() => openCell(c)}
                >
                  {cardBody(c.save, slotNo(c.slot))}
                  {mode === "load" && (
                    <button
                      className="ghost small danger slot-del"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (c.save) void remove(c.save);
                      }}
                    >
                      {t("common.del")}
                    </button>
                  )}
                </div>
              ) : (
                <div
                  key={c.slot}
                  className={`slot-card slot-empty${
                    mode === "save" && !busy ? " slot-clickable" : ""
                  }`}
                  onClick={() => openCell(c)}
                >
                  <div className="slot-card-top">
                    <span className="slot-no">{slotNo(c.slot)}</span>
                  </div>
                  <div className="slot-empty-hint muted">
                    {t("checkpoint.emptySlot")}
                  </div>
                </div>
              ),
            )}
          </div>

          <footer className="checkpoint-pager">
            <button
              className="ghost small"
              disabled={page === 0}
              onClick={() => setPageIdx(page - 1)}
            >
              ‹
            </button>
            <span className="muted">
              {t("checkpoint.pageOf", {
                cur: String(page + 1),
                total: String(pages),
              })}
            </span>
            <button
              className="ghost small"
              disabled={page >= pages - 1 || page >= MAX_PAGES - 1}
              onClick={() => setPageIdx(page + 1)}
            >
              ›
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
