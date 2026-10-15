// Backlog 回顾子页：视觉小说式历史回放 overlay。
// 读 ChatEngine.history（应用级单例），离开/返回不影响在途回合。
// assistant 条目支持语音重播：按文本+当时情绪 tag 实时走 TTS 合成，
// 不存历史音频；回合进行中（引擎非空闲）禁用。

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  getChatEngine,
  subscribeTranscript,
  transcriptVersion,
} from "../chat/engine";
import { getState, personaName, subscribe } from "../lib/store";
import { navigate } from "../router";
import { useT } from "../i18n";
import "../styles/backlog.css";

export default function Backlog() {
  const t = useT();
  // 回放期间若有新消息落账/状态变化，刷新列表；store 订阅用于语言/角色名热更。
  useSyncExternalStore(subscribeTranscript, transcriptVersion);
  useSyncExternalStore(subscribe, getState);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [replaying, setReplaying] = useState<string | null>(null);
  const engine = getChatEngine();
  const messages = engine.history;
  const name = personaName();
  const idle = engine.status === "idle";
  // 回放可见反馈：TTS 未配置 / 语音静音时置灰 + tooltip 说明（点了也没声）。
  const ttsConfigured = getState().settings.tts.url.trim() !== "";
  const muted = engine.muted;

  // 打开即滚到底部看最新一条。
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const replay = (id: string): void => {
    const m = messages.find((x) => x.id === id);
    if (!m || !idle) return;
    setReplaying(id);
    void engine.replayMessage(m).finally(() => setReplaying(null));
  };

  return (
    <div className="backlog-page">
      <div className="backlog-panel">
        <header className="backlog-head">
          <h1>{t("backlog.title")}</h1>
          <button className="ghost" onClick={() => navigate("chat")}>
            {t("common.backChat")}
          </button>
        </header>

        <div className="backlog-list" ref={listRef}>
          {messages.length === 0 && (
            <div className="muted backlog-empty">{t("backlog.empty")}</div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`bl-item ${m.role}`}>
              <div className="bl-name">
                {m.role === "user" ? t("chat.you") : name}
                {m.role === "assistant" && (
                  <button
                    className="bl-replay"
                    disabled={!idle || replaying !== null || !ttsConfigured || muted}
                    title={
                      !ttsConfigured
                        ? t("backlog.replayNeedTts")
                        : muted
                          ? t("backlog.replayMuted")
                          : undefined
                    }
                    onClick={() => replay(m.id)}
                  >
                    {replaying === m.id ? "…" : `♪ ${t("backlog.replay")}`}
                  </button>
                )}
              </div>
              <div className="bl-text">{m.text}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
