import ProactiveResponseToggle from '../components/ProactiveResponseToggle';
import {useComputerReactions} from '../services/useComputerReactions';
import {useActivities} from '../services/extensionActivities';
import DesktopPetControls from '../components/DesktopPetControls';
import {useDesktopWindow} from '../services/desktopWindow';
import ExtensionActivities from './ExtensionActivities';
import {useImageDraft} from '../chat/useImageDraft';
import '../styles/images.css';
import DialogDrawer from '../phone/DialogDrawer';
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
import { ServiceError } from "../lib/errors";
import { getState, updateGeneral, speakerName, subscribe } from "../lib/store";
import { ttsConfigured } from "../lib/asr";
import Button from "../ui/Button";
import Icon from "../ui/Icon";
import PhoneSurface from "../components/PhoneSurface";
import FirstMeeting from "../components/FirstMeeting";
import DialogBox from "../components/DialogBox";
import "../styles/chat.css";
import {controlAttention,type AttentionState} from '../services/meetingClient';
import {warmCapture} from '../effects/captureStage';
import TerminalPrompt from '../ui/TerminalPrompt';

const STATUS_LABEL_KEYS: Record<ChatStatus, string> = {
  idle: "chat.idle",
  listening: "chat.listening",
  thinking: "chat.thinking",
  speaking: "chat.speaking",
};

