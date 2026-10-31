import DialogHandle from '../phone/DialogHandle';
import {useIntro} from "../services/introClient";
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
import { lastLocalAssistant } from "../chat/transcript";
import type { ChatStatus } from "../lib/types";
import { navigate } from "../router";
import { useT, resolveChatLang } from "../i18n";
import { getStage } from "../live2d/stage";
import { ServiceError } from "../lib/errors";
import { getState, speakerName, subscribe } from "../lib/store";
import { ttsConfigured } from "../lib/asr";
import Button from "../ui/Button";
import Icon from "../ui/Icon";
import PhoneSurface from "../components/PhoneSurface";
import FirstMeeting from "../components/FirstMeeting";
import DialogBox from "../components/DialogBox";
import "../styles/chat.css";
import {controlAttention,type AttentionState} from '../services/meetingClient';

const STATUS_LABEL_KEYS: Record<ChatStatus, string> = {
  idle: "chat.idle",
  listening: "chat.listening",
  thinking: "chat.thinking",
  speaking: "chat.speaking",
};

export default function Chat({active,attention}: {active: boolean;attention:AttentionState}) {
  const t = useT();
  const [phoneOpen,setPhoneOpen]=useState(false),[phoneClose,setPhoneClose]=useState(0);
  const intro=useIntro();
  const introActive=!!intro.data && intro.data.phase!=="completed";
  // 角色名/通用设置跟随 store（切换语言、改名、状态开关即时生效）。
  useSyncExternalStore(subscribe, getState);
  const name = speakerName();
  const showStatus = getState().settings.general.showStatus;
  // 内置语音输入与设置页「通用」共用同一个开关。
  const micAllowed =
    getState().settings.general.voiceInput;
  const ttsReady = ttsConfigured(getState().settings.tts);
  const [status, setStatus] = useState<ChatStatus>(getChatEngine().status);
  const [micOn, setMicOn] = useState(getChatEngine().listening);
  const [muted, setMuted] = useState(getChatEngine().muted);
  const [streamActive, setStreamActive] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState(false);
  const [input, setInput] = useState("");
  const [closeUp, setCloseUp] = useState(() => getStage().getCloseUp());
  const [controlling,setControlling]=useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);
  // Follow the actual CSS animation rather than a second, competing timer.
  // No animations (reduced motion) resolves immediately; cancelled entries
  // cannot unlock a newer page or start the first meeting behind its cover.
  useEffect(() => {
    setEntered(false);
    if (!active) return;
    let cancelled = false;
    const animations = dialog.current?.getAnimations() ?? [];
    void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      if (!cancelled) setEntered(true);
    });
    return () => { cancelled = true; };
  }, [active]);
  const interactive = active && entered;
  const errTimer = useRef<number | null>(null);
  // 引擎侧消息变化（含跨页产生的新消息）时刷新本页引用。
  useSyncExternalStore(subscribeTranscript, transcriptVersion);

  useEffect(() => {
    const engine = getChatEngine();
    const showErr = (e: Error): void => {
      let msg = e.message || t("chat.errDefault");
      if (e instanceof ServiceError) {
        if (e.service === "llm") setModelError(true);
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
    // 挂载即同步当前相位与字幕（可能已有回合在跑）。
    setStatus(engine.status);
    setMicOn(engine.listening);
    setStreamActive(engine.status !== "idle");
    setStreamText(engine.display);
    return () => {
      detachEngine(h);
      if (errTimer.current !== null) window.clearTimeout(errTimer.current);
    };
  }, []);

  useEffect(() => {
    const engine = getChatEngine();
    engine.setSceneActive(interactive);
    if(interactive&&!introActive)engine.resumeMic();
    return () => {engine.setSceneActive(false);engine.suspendMic();};
  }, [interactive,introActive]);

  const send = (): void => {
    const text = input.trim();
    if (!text) return;
    setModelError(false);
    getChatEngine().sendText(text);
    setInput("");
  };

  const toggleMic = (): void => {
    const eng = getChatEngine();
    if (eng.microphoneActive) {
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

  const lastAssistant = lastLocalAssistant(getChatEngine().history);
  const subtitle = streamActive
    ? streamText || "…"
    // 转写已是句级：末条 assistant 就是最后一句，切句全在 backend
    : streamText || (lastAssistant ? lastAssistant.text : "");
  const busy = status === "thinking" || status === "speaking";
  const phoneBusy=(attention.activity?.source==='qq'||attention.activity?.toolSource==='qq');
  const control=async(action:Parameters<typeof controlAttention>[0])=>{
    setControlling(true);
    try{if(action==='stop')getChatEngine().interrupt();await controlAttention(action);}
    catch{setError(t('attention.controlError'));}
    finally{setControlling(false);}
  };

  return (
    <div className={`chat-page${phoneOpen?' has-phone':''}`} inert={!interactive}>
      {interactive && <FirstMeeting connectionFailed={modelError} />}
      {error && <div className="chat-error">{error}</div>}

      {phoneOpen&&<DialogHandle onClick={()=>setPhoneClose(v=>v+1)}/>}
      <div className="dialog-zone" ref={dialog} inert={phoneOpen}>
        <DialogBox
          lang={resolveChatLang(getState().settings.general)}
          name={name}
          text={subtitle || <span className="muted">……</span>}
          // 状态并进对话框（铭牌右侧），不再是页面左上角的浮标
          status={
            phoneBusy ? <div className="chat-status chat-phone-status" role="status"><span className="phone-status-icon"><Icon name="phone" size={14}/></span>{t('attention.qq')}</div> : showStatus ? (
              <div className={`chat-status status-${status}`}>
                <span className="dot" />
                {t(STATUS_LABEL_KEYS[status])}
              </div>
            ) : undefined
          }
        >
          <div data-intro="name-input" className="input-row">
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
              className={`send-btn${busy ? " is-stopping" : ""}`}
              onClick={busy ? () => getChatEngine().interrupt() : send}
              disabled={!busy && !input.trim()}
              aria-label={t(busy ? "chat.stop" : "chat.send")}
              title={t(busy ? "chat.stop" : "chat.send")}
            >
              <Icon name={busy ? "stop" : "send"} />
            </Button>
          </div>
        </DialogBox>
      </div>

      {/* 底部工具条：对照 VN 底部 icon 栏，操作聚拢右侧，返回标题收尾 */}
      <div className="chat-toolbar">
        <div className="tb-side">
          <Button
            className="tb tb-framing"
            title={t(closeUp ? "performance.fullBody" : "performance.closeUp")}
            onClick={() => { const next = !getStage().getCloseUp(); getStage().setCloseUp(next); setCloseUp(next); }}
          >
            {t(closeUp ? "performance.fullBody" : "performance.closeUp")}
          </Button>
          <Button className={`tb tb-focus tip${attention.focus?' is-active':''}`} aria-pressed={attention.focus} disabled={controlling} onClick={()=>void control(attention.focus?'focus_off':'focus_on')} aria-label={t('attention.focus')} data-tip={t('attention.focus')} data-tip-detail={t('attention.focusHint')}><Icon name="focus" size={16}/></Button>
          {phoneBusy && <Button className="tb" disabled={controlling} onClick={()=>void control('stop')} aria-label={t('attention.stopPhone')} title={t('attention.stopPhone')}><Icon name="stop" size={15}/></Button>}
          {attention.phonePaused && !attention.focus && <Button className="tb" disabled={controlling} onClick={()=>void control('resume_phone')} title={t('attention.resumePhone')}><Icon name="phone" size={16}/><span>{t('attention.resumePhone')}</span></Button>}
          {!introActive&&<PhoneSurface active={interactive} attention={attention} onVisibilityChange={setPhoneOpen} closeSignal={phoneClose}/>}
          <Button
            className="tb"
            aria-label={t("chat.backlog")}
            title={t("chat.backlog")}
            onClick={() => navigate("backlog")}
          >
            <Icon name="backlog" />
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
            data-intro="chat-settings"
            aria-label={t("settings.title")}
            title={t("settings.title")}
            onClick={() => navigate("settings")}
          >
            <Icon name="gear" />
          </Button>
          <Button
            className="tb"
            data-intro="chat-back"
            aria-label={t("common.backTitle")}
            title={t("common.backTitle")}
            onClick={() => {
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
