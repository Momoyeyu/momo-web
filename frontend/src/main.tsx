import { desktop, runtime } from "./services/runtime";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import {refreshIntro} from "./services/introClient";
import { ttsConfigured } from "./lib/asr";
import { bootPersist, getSettings } from "./lib/store";
import { startupPresence, waitForStartupVoice } from "./startup/presence";
import { historyPage } from "./services/lifeClient";
import { loadTranscript } from "./chat/engineInstance";
import { warmVoice } from "./services/ttsWarmup";
import "./styles/base.css";

const startup = startupPresence();
startup.language(getSettings().general.lang);
let voiceStartup: Promise<void> | undefined;
function finishStartup() {
  if (!voiceStartup) {
    startup.finish();
    return;
  }
  startup.stage("voice");
  void voiceStartup.then(startup.finish);
}

function Game() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void startup.ready.then(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);
  return <App ready={ready} onPrepared={finishStartup} />;
}

// 先从 backend 恢复配置（momo.yaml 权威，含 key），失败也照常启动（localStorage 兜底）。
// 随后从 backend 灌 live 会话转写（momo.db 权威：backlog/字幕重启后延续）。
void runtime()
  .then(() => { startup.stage("restoring"); return bootPersist(); })
  .then(() => {
    const { general, tts } = getSettings();
    startup.language(general.lang);
    if (desktop() && ttsConfigured(tts)) {
      const warmup = warmVoice();
      if (!general.voiceMuted && general.voiceVolume > 0) {
        voiceStartup = waitForStartupVoice(warmup).finally(() => { voiceStartup = undefined; });
      }
    }
  })
  .then(() =>
    historyPage()
      .then((t) => {
        if (t.messages.length) loadTranscript(t.messages);
      })
      .catch(() => {}),
  )
  .then(refreshIntro)
  .then(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <Game />
      </StrictMode>,
    );
  }).catch(() => { startup.fail(); });
