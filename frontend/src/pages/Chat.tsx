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
} from "../chat/engineInstance";
import type { EngineHandlers } from "../chat/engineInstance";
import type { ChatStatus } from "../lib/types";
import { navigate } from "../router";
import { saveAutoCheckpoint } from "../services/checkpointClient";
import { useT } from "../i18n";
import { ServiceError } from "../lib/errors";
import { getState, speakerName, subscribe } from "../lib/store";
import { asrConfigured, ttsConfigured } from "../lib/asr";
import Button from "../ui/Button";
import Icon from "../ui/Icon";
import DialogBox from "../components/DialogBox";
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
  const name = speakerName();
  const showStatus = getState().settings.general.showStatus;
  // 语音输入开关 + ASR 配置双重门控（与设置页「通用」同一个开关）。
  const micAllowed =
    getState().settings.general.voiceInput &&
    asrConfigured(getState().settings.asr);
  const ttsReady = ttsConfigured(getState().settings.tts);
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
    const showErr = (e: Error): void => {
      let msg = e.message || t("chat.errDefault");
      if (e instanceof ServiceError) {
        const detail =
          e.failure === "unconfigured"
            ? t("chat.errCfg")
            : e.failure === "unreachable"
              ? t("chat.errConn")
              : e.detail || `HTTP ${e.status}`;
        msg = t(`chat.errSvc.${e.service}`, { detail });
      }
      setError(msg);
      if (errTimer.current !== null) window.clearTimeout(errTimer.current);
      errTimer.current = window.setTimeout(() => setError(null), 3000);
    };
    const h: EngineHandlers = {
      onStatus: (s) => {
        setStatus(s);
        setMicOn(engine.listening);
        if (s === "idle" || s === "listening") setStreamActive(false);
      },
      onAssistantStart: () => {
        setStreamActive(true);
        setStreamText("");
      },
      onDisplay: (text) => setStreamText(text),
      // 回合结束字幕不清空：末句保持驻留（VN 惯例，完整回复在 backlog）。
      onAssistantDone: () => setStreamActive(false),
      onError: (e) => showErr(e),
    };
    attachEngine(h);
    // 回到 chat 页：恢复离开前挂起的麦克风监听。
    engine.resumeMic();
    // 挂载即同步当前相位与字幕（可能已有回合在跑）。
    setStatus(engine.status);
    setMicOn(engine.listening);
    setStreamActive(engine.status !== "idle");
    setStreamText(engine.display);
    return () => {
      detachEngine(h);
      // 离开 chat 页：暂停麦克风/ASR（避免在别的页面还在听）。
      engine.suspendMic();
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
    // 转写已是句级：末条 assistant 就是最后一句，切句全在 backend
    : streamText || (lastAssistant ? lastAssistant.text : "");
  const busy = status === "thinking" || status === "speaking";

  return (
    <div className="chat-page">
      {error && <div className="chat-error">{error}</div>}

      <div className="dialog-zone">
        <DialogBox
          name={name}
          text={subtitle || <span className="muted">……</span>}
          // 状态并进对话框（铭牌右侧），不再是页面左上角的浮标
          status={
            showStatus ? (
              <div className={`chat-status status-${status}`}>
                <span className="dot" />
                {t(STATUS_LABEL_KEYS[status])}
              </div>
            ) : undefined
          }
        >
          <div className="input-row">
            <input
              value={input}
              placeholder={t("chat.placeholder", { name })}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) send();
              }}
            />
            <Button
              variant={micOn ? "solid" : "ghost"}
              className={`mic-btn${micOn ? " mic-on" : ""}`}
              onClick={toggleMic}
              disabled={!micAllowed}
              aria-label={t("chat.mic")}
              title={
                !micAllowed
                  ? t("chat.micNeedCfg")
                  : micOn
                    ? t("chat.micTitleOn")
                    : t("chat.micTitleOff")
              }
            >
              <Icon name="mic" />
            </Button>
            <Button
              variant="solid"
              className="send-btn"
              onClick={send}
              disabled={!input.trim()}
              aria-label={t("chat.send")}
              title={t("chat.send")}
            >
              <Icon name="send" />
            </Button>
            {busy && (
              <Button
                variant="ghost"
                onClick={() => getChatEngine().interrupt()}
              >
                {t("chat.stop")}
              </Button>
            )}
          </div>
        </DialogBox>
      </div>

      {/* 底部工具条：对照 VN 底部 icon 栏，操作聚拢右侧，返回标题收尾 */}
      <div className="chat-toolbar">
        <div className="tb-side">
          <Button
            className="tb"
            aria-label={t("chat.backlog")}
            title={t("chat.backlog")}
            onClick={() => navigate("backlog")}
          >
            <Icon name="backlog" />
          </Button>
          <Button
            className="tb"
            disabled={busy}
            title={busy ? t("checkpoint.busySave") : t("checkpoint.save")}
            aria-label={t("checkpoint.save")}
            onClick={() => navigate("checkpoint", { checkpointMode: "save" })}
          >
            <Icon name="save" />
          </Button>
          <Button
            className="tb"
            aria-label={t("checkpoint.load")}
            title={t("checkpoint.load")}
            onClick={() => navigate("checkpoint", { checkpointMode: "load" })}
          >
            <Icon name="load" />
          </Button>
          <Button
            className={`tb${muted || !ttsReady ? " tb-off" : ""}`}
            onClick={toggleVoice}
            disabled={!ttsReady}
            aria-label={muted ? t("chat.voiceOff") : t("chat.voiceOn")}
            title={
              !ttsReady
                ? t("chat.voiceNeedCfg")
                : muted
                  ? t("chat.voiceTitleOff")
                  : t("chat.voiceTitleOn")
            }
          >
            <Icon name={muted ? "voiceOff" : "voice"} />
          </Button>
          <Button
            className="tb"
            aria-label={t("settings.title")}
            title={t("settings.title")}
            onClick={() => navigate("settings")}
          >
            <Icon name="gear" />
          </Button>
          <Button
            className="tb"
            aria-label={t("common.backTitle")}
            title={t("common.backTitle")}
            onClick={() => {
              // 退出对话 = 本段进度落 auto 槽（auto 唯一的写入时机）
              void saveAutoCheckpoint().catch(() => {});
              navigate("title");
            }}
          >
            <Icon name="home" />
          </Button>
        </div>
      </div>
    </div>
  );
}
