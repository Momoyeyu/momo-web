import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { bootPersist } from "./lib/store";
import { liveTranscript } from "./services/checkpointClient";
import { loadTranscript } from "./chat/engineInstance";
import "./styles/base.css";

// 先从 backend 恢复配置（momo.yaml 权威，含 key），失败也照常启动（localStorage 兜底）。
// 随后从 backend 灌 live 会话转写（momo.db 权威：backlog/字幕重启后延续）。
void bootPersist()
  .then(() =>
    liveTranscript()
      .then((t) => {
        if (t.messages.length) loadTranscript(t.messages);
      })
      .catch(() => {}),
  )
  .finally(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
