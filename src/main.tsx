import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { bootPersist } from "./lib/store";
import "./styles/base.css";

// 先尝试从 dev server 的 .momo-state.json 恢复（含 key 的持久化配置），
// 失败也照常启动（localStorage 兜底）。
void bootPersist().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