export default function Chat({active,attention,onHome}: {active: boolean;attention:AttentionState;onHome:()=>void}) {
  const t = useT();
  const desktopWindow=useDesktopWindow();
  const [phoneOpen,setPhoneOpen]=useState(false),[phoneClose,setPhoneClose]=useState(0);
  useEffect(()=>{if(desktopWindow.mode==='pet')setPhoneClose(value=>value+1);},[desktopWindow.mode]);
  const intro=useIntro();
  const introActive=!!intro.data && intro.data.phase!=="completed";
  const activities=useActivities();
  useComputerReactions(active&&!introActive&&activities.computer);
  // 角色名/通用设置跟随 store（切换语言、改名、状态开关即时生效）。
  const preferences=useSyncExternalStore(subscribe, getState).settings.general;
  const name = speakerName();
  const showStatus = getState().settings.general.showStatus;
  // 内置语音输入与设置页「通用」共用同一个开关。
  const micAllowed =
    getState().settings.general.voiceInput;
  const ttsReady = ttsConfigured(getState().settings.tts);
  const [status, setStatus] = useState<ChatStatus>(getChatEngine().status);
  const [micOn, setMicOn] = useState(getChatEngine().listening);
  const muted=preferences.voiceMuted===true;
  const [streamActive, setStreamActive] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState(false);
  const [input, setInput] = useState("");
  const drafts=useImageDraft();
  const [imageSending,setImageSending]=useState(false);
  const imagesEnabled=!!getState().settings.llm.vision&&!introActive;
  const petCollapsed=preferences.petDialogCollapsed!==false;
  const closeUp=desktopWindow.mode==='pet'?preferences.petCloseUp===true:preferences.chatCloseUp!==false;
  const toggleFrame=()=>updateGeneral(desktopWindow.mode==='pet'?{petCloseUp:!closeUp}:{chatCloseUp:!closeUp});
  const collapsed=desktopWindow.mode==='pet'?petCollapsed:phoneOpen;
  const [controlling,setControlling]=useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!active)return;
    // Warm only static fonts/library, never a user's conversation screenshot.
    const timer=setTimeout(()=>{const stage=dialog.current?.closest<HTMLElement>('.app-stage');if(stage)void warmCapture(stage);},200);
    return()=>clearTimeout(timer);
  },[active]);
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
      if(msg.startsWith("vision."))msg=t(msg);
      if (e instanceof ServiceError) {
        if (e.service === "llm") setModelError(true);
        const detail =
          e.failure === "unconfigured"
            ? t("chat.errCfg")
            : e.failure === "unreachable"
              ? t("chat.errConn")
              : e.detail?.startsWith("vision.") ? t(e.detail) : e.detail || `HTTP ${e.status}`;
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
    if ((!text&&!drafts.items.length)||imageSending||drafts.items.length&&!drafts.ready) return;
    if(drafts.items.length&&!imagesEnabled){setError(t('vision.disabled'));return;}
    setModelError(false);
    if(drafts.items.length){
      setImageSending(true);
      getChatEngine().sendText(text,drafts.items.flatMap(item=>item.image?[item.image]:[]),ok=>{
        setImageSending(false);
        if(ok)drafts.accepted();
        else setInput(current=>current||text);
      });
    }else getChatEngine().sendText(text);
    setInput("");
  };

  const toggleMic = (): void => {
    const eng = getChatEngine();
    if (eng.microphoneActive) {
      updateGeneral({microphoneEnabled:false});
      eng.stopListening();
      setMicOn(false);
    } else {
      updateGeneral({microphoneEnabled:true});
      setMicOn(true);
      void eng.startListening().then(() => setMicOn(eng.listening));
    }
  };

  const toggleVoice = (): void => {
    const eng = getChatEngine();
    eng.setMuted(!eng.muted);

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
    <div className={`chat-page${phoneOpen?' has-phone':''}${desktopWindow.mode==='pet'&&petCollapsed?' pet-dialog-collapsed':''}`} inert={!interactive}>
      {interactive && <FirstMeeting connectionFailed={modelError} />}
      {error && <div className="chat-error">{error}</div>}

      <DialogDrawer>
      <div className="dialog-zone" ref={dialog}>
        <DialogBox
          collapsed={collapsed}
          handle={<DialogHandle active={phoneOpen} onClick={()=>{updateGeneral({phonePresentation:"closed"});setPhoneClose(v=>v+1);}}/>}
          lang={resolveChatLang(getState().settings.general)}
          name={name}
          text={subtitle || <span className="muted">……</span>}
          typing={busy&&streamActive}
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
          {drafts.items.length>0&&<div className="image-drafts" aria-label={t('vision.draft')}>
            {drafts.items.map(item=><div key={item.key} className={`image-draft${item.error?' has-error':''}`}>
              <img src={item.url} alt={t('vision.image')}/>
              <button type="button" disabled={imageSending} aria-label={t('vision.remove')} onClick={()=>drafts.remove(item.key)}>×</button>
              {item.pending?<small>{t('vision.loading')}</small>:item.error?<button className="image-retry" title={t(item.error)} onClick={()=>drafts.retry(item)}>{t('vision.retry')}</button>:item.image?.animated?<small>{t('vision.still')}</small>:null}
            </div>)}
          </div>}
          {drafts.error&&<p className="image-draft-error" role="alert">{t(drafts.error)}</p>}
          <div data-intro="name-input" className="input-row" inert={collapsed}>
            <span className="terminal-input-prompt" aria-hidden="true"><TerminalPrompt/></span>
            <input
              value={input}
              placeholder={t("chat.placeholder", { name })}
              onChange={(e) => setInput(e.target.value)}
              onPaste={e=>{
                const files=Array.from(e.clipboardData.items).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).flatMap(item=>{const file=item.getAsFile();return file?[file]:[];});
                if(!files.length)return;
                e.preventDefault();
                if(!imagesEnabled){setError(t('vision.disabled'));return;}
                if(imageSending)return;
                drafts.add(files);
                const text=e.clipboardData.getData('text/plain');if(text)setInput(current=>current+text);
              }}
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
              disabled={!busy && (imageSending||(!input.trim()&&!drafts.items.length)||(drafts.items.length>0&&!drafts.ready))}
              aria-label={t(busy ? "chat.stop" : "chat.send")}
              title={t(busy ? "chat.stop" : "chat.send")}
            >
              <Icon name={busy ? "stop" : "send"} />
            </Button>
          </div>
        </DialogBox>
      </div>

      </DialogDrawer>

      <DesktopPetControls closeUp={closeUp} onFrame={toggleFrame} collapsed={petCollapsed} onDialog={()=>updateGeneral({petDialogCollapsed:!petCollapsed})} micOn={micOn} micAllowed={micAllowed} onMic={toggleMic}/>
      {/* 固定右侧竖轨，与对话框及手机的显隐独立。 */}
      <div className="chat-toolbar">
        <div className="tb-side">
          <Button
            className="tb tb-framing"
            aria-label={t(closeUp ? "performance.fullBody" : "performance.closeUp")}
            onClick={toggleFrame}
          >
            <Icon name={closeUp ? "frameFull" : "frameClose"} />
          </Button>
          <Button className={`tb tb-focus tip${attention.focus?' is-active':''}`} aria-pressed={attention.focus} disabled={controlling} onClick={()=>void control(attention.focus?'focus_off':'focus_on')} aria-label={t('attention.focus')} data-tip={t('attention.focus')} data-tip-detail={t('attention.focusHint')}><Icon name="focus" size={16}/></Button>
          {phoneBusy && <Button className="tb" disabled={controlling} onClick={()=>void control('stop')} aria-label={t('attention.stopPhone')} title={t('attention.stopPhone')}><Icon name="stop" size={15}/></Button>}
          {attention.phonePaused && !attention.focus && <Button className="tb" disabled={controlling} onClick={()=>void control('resume_phone')} title={t('attention.resumePhone')}><Icon name="play" size={16}/></Button>}
          {!introActive&&<ExtensionActivities/>}
          {!introActive&&activities.computer&&desktopWindow.mode!=='pet'&&<ProactiveResponseToggle/>}
          {!introActive&&<PhoneSurface active={interactive&&desktopWindow.mode!=='pet'} attention={attention} onVisibilityChange={setPhoneOpen} closeSignal={phoneClose}/>}
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
            onPointerEnter={()=>{const stage=dialog.current?.closest<HTMLElement>('.app-stage');if(stage)void warmCapture(stage);}}
            onFocus={()=>{const stage=dialog.current?.closest<HTMLElement>('.app-stage');if(stage)void warmCapture(stage);}}
            onClick={onHome}
          >
            <Icon name="home" />
          </Button>
        </div>
      </div>
    </div>
  );
}
