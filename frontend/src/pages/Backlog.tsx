// Backlog 回顾子页：视觉小说式历史回放 overlay。
// 读 ChatEngine.history（应用级单例），离开/返回不影响在途回合。
// assistant 条目支持语音重播：按文本+当时情绪 tag 实时走 TTS 合成，
// 不存历史音频；回合进行中（引擎非空闲）禁用。

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  getChatEngine,
  subscribeTranscript,
  transcriptVersion,
} from "../chat/engineInstance";
import { getState, speakerName, subscribe } from "../lib/store";
import { navigate } from "../router";
import { useT } from "../i18n";
import Button from "../ui/Button";
import {historyPage} from "../services/lifeClient";
import {meetingIdentity} from "../services/meetingClient";
import {groupTranscript, mergeHistory, storedMessage} from "../chat/transcript";
import type {ChatMessage} from "../lib/types";
import PageHeader from "../ui/PageHeader";
import "../styles/backlog.css";

export default function Backlog() {
  const t = useT();
  // 回放期间若有新消息落账/状态变化，刷新列表；store 订阅用于语言/角色名热更。
  const version = useSyncExternalStore(subscribeTranscript, transcriptVersion);
  useSyncExternalStore(subscribe, getState);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [replaying, setReplaying] = useState<string | null>(null);
  const [replayError,setReplayError]=useState(false);
  const engine = getChatEngine();
  const [saved, setSaved] = useState<ChatMessage[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry,setRetry] = useState(0);
  const pageRequest = useRef<AbortController | null>(null);
  const preserveScroll = useRef<{height:number;top:number} | null>(null);
  const initialized = useRef(false);
  const messages = mergeHistory(saved, engine.history.slice(-100));
  const groups = groupTranscript(messages);
  const name = speakerName();
  const idle = engine.status === "idle";
  // 回放可见反馈：TTS 未配置 / 语音静音时置灰 + tooltip 说明（点了也没声）。
  const ttsConfigured = getState().settings.tts.url.trim() !== "";
  const muted = engine.muted;

  // Fetch at settlement, never on each revealed character. Aborted pages cannot
  // replace newer history, and prepending preserves the reader's scroll anchor.
  const settled = engine.status === "idle";
  useEffect(() => {
    const request = new AbortController();
    setLoading(true);
    pageRequest.current = request;
    void historyPage(undefined, request.signal).then(page => {
      if (request.signal.aborted) return;
      setSaved(previous => mergeHistory(previous,page.messages.map(storedMessage)));
      if (!initialized.current) {setBefore(page.nextBefore);setHasMore(page.hasMore);}
      setFailed(false);
    }).catch(() => {if (!request.signal.aborted) setFailed(true);})
      .finally(() => {if (!request.signal.aborted) setLoading(false);});
    return () => request.abort();
  }, [settled,retry]);
  useEffect(() => () => pageRequest.current?.abort(), []);
  useEffect(() => () => {void engine.stopReplay();},[engine]);
  useLayoutEffect(() => {
    const element = listRef.current;
    // A failed first page must leave pagination and its scroll anchor uninitialized.
    if (!element || loading || failed) return;
    if (preserveScroll.current) {
      const anchor = preserveScroll.current;
      element.scrollTop = anchor.top + element.scrollHeight - anchor.height;
      preserveScroll.current = null;
    } else if (!initialized.current) {
      element.scrollTop = element.scrollHeight;
      initialized.current = true;
    }
  }, [saved,loading,failed]);
  // Keep live additions visible only when already following the bottom.
  const previousHeight = useRef(0);
  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element || preserveScroll.current) return;
    if (element.scrollTop + element.clientHeight >= previousHeight.current - 60) element.scrollTop = element.scrollHeight;
    previousHeight.current = element.scrollHeight;
  }, [version]);
  const earlier = async () => {
    if (loading || before == null) return;
    setLoading(true);setFailed(false);
    const request = new AbortController();pageRequest.current?.abort();pageRequest.current = request;
    try {
      const page = await historyPage(before, request.signal);
      if (request.signal.aborted) return;
      const element = listRef.current;
      if (element) preserveScroll.current = {height:element.scrollHeight,top:element.scrollTop};
      setSaved(previous => mergeHistory(previous,page.messages.map(storedMessage)));
      setBefore(page.nextBefore);setHasMore(page.hasMore);
    } catch {if (!request.signal.aborted) setFailed(true);}
    finally {if (!request.signal.aborted) setLoading(false);}
  };

  const replay = (ids: string[]): void => {
    const entries = messages.filter(message => ids.includes(message.id));
    if (!entries.length || !idle) return;
    setReplayError(false);
    setReplaying(entries[0]!.id);
    void engine.replayMessage({...entries[0]!,text:entries.map(message => message.text).join("")}).catch(()=>setReplayError(true)).finally(() => setReplaying(null));
  };

  return (
    <div className="backlog-page">
      <div className="backlog-panel">
        <PageHeader
          className="backlog-head"
          title={t("backlog.title")}
          actions={
            <Button variant="ghost" onClick={() => navigate("chat")}>
              {t("common.backChat")}
            </Button>
          }
        />

        <div className="backlog-list" ref={listRef}>
          {replayError && <p role="alert" className="backlog-replay-error">{t('backlog.replayUnavailable')}</p>}
          {(hasMore || failed) && <div className="backlog-earlier"><Button size="sm" variant="ghost" disabled={loading} onClick={() => before == null ? setRetry(value=>value+1) : void earlier()}>{t(loading ? "backlog.loading" : failed ? "meeting.retry" : "backlog.earlier")}</Button></div>}
          {failed && <p role="alert" className="muted">{t("backlog.loadFailed")}</p>}
          {messages.length === 0 && !loading && (
            <div className="muted backlog-empty">{t("backlog.empty")}</div>
          )}
          {groups.map(group => {
            const m = group.messages[0]!;
            return <div key={group.id} className={`bl-item ${m.role}`} data-run-id={m.runId}>
              <div className="bl-name">
                {m.source==='qq' ? (m.role==='user'?'QQ · '+(m.peerId?.startsWith('group:')?t('phone.group')+' ':'')+(m.peerId??t('phone.received')):'momo · QQ') : m.role === "user" ? t("chat.you") : name}
                <small className="muted">{m.source==='meeting'?'chat':!m.source?t('phone.unknown'):m.source==='qq'?'':m.source}</small>
                {m.role === "assistant" && m.source!=="qq" && (
                  <Button
                    className="bl-replay"
                    disabled={!idle || replaying !== null || !ttsConfigured || muted || !meetingIdentity() || !m.runId || !m.eventId}
                    title={
                      !ttsConfigured
                        ? t("backlog.replayNeedTts")
                        : muted
                          ? t("backlog.replayMuted")
                        : !meetingIdentity() ? t('backlog.replayNeedBoot')
                        : !m.runId || !m.eventId ? t('backlog.replayNeedRecord') : undefined
                    }
                    onClick={() => replay(group.messages.map(message => message.id))}
                  >
                    {replaying === m.id ? "…" : `♪ ${t("backlog.replay")}`}
                  </Button>
                )}
              </div>
              <div className="bl-text">{group.messages.map(message => message.text).join("")}</div>
            </div>;
          })}
        </div>
      </div>
    </div>
  );
}
