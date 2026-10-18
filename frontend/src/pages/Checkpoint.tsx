// 存档槽位页（#/checkpoint）：视觉小说式 3×4 槽位网格 × 10 页横排滑轨，存档/读档双模式。
// 保存 = 快照当前会话（backend momo.db live 行）；读取 = 存档覆盖当前会话并回对话页。
// auto 槽是 load 前的自动备份（不占 120 手动槽位），固定置顶、不随滑轨翻页、只可读。
// 模式由入口决定（标题菜单「读档」/对话工具条的「存档」「读档」），页内不可切换；
// 返回键按来源页回退。
// 背景：与标题/设置同标尺的旋转网格（GridBackdrop），RoPE 节奏——
//   Save 与 Load 沿 0° 镜像对称：save 页 k 在 +18°+36k，load 页 k 在 -18°+36k，
//   每次翻页（或切模式）恰好转 36°，十页恰好扫满一整圈；
//   翻页支持拖拽跟手（网格角度随拖动实时等比偏转），松手吸附。

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { CheckpointMeta } from "../lib/types";
import {
  createCheckpoint,
  deleteCheckpoint,
  listCheckpoints,
  loadCheckpoint,
  overwriteCheckpoint,
} from "../services/checkpointClient";
import { resyncPassthrough } from "../lib/store";
import {
  getChatEngine,
  loadTranscript,
  subscribeTranscript,
  transcriptVersion,
} from "../chat/engineInstance";
import {
  navigate,
  fromRoute,
  checkpointEntryMode,
  type CheckpointMode,
} from "../router";
import {
  buildCells,
  MAX_PAGES,
  type SlotCell,
} from "../lib/checkpointGrid";
import { useT, currentLang } from "../i18n";
import Button from "../ui/Button";
import IconButton from "../ui/IconButton";
import Pager from "../ui/Pager";
import PageHeader from "../ui/PageHeader";
import Confirm from "../ui/Confirm";
import GridBackdrop, { type GridBackdropApi } from "../components/GridBackdrop";
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

// RoPE 角度：Save/Load 沿 0° 镜像对称，每页 ±36°（10 页满圈）
const PAGE_STEP = 36;
const MODE_HALF = 18;
const pageAngle = (mode: CheckpointMode, page: number): number =>
  (mode === "save" ? 1 : -1) * MODE_HALF + page * PAGE_STEP;
const DRAG_FLIP = 0.22; // 拖过 22% 宽即翻页

/** 待确认的破坏性操作（覆盖 / 读取 / 删除），统一走 ui/Confirm。 */
type Pending =
  | { kind: "overwrite"; save: CheckpointMeta }
  | { kind: "load"; save: CheckpointMeta }
  | { kind: "delete"; save: CheckpointMeta };

/** 确认文案（标题 / 说明 / 确认键）按操作类型取，键在 i18n 三语里同形。 */
const CONFIRM_COPY = {
  overwrite: {
    title: "checkpoint.overwriteTitle",
    message: "checkpoint.confirmOverwrite",
    action: "checkpoint.overwriteAction",
    danger: false,
  },
  load: {
    title: "checkpoint.loadTitle",
    message: "checkpoint.confirmLoad",
    action: "checkpoint.loadAction",
    danger: false,
  },
  delete: {
    title: "checkpoint.deleteTitle",
    message: "checkpoint.confirmDelete",
    action: "common.del",
    danger: true,
  },
} as const;

