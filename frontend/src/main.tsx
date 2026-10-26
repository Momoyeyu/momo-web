import { runtime } from "./services/runtime";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { bootPersist, getSettings } from "./lib/store";
import { startupPresence } from "./startup/presence";
import { historyPage } from "./services/lifeClient";
import { loadTranscript } from "./chat/engineInstance";
import "./styles/base.css";

const startup = startupPresence();
startup.language(getSettings().general.lang);
function Game() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void startup.ready.then(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);
  return <App ready={ready} onPrepared={startup.finish} />;
}

// 先从 backend 恢复配置（momo.yaml 权威，含 key），失败也照常启动（localStorage 兜底）。
// 随后从 backend 灌 live 会话转写（momo.db 权威：backlog/字幕重启后延续）。
void runtime()
  .then(() => { startup.stage("restoring"); return bootPersist(); })
  .then(() => { startup.language(getSettings().general.lang); })
  .then(() =>
    historyPage()
      .then((t) => {
        if (t.messages.length) loadTranscript(t.messages);
      })
      .catch(() => {}),
  )
  .then(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <Game />
      </StrictMode>,
    );
  }).catch(() => { startup.fail(); });
