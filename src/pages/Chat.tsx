// 对话页：VN 式对话框（铭牌 + 字幕 + 输入 + 快捷栏）。
// 历史不在本页展示，走 backlog 子页（#/backlog）。
// 引擎是应用级单例：离开本页回合不中断，回来即恢复显示。

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  attachEngine,
  detachEngine,
  getChatEngine,
  subscribeTranscript,
  transcriptVersion,
} from "../chat/engine";
import type { EngineHandlers } from "../chat/engine";
import type { ChatStatus } from "../lib/types";
import { navigate } from "../router";
import { useT } from "../i18n";
import { getState, personaName, subscribe } from "../lib/store";
import "../styles/chat.css";

const STATUS_LABEL_KEYS: Record<ChatStatus, string> = {
  idle: "chat.idle",
  listening: "chat.listening",
  thinking: "chat.thinking",
  speaking: "chat.speaking",
};

export default function Chat() {
  const t = useT();
  // 角色名/通用设置跟随 store（切换语言、改名、状态开关即时生效）。
  useSyncExternalStore(subscribe, getState);
  const name = personaName();
  const showStatus = getState().settings.general.showStatus;
  const [status, setStatus] = useState<ChatStatus>(getChatEngine().status);
  const [micOn, setMicOn] = useState(getChatEngine().listening);
  const [muted, setMuted] = useState(getChatEngine().muted);
  const [streamActive, setStreamActive] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const errTimer = useRef<number | null>(null);
  // 引擎侧消息变化（含跨页产生的新消息）时刷新本页引用。
  useSyncExternalStore(subscribeTranscript, transcriptVersion);

  useEffect(() => {
    const engine = getChatEngine();
    const showErr = (msg: string): void => {
      setError(msg);
      if (errTimer.current !== null) window.clearTimeout(errTimer.current);
      errTimer.current = window.setTimeout(() => setError(null), 3000);
    };
    const h: EngineHandlers = {
      onStatus: (s) => {
        setStatus(s);
        setMicOn(engine.listening);
        // 回合结束/打断后清掉遗留的流式字幕（无 onAssistantDone 的空回合兜底）。
        if (s === "idle" || s === "listening") {
          setStreamActive(false);
          setStreamText("");
        }
      },
      onAssistantStart: () => {
        setStreamActive(true);
        setStreamText("");
      },
      onAssistantDelta: (_id, d) => setStreamText((t) => t + d),
      onAssistantDone: () => {
        setStreamActive(false);
        setStreamText("");
      },
      onError: (e) => showErr(e.message || t("chat.errDefault")),
    };
    attachEngine(h);
    // 挂载即同步当前相位（可能已有回合在跑）。
    setStatus(engine.status);
    setMicOn(engine.listening);
    return () => {
      detachEngine(h);
      if (errTimer.current !== null) window.clearTimeout(errTimer.current);
    };
  }, []);

  const send = (): void => {
    const text = input.trim();
    if (!text) return;
    getChatEngine().sendText(text);
    setInput("");
  };

  const toggleMic = (): void => {
    const eng = getChatEngine();
    if (eng.listening) {
      eng.stopListening();
      setMicOn(false);
    } else {
      setMicOn(true);
      void eng.startListening().then(() => setMicOn(eng.listening));
    }
  };

  const toggleVoice = (): void => {
    const eng = getChatEngine();
    eng.setMuted(!eng.muted);
    setMuted(eng.muted);
  };

  const lastAssistant = [...getChatEngine().history]
    .reverse()
    .find((m) => m.role === "assistant");
  const subtitle = streamActive
    ? streamText || "…"
    : (lastAssistant?.text ?? "");
  const busy = status === "thinking" || status === "speaking";

  return (
    <div className="chat-page">
      {showStatus && (
        <div className={`chat-status status-${status}`}>
          <span className="dot" />
          {t(STATUS_LABEL_KEYS[status])}
        </div>
      )}

      {error && <div className="chat-error">{error}</div>}

      <div className="dialog-zone">
        <div className="dialog-box">
          <div className="nameplate">{name}</div>

          <div className="subtitle">
            {subtitle || <span className="muted">……</span>}
          </div>

          <div className="input-row">
            <input
              value={input}
              placeholder={t("chat.placeholder", { name })}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) send();
              }}
            />
            <button onClick={send} disabled={!input.trim()}>
              {t("chat.send")}
            </button>
            <button
              className={micOn ? "mic-on" : "ghost"}
              onClick={toggleMic}
              title={micOn ? t("chat.micTitleOn") : t("chat.micTitleOff")}
            >
              {micOn ? t("chat.micOn") : t("chat.mic")}
            </button>
            {busy && (
              <button
                className="ghost"
                onClick={() => getChatEngine().interrupt()}
              >
                {t("chat.stop")}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 底部工具条：对照 VN 底部 icon 栏，操作聚拢右侧，返回标题收尾 */}
      <div className="chat-toolbar">
        <div className="tb-side">
          <button className="tb" onClick={() => navigate("backlog")}>
            {t("chat.backlog")}
          </button>
          <button
            className={`tb${muted ? " tb-off" : ""}`}
            onClick={toggleVoice}
            title={muted ? t("chat.voiceTitleOff") : t("chat.voiceTitleOn")}
          >
            {muted ? t("chat.voiceOff") : t("chat.voiceOn")}
          </button>
          <button className="tb" onClick={() => navigate("settings")}>
            {t("settings.title")}
          </button>
          <button className="tb" onClick={() => navigate("title")}>
            {t("common.backTitle")}
          </button>
        </div>
      </div>
    </div>
  );
}
