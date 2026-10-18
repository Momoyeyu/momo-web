# momo

一款类 Neuro-Sama 的交互式 AI 游戏。本仓库是早期的 Web Demo 版本，Working in Progress ...

当前 Demo 覆盖的是游戏的基础交互层：视觉小说式的对话——Live2D 形象 + 语音输入/输出 + 流式字幕，配人格、记忆、存档槽位与拓展接入。

技术上是 React SPA 前端 + FastAPI 后端（前后端显式分离，frontend 将来原样进 Tauri WebView，backend 进 Rust Core）。

## 跑起来

```bash
# 后端（config 存储 + ReAct agent + 记忆 RAG）
cd backend && uv sync && uv run uvicorn app.main:app --port 7821

# 前端
cd frontend && pnpm install && pnpm dev    # http://localhost:5173
```

## 结构

```
frontend/   React+TS+Vite：UI、语音链路（ASR/TTS/音频）、Live2D、backlog
            services 通过 HTTP 调 backend（vite 代理 /api → :7821）
backend/    FastAPI：state 存储、ReAct 循环（LLM + memory/common.time 工具）、
            记忆存储 + RAG（bge-m3 embedding，mac-studio 直连）
docs/       backend-api.md：前后端契约
```

API 契约详见 `docs/backend-api.md`。

## 页面

- **title**：主页，视觉小说式菜单 + 心跳主题的动态背景
- **chat**：VN 式底部对话框。文字输入或麦克风连续语音 → backend ReAct → SSE 流式回复 → 字幕 + TTS 播放 + 口型/表情；说话中可随时打断（语音 barge-in 或停止按钮）
- **backlog**：回顾子页，视觉小说式历史回放
- **checkpoint**：存档 / 读档，固定 120 个槽位（10 页滑轨），auto 槽为读档前的自动备份
- **settings**：通用 / 模型（LLM·ASR·TTS·Embedding·形象）/ 记忆 / 拓展（MCP）

## 验证

```bash
cd frontend && pnpm test && pnpm typecheck && pnpm build
cd backend && uv run pytest
```

## 说明

- 状态（设置/人设/初始记忆/形象列表）由 backend `momo.yaml` 权威存储，localStorage 仅作离线缓存。
- Live2D 模型 zip 存浏览器 IndexedDB（不经 backend）。
- Live2D Cubism Core 运行时从官方 CDN 加载（`VITE_MOMO_CUBISM_CORE_URL` 可换镜像）。

## 已知限制（Tauri 迁移待办）

- **未保存弹窗无法自动移动光标到「保存并离开」**：浏览器没有任何移动系统光标的 JS API（安全限制，防 clickjacking）。迁移 Tauri 后用 `WebviewWindow.set_cursor_position()` 直接实现。
