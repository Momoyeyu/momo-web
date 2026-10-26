import {enterMeeting,leaveMeeting,meetingSnapshot,subscribeMeeting,storedMeetingIdentity,refreshAttention,type AttentionState} from "./services/meetingClient";
import {getChatEngine,loadTranscript} from "./chat/engineInstance";
import {historyPage} from "./services/lifeClient";
import {useT} from "./i18n";
import Button from "./ui/Button";
import TooltipLayer from "./ui/TooltipLayer";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import StageCanvas from "./live2d/StageCanvas";
import Title from "./pages/Title";
import Chat from "./pages/Chat";
import Settings from "./pages/Settings";
import Backlog from "./pages/Backlog";
import GridBackdrop from "./components/GridBackdrop";
import ChatEntryTransition from "./components/ChatEntryTransition";
import { blobForward } from "./lib/blobMask";
import { setRopeFrom } from "./lib/ropeAngle";
import { useRoute, type Route } from "./router";
import { getSettings, subscribe } from "./lib/store";

// Only title → chat uses the ink/ASCII entry. All other navigation keeps RoPE.
const BLOOM_MS = 560; // RoPE 页之间的边缘漫开
const RIPPLE_MS = 1000; // 涟漪散尽（特效层生命周期）
// 每个页面一个坐标系角度（RoPE）。**按层级单调递增**：
//   title(根, 0) < chat(15) < settings(40) < backlog(110)
// 角度增大 = 层级变深；顺时针（角度+）是往深走，逆时针是往浅走。
// settings 内部 tab 再叠加 +70/tab（越往右越深）。
const ROUTE_ANGLE: Record<Route, number> = {
  title: 0,
  chat: 15,
  settings: 40,
  backlog: 110,
};

interface PageEntry {
  id: number;
  route: Route;
  leaving?: boolean;
}

function renderPage(route: Route, active: boolean, attention:AttentionState) {
  switch (route) {
    case "title":
      return <Title />;
    case "chat":
      return <Chat active={active} attention={attention} />;
    case "settings":
      return <Settings />;
    case "backlog":
      return <Backlog />;
  }
}

