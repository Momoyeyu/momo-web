// 回到同一个 momo。进入见面不清空记录，也不恢复另一条时间线。
import {currentRoute,navigate} from "../router";
import {useT} from "../i18n";
import TerminalTagline from "../components/TerminalTagline";
import EcgCanvas from "../components/EcgCanvas";
import Button from "../ui/Button";
import {PRESENCE_URL,TITLE_PRESENCE} from "../lib/presenceTransition";
import "../styles/title.css";
import {introSnapshot,verifyIntro} from "../services/introClient";
import {useLayoutEffect,useRef,useState} from "react";
import {enterMeeting,leaveMeeting,meetingSnapshot} from "../services/meetingClient";
import {warmVoice} from "../services/ttsWarmup";
import {getChatEngine} from "../chat/engineInstance";

export default function Title({active}: {active:boolean}) {
  const t = useT();
  const [starting,setStarting]=useState(false);
  const [failed,setFailed]=useState(false);
  const bootAttempt = useRef<{cancelled:boolean;entering:boolean}|null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    return () => {
      const attempt = bootAttempt.current;
      if (!attempt) return;
      attempt.cancelled = true;
      // The meeting client releases a superseded lease when Enter responds.
      if (attempt.entering) void leaveMeeting();
    };
  }, [active]);
  const boot = async () => {
    if (!active || bootAttempt.current || currentRoute() !== 'title') return;
    const attempt = {cancelled:false,entering:false};
    bootAttempt.current = attempt;
    const stillOnTitle = () => !attempt.cancelled && currentRoute() === 'title';
    setStarting(true);
    setFailed(false);
    try {
      if (introSnapshot().data?.phase !== 'completed') await verifyIntro();
      if (!stillOnTitle()) return;
      await leaveMeeting(getChatEngine().finishMeeting());
      if (!stillOnTitle()) return;
      attempt.entering = true;
      const lease = await enterMeeting();
      if (!stillOnTitle()) {
        if (meetingSnapshot().lease?.leaseId === lease.leaseId) await leaveMeeting();
        return;
      }
      if (!getChatEngine().muted) warmVoice();
      navigate('chat','boot');
    } catch {
      if (stillOnTitle()) setFailed(true);
    } finally {
      bootAttempt.current = null;
      setStarting(false);
    }
  };
  const items = [
    {key: "boot", labelKey: "title.start", hint: "boot", onClick: () => void boot()},
    {key: "config", labelKey: "title.config", hint: "config", onClick: () => navigate("settings")},
  ];

  return (
    <div data-intro="celebration" className="title-screen">
      <EcgCanvas />
      <img className="title-presence" src={PRESENCE_URL} style={{left:`${TITLE_PRESENCE.left*100}%`,top:`${TITLE_PRESENCE.top*100}%`,width:`${TITLE_PRESENCE.width*100}%`}} width="1024" height="1536" alt="" aria-hidden="true" decoding="async" draggable={false} />
      <header className="title-brand">
        <h1 className="title-logo" aria-label="momo"><img className="title-brand-mark" src="/brand/momo-mark.svg" alt="" draggable={false} /><img className="title-brand-wordmark" src="/brand/momo-wordmark.svg" alt="momo" draggable={false} /></h1>
        <div className="title-rule" />
        <TerminalTagline key={t("title.tagline")} text={t("title.tagline")} active={active}/>
      </header>

      <nav className="title-menu">
        {items.map((m, i) => (
          <Button
            key={m.key}
            data-intro={m.key === "config" ? "settings" : "boot"}
            className="menu-item"
            style={{ animationDelay: `${0.12 + i * 0.08}s` }}
            onClick={m.onClick}
            disabled={starting}
          >
            <span className="mi-orn" aria-hidden="true">
              <svg viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d={m.key === "boot" ? "M4 5h14v12H4z M7 8l3 3-3 3m5 0h3" : "M4 7h14M4 15h14M8 4v6m7 2v6"}/>
              </svg>
            </span>
            <span className="mi-label">{t(m.labelKey)}</span>
            <span className="mi-hint" lang="en">{m.hint}</span>
          </Button>
        ))}
      </nav>
      {failed && <p className="title-boot-error" role="alert">{t(meetingSnapshot().reason==='owned'?'meeting.ownerUnavailable':'meeting.unavailable')}</p>}
    </div>
  );
}