export default function Checkpoint() {
  const t = useT();
  // 模式由进入入口决定（checkpointEntryMode 通道），页内不提供切换。
  const [mode] = useState<CheckpointMode>(checkpointEntryMode());
  const [slots, setSlots] = useState<CheckpointMeta[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  // 拖拽状态：null = 静止（走 CSS 过渡）；数字 = 跟手偏移 px
  const [dragDx, setDragDx] = useState<number | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const backdropRef = useRef<GridBackdropApi | null>(null);
  const dragRef = useRef<{ x0: number; moved: boolean } | null>(null);
  const suppressRef = useRef(false); // 拖过阈值后吞掉紧随的 click
  // 引擎状态变化（回合开始/结束）时重渲染，驱动「回合中禁存档」。
  useSyncExternalStore(subscribeTranscript, transcriptVersion);
  // 「回合中」口径与对话页工具条一致：仅 thinking/speaking，listening 不算。
  const turnActive =
    getChatEngine().status === "thinking" ||
    getChatEngine().status === "speaking";
  // 存档模式：回合进行中禁保存（快照会截到半条回复）。
  const saveBlocked = mode === "save" && turnActive;

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
  const pages = MAX_PAGES; // 槽位固定 120 个 → 恒 10 页
  const angle = pageAngle(mode, page);
  // 每页方向：save 向右翻 = 顺时针；load 镜像 = 逆时针
  const dir = mode === "save" ? 1 : -1;

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
  const doOverwrite = async (s: CheckpointMeta): Promise<void> => {
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
  const doLoad = async (s: CheckpointMeta): Promise<void> => {
    setBusy(true);
    try {
      const save = await loadCheckpoint(s.id);
      await resyncPassthrough(); // 掐掉在途防抖写并重拉 passthrough
      loadTranscript(save.messages ?? []);
      navigate("chat");
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  /** 已占槽卡片删除钮（两种模式都有）：确认后释放槽位。 */
  const doDelete = async (s: CheckpointMeta): Promise<void> => {
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

  /** 确认弹窗的待办：三种破坏性操作统一走自定义确认 UI（不用原生 confirm）。 */
  const confirmPending = (): void => {
    const p = pending;
    if (!p) return;
    setPending(null);
    if (p.kind === "overwrite") void doOverwrite(p.save);
    else if (p.kind === "load") void doLoad(p.save);
    else void doDelete(p.save);
  };

  const openCell = (c: SlotCell): void => {
    if (busy || saveBlocked) return;
    if (mode === "save") {
      if (c.save) setPending({ kind: "overwrite", save: c.save });
      else void saveTo(c.slot);
    } else if (c.save) {
      setPending({ kind: "load", save: c.save });
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

  // —— 滑轨拖拽：跟手横移 + 网格角度等比实时偏转；松手吸附/翻页 ——
  const onDragStart = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || busy) return;
    dragRef.current = { x0: e.clientX, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onDragMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (!d) return;
    const w = e.currentTarget.clientWidth || 1;
    let progress = -(e.clientX - d.x0) / w; // 向左拖（下一页）为正
    if (!d.moved && Math.abs(e.clientX - d.x0) > 6) d.moved = true;
    // 边界橡皮筋：第一页向右 / 末页向左，只给四分之一行程
    if ((page === 0 && progress < 0) || (page === pages - 1 && progress > 0)) {
      progress *= 0.25;
    }
    setDragDx(-progress * w);
    // 网格角度跟手：页进度 → RoPE 角度（clamp 在 10 页范围内）
    const fp = Math.max(0, Math.min(pages - 1, page + dir * progress));
    backdropRef.current?.setAngle(
      (mode === "save" ? 1 : -1) * MODE_HALF + fp * PAGE_STEP,
    );
  };

  const onDragEnd = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    if (d.moved) suppressRef.current = true; // 拖过 → 吞掉紧随的 click
    const w = e.currentTarget.clientWidth || 1;
    const progress = -(e.clientX - d.x0) / w;
    const next =
      progress > DRAG_FLIP && page < pages - 1
        ? page + 1
        : progress < -DRAG_FLIP && page > 0
          ? page - 1
          : page;
    setDragDx(null);
    if (next !== page) {
      setPage(next); // prop 变化 → GridBackdrop 从拖拽角缓动到目标角
    } else {
      backdropRef.current?.rotate(angle); // 未翻页：网格也弹回原角
    }
  };

  const onClickCapture = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (suppressRef.current) {
      suppressRef.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <div className="checkpoint-page">
      <GridBackdrop angle={angle} contrast={1.7} api={backdropRef} />
      <div className={`checkpoint-panel checkpoint-${mode}`}>
        <PageHeader
          className="checkpoint-head"
          title={t(`checkpoint.${mode}`)}
          actions={
            <Button variant="ghost" onClick={back}>
              {t(fromRoute() === "chat" ? "common.backChat" : "common.backTitle")}
            </Button>
          }
        />

        <div className="checkpoint-body">
          {failed && (
            <div className="muted checkpoint-empty">{t("checkpoint.loadFailed")}</div>
          )}
          {saveBlocked && (
            <div className="muted checkpoint-empty">
              {t("checkpoint.busySave")}
            </div>
          )}

          {/* AUTO 自动存档槽：置顶、独立于滑轨、只读不写 */}
          {auto && (
            <div
              className={`slot-card slot-auto${
                mode === "load" && !busy ? " slot-clickable" : ""
              }`}
              onClick={() => {
                if (mode === "load" && !busy) setPending({ kind: "load", save: auto });
              }}
            >
              <span className="slot-badge">{t("checkpoint.autoBadge")}</span>
              {cardBody(auto, "")}
            </div>
          )}

          {/* 滑轨：10 页横排，translateX 翻页；拖拽跟手、松手吸附 */}
          <div
            className="checkpoint-track-wrap"
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            onClickCapture={onClickCapture}
          >
            <div
              className={`checkpoint-track${dragDx === null ? "" : " dragging"}`}
              style={{
                transform:
                  dragDx === null
                    ? `translateX(${-page * 100}%)`
                    : `translateX(calc(${-page * 100}% + ${dragDx}px))`,
              }}
            >
              {Array.from({ length: pages }, (_, p) => (
                <div key={p} className="checkpoint-track-page">
                  <div className="checkpoint-grid">
                    {buildCells(manual, p).map((c) =>
                      c.save ? (
                        <div
                          key={c.slot}
                          className={`slot-card slot-filled${
                            !busy && !saveBlocked ? " slot-clickable" : ""
                          }`}
                          onClick={() => openCell(c)}
                        >
                          {cardBody(c.save, slotNo(c.slot))}
                          <IconButton
                            icon="trash"
                            size="sm"
                            danger
                            className="slot-del"
                            label={t("common.del")}
                            tip={t("common.del")}
                            disabled={busy || saveBlocked}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (c.save) setPending({ kind: "delete", save: c.save });
                            }}
                          />
                        </div>
                      ) : (
                        <div
                          key={c.slot}
                          className={`slot-card slot-empty${
                            mode === "save" && !busy && !saveBlocked
                              ? " slot-clickable"
                              : ""
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
                </div>
              ))}
            </div>
          </div>

          <footer className="checkpoint-pager">
            <Pager page={page} pages={pages} onChange={setPage} />
          </footer>
        </div>
      </div>

      {/* 破坏性操作的确认弹窗（自定义 UI，替代原生 confirm） */}
      {pending && (
        <Confirm
          title={t(CONFIRM_COPY[pending.kind].title)}
          message={t(CONFIRM_COPY[pending.kind].message, {
            title: pending.save.title,
          })}
          confirmLabel={t(CONFIRM_COPY[pending.kind].action)}
          danger={CONFIRM_COPY[pending.kind].danger}
          busy={busy}
          onConfirm={confirmPending}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
