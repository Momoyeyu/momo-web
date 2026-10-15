import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { bootPersist } from "./lib/store";
import { liveTranscript } from "./services/checkpointClient";
import { loadTranscript } from "./chat/engine";
import "./styles/base.css";

// 先尝试从 dev server 的 .momo-state.json 恢复（含 key 的持久化配置），
// 失败也照常启动（localStorage 兜底）。
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