export default function App({ready, onPrepared}: {ready: boolean; onPrepared: () => void}) {
  const route = useRoute();
  const t = useT();
  const meeting = useSyncExternalStore(subscribeMeeting,meetingSnapshot);
  const [syncedLease,setSyncedLease]=useState<string|null>(null);
  const [historyFailed,setHistoryFailed]=useState(false);
  const [historyRetry,setHistoryRetry]=useState(0);
  const activeLease=meeting.state === "active" ? meeting.lease?.leaseId ?? null : null;
  const historyReady=activeLease!==null && syncedLease===activeLease;
  const attentionFault=meeting.state==='active' && meeting.attention.activation==='fault';
  const meetingReady = route !== "chat" || meeting.state === "active" && historyReady && !attentionFault;
  useEffect(()=>{
    if(!activeLease){setSyncedLease(null);setHistoryFailed(false);return;}
    const request=new AbortController();
    setHistoryFailed(false);
    void historyPage(undefined,request.signal).then(page=>{
      if(request.signal.aborted || meetingSnapshot().lease?.leaseId!==activeLease)return;
      // Only a fresh meeting synchronizes. Subpage returns keep the same lease
      // and must preserve a reply buffered while its presentation was paused.
      if(getChatEngine().status === "idle")loadTranscript(page.messages);
      setSyncedLease(activeLease);
    }).catch(()=>{if(!request.signal.aborted)setHistoryFailed(true);});
    return()=>request.abort();
  },[activeLease,historyRetry]);
  useEffect(() => {
    if (route === "title") {
      void leaveMeeting(getChatEngine().finishMeeting());
    } else if (meetingSnapshot().state === "active") {
      // Settings and history retain an already active brain; they never boot it.
    } else if (storedMeetingIdentity()) {
      void enterMeeting(true).then(() => {if (location.hash.replace(/^#\/?/,"") === "title") void leaveMeeting(getChatEngine().finishMeeting());}).catch(() => {});
    } else if (route === "chat") {
      location.hash="#/title";
    }
  },[route]);
  useEffect(()=>{
    if(meeting.state!=='active')return;
    const request=new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{await refreshAttention(request.signal);}catch{/* Heartbeat is the authoritative ownership gate. */}if(!request.signal.aborted)timer=setTimeout(()=>void poll(),1000);};
    void poll();
    return()=>{request.abort();clearTimeout(timer);};
  },[meeting.state]);
  useEffect(() => {
    if (meeting.state === "failed" || attentionFault) {getChatEngine().interrupt();getChatEngine().suspendMic();}
  },[meeting.state,attentionFault]);
  const [sceneReady, setSceneReady] = useState(false);
  const scenePrepared = useCallback(() => setSceneReady(true), []);
  useEffect(() => {
    if (ready || (route === 'chat' && !sceneReady)) return;
    // Commit and paint the incoming scene under the opaque startup layer first.
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => { secondFrame = requestAnimationFrame(onPrepared); });
    const deadline = window.setTimeout(onPrepared, 120); // Background windows may pause RAF.
    return () => { cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame); clearTimeout(deadline); };
  }, [ready, route, sceneReady, onPrepared]);
  // 页面栈：换页时旧页不立即卸载，而是留在栈里淡出后再移除——
  // 这样"化开"的是真正的旧页实例（状态也还在），不是重挂一份复制品。
  const [stack, setStack] = useState<PageEntry[]>([{ id: 0, route }]);
  // front = 新页正在从落点向外"漫开"（临时盖上不规则遮罩）。
  const [front, setFront] = useState(false);
  // rev = 往回走（层级向上）：洞口收拢、涟漪向内
  const [rev, setRev] = useState(false);
  // booting = 进入 chat 的场景转场尚未完成（ASCII 或 RoPE）。
  const [booting, setBooting] = useState(false);
  const [fx, setFx] = useState(false);
  const [entry, setEntry] = useState<number | null>(null);
  const curRef = useRef<Route>(route);
  const seq = useRef(1);
  // 访问历史：判断"这一次是往里走还是往回走"。返回目标若正好是上一页，
  // 就当作回退（洞口收拢）；否则当作深入（洞口长开）。
  // 层级本身：title 是根，chat / settings 挂在 title 下，
  // backlog 挂在 chat 下——回退按钮都指向各自父级，所以历史栈足够判定。
  const histRef = useRef<Route[]>([route]);

  // 对话框不透明度 → CSS 变量，保存后即时生效。
  useEffect(() => {
    const apply = (): void => {
      document.documentElement.lang = getSettings().general.lang === "zh" ? "zh-CN" : getSettings().general.lang;
      document.documentElement.style.setProperty(
        "--dialog-alpha",
        String(getSettings().general.dialogOpacity / 100),
      );
    };
    apply();
    return subscribe(apply);
  }, []);

  useEffect(() => {
    if (route === curRef.current) return;
    const prevRoute = curRef.current;
    curRef.current = route;
    // 把被离开页的角度交给 ropeAngle 通道：新页挂载时从这里旋转过来
    setRopeFrom(ROUTE_ANGLE[prevRoute]);

    const hist = histRef.current;
    const back = hist.length > 1 && hist[hist.length - 2] === route;
    if (back) hist.pop();
    else hist.push(route);
    if (hist.length > 24) hist.splice(0, hist.length - 24);

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStack([{ id: seq.current++, route }]);
      setFront(false);
      setRev(false);
      setBooting(false);
      setFx(false);
      setEntry(null);
      return;
    }
    const titleEntry = prevRoute === "title" && route === "chat";
    setRev(back);
    setFx(!titleEntry);

    let t1: number | undefined;
    const t2 = window.setTimeout(() => setFx(false), RIPPLE_MS);

    // 同一路由只保留最新实例：来回切换时旧的那份直接丢弃，
    // 否则会出现两个同页 DOM 并存（定位器会匹配到多份）
    const withoutSame = (prev: PageEntry[]): PageEntry[] =>
      prev.filter((p) => p.route !== route);

    if (titleEntry) {
      // The ink plate releases the real scene; other routes keep their RoPE.
      setStack((prev) => [
        ...withoutSame(prev).map((p) => ({ ...p, leaving: true })),
        { id: seq.current++, route },
      ]);
      setBooting(true);
      setFront(false);
      setEntry(seq.current++);
    } else {
      setEntry(null);
      setBooting(route === "chat");
      // RoPE 页之间：新页压栈顶，盖上不规则遮罩漫开；旧页在下面等着被盖住
      setStack((prev) => [
        ...withoutSame(prev),
        { id: seq.current++, route },
      ]);
      setFront(true);
      t1 = window.setTimeout(() => {
        setFront(false);
        setBooting(false);
        setStack((prev) => prev.slice(-1));
      }, BLOOM_MS);
    }
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [route]);

  const stageStyle = {
    "--tx-bloom-ms": `${BLOOM_MS}ms`,
    "--tx-ms": `${RIPPLE_MS}ms`,
    "--blob-forward": blobForward,
  } as CSSProperties;

  // 全部内容锁在 16:9 舞台内（.app-stage）：窗口比例任意，画面比例恒定。
  return (
    <div className={`app-stage${fx ? " tx-active" : ""}`} style={stageStyle}>
      {/* 舞台级网格：常驻、不参与页面变换、随页面坐标系旋转（RoPE） */}
      {/* sweep 放长到 900ms：遮幕/漫开盖住的时段之外仍能看到旋转 */}
      <GridBackdrop angle={ROUTE_ANGLE[route]} sweepMs={900} />

      {/* 对话场景的房间底图 + Live2D：不随路由重挂载 */}
      <div className="chat-layer">
        <StageCanvas visible={route === "chat"} onReady={scenePrepared} />
      </div>

      {stack.map((p, i) => {
        const top = i === stack.length - 1;
        let cls: string;
        if (p.leaving) {
          cls = " is-leaving";
        } else if (!top) {
          cls = " is-back";
        } else if (front) {
          cls = ` is-front${rev ? " is-rev" : ""}`;
        } else {
          cls = "";
        }
        // 进入 chat 的化开还没结束时，压住 chat 内部的入场动画（对话框抢跑）
        if (top && p.route === "chat" && (booting || !ready || !meetingReady)) cls += " is-booting";
        return (
          <div
            key={p.id}
            className={`page-wrap${p.route === "chat" ? " is-chat" : ""}${cls}`}
            aria-hidden={top ? undefined : true}
            inert={!top || p.route !== route || front || booting || !ready || !meetingReady}
          >
            {renderPage(p.route, top && p.route === route && !front && !booting && ready && meetingReady,meeting.attention)}
          </div>
        );
      })}

      {entry !== null && <ChatEntryTransition key={entry} onComplete={() => {
        if(curRef.current !== "chat")return;
        setEntry(null);setBooting(false);setStack(previous => previous.slice(-1));
      }} />}

      {route === "chat" && (meeting.state === "failed" || historyFailed || meeting.state !== "active" || !historyReady || attentionFault) && <div className="meeting-gate" role="status" aria-live="polite">
        <div className="meeting-gate-panel">
          <p>{t(attentionFault?'meeting.attentionFault':meeting.state === "failed" || historyFailed ? (meeting.reason === "owned" ? "meeting.ownerUnavailable" : "meeting.unavailable") : "meeting.entering")}</p>
          {(meeting.state === "failed" || historyFailed || attentionFault) && <div className="meeting-gate-actions">{attentionFault?<Button size="sm" variant="ghost" onClick={()=>{location.hash='#/settings';}}>{t('settings.title')}</Button>:<Button size="sm" variant="ghost" onClick={() => historyFailed ? setHistoryRetry(value=>value+1) : void enterMeeting().catch(() => {})}>{t("meeting.retry")}</Button>}<Button size="sm" variant="ghost" onClick={() => {location.hash="#/title";}}>{t("common.backTitle")}</Button></div>}
        </div>
      </div>}
      <TooltipLayer />

      {/* 换场特效：落点 + 水面光晕（涟漪环已删——正圆光环盖过不规则边缘） */}
      <div className="tx-fx" aria-hidden="true">
        <i className="tx-sheen" />
        <i className="tx-drop" />
      </div>
    </div>
  );
}
