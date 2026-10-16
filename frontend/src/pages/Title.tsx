// 主页：纯色背景 + 左上品牌 + 右侧视觉小说式菜单（胶囊按钮、悬停饰标、错峰入场）。
// 菜单：开始（开新会话：live 快照进 auto 槽后清空）/ 继续（读最新档进对话页，
// 无存档置灰）/ 读档 / 设置。
// 存档入口只在对话页——标题页没有可保存的现场。

import { useEffect, useState } from "react";
import { navigate } from "../router";
import { useT } from "../i18n";
import {
  listCheckpoints,
  loadCheckpoint,
  newSession,
} from "../services/checkpointClient";
import { resyncPassthrough } from "../lib/store";
import { loadTranscript } from "../chat/engine";
import NebulaCanvas from "../components/NebulaCanvas";
import Button from "../ui/Button";
import type { CheckpointMeta } from "../lib/types";
import "../styles/title.css";

export default function Title() {
  const t = useT();
  const [saves, setSaves] = useState<CheckpointMeta[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listCheckpoints()
      .then(setSaves)
      .catch(() => setSaves([]));
  }, []);

  // 最新档：updatedAt 最大的槽（含 auto）——继续 = 回到最近一次现场。
  const latest =
    saves && saves.length
      ? saves.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b))
      : null;

  // 开始新会话：live 非空先由 backend 快照进 auto 槽，然后清空现场。
  const start = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await newSession();
      await resyncPassthrough();
      loadTranscript([]);
      navigate("chat");
    } catch {
      setBusy(false);
    }
  };

  const cont = async (): Promise<void> => {
    if (!latest || busy) return;
    setBusy(true);
    try {
      const save = await loadCheckpoint(latest.id);
      await resyncPassthrough(); // 掐掉在途防抖写并重拉 passthrough
      loadTranscript(save.messages ?? []);
      navigate("chat");
    } catch {
      setBusy(false);
    }
  };

  const items: {
    key: string;
    labelKey: string;
    hint: string;
    disabled?: boolean;
    onClick: () => void;
  }[] = [
    {
      key: "start",
      labelKey: "title.start",
      hint: "start",
      disabled: busy,
      onClick: () => void start(),
    },
    {
      key: "continue",
      labelKey: "title.continue",
      hint: "continue",
      disabled: !latest || busy,
      onClick: () => void cont(),
    },
    {
      key: "load",
      labelKey: "checkpoint.load",
      hint: "load",
      onClick: () => navigate("checkpoint", { checkpointMode: "load" }),
    },
    {
      key: "config",
      labelKey: "title.config",
      hint: "config",
      onClick: () => navigate("settings"),
    },
  ];

  return (
    <div className="title-screen">
      <NebulaCanvas />
      <header className="title-brand">
        <h1 className="title-logo">momo</h1>
        <div className="title-rule" />
        <p className="title-tagline">{t("title.tagline")}</p>
      </header>

      <nav className="title-menu">
        {items.map((m, i) => (
          <Button
            key={m.key}
            className="menu-item"
            style={{ animationDelay: `${0.12 + i * 0.08}s` }}
            disabled={m.disabled}
            onClick={m.onClick}
          >
            <span className="mi-orn" />
            <span className="mi-label">{t(m.labelKey)}</span>
            <span className="mi-hint">{m.hint}</span>
          </Button>
        ))}
      </nav>
    </div>
  );
}
