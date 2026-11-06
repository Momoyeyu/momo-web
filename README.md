# momo

一款类 Neuro-Sama 的交互式 AI 游戏。本仓库是早期的 Web Demo 版本，Working in Progress ...

当前 Demo 覆盖的是游戏的基础交互层：视觉小说式的对话——Live2D 形象 + 语音输入/输出 + 流式字幕，配人格、记忆、存档槽位与拓展接入。

技术上是 React SPA 前端 + FastAPI 后端（前后端显式分离，后续迁入 Tauri WebView，并由桌面应用管理后端进程）。

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
            记忆存储 + 本地多语言 E5 语义检索
evaluations/ 真实模型对比实验与评分记录
```

API 契约以 `backend/openapi.json` 和运行时 `/docs` 为准。

## 页面

- **title**：主页，视觉小说式菜单 + 心跳主题的动态背景
- **chat**：VN 式底部对话框。文字输入或麦克风连续语音 → backend ReAct → SSE 流式回复 → 字幕 + TTS 播放 + 口型/表情；说话中可随时打断（语音 barge-in 或停止按钮）
- **backlog**：回顾子页，视觉小说式历史回放
- **checkpoint**：存档 / 读档，固定 120 个槽位（10 页滑轨），auto 槽为读档前的自动备份
- **settings**：通用 / 模型（LLM·TTS）/ 记忆 / 拓展（MCP）

## 内置能力与外部服务

- **内置语音识别**：SenseVoice-Small int8 + Silero VAD，本机识别中 / 日 / 英，模型随发行资源交付，不提供自定义服务配置。
- **内置记忆语义检索**：多语言 E5 ONNX 在 CPU 生成向量，SQLite / sqlite-vec 本地检索。模型无需玩家下载或填写端点；索引后台建立，缺资源时保留词面检索兜底。
- **LLM**：配置 OpenAI 兼容服务地址、API Key 与模型。DeepSeek 官方接口提供「思考模式」开关，默认关闭；思考不显示、不朗读、不进入记忆或存档。其他供应商暂不启用该开关。
- **TTS**：配置 GPT-SoVITS api_v2 服务地址，可选 API Key，上传参考音频并填写参考文本；音频由 backend 代理合成，字幕 / 口型按实际播放推进。可不配置语音，继续文字对话。

### 源码运行与发行资源

源码开发者启动前准备固定版本资源：

```bash
cd backend
uv run python scripts/download_asr_models.py
uv run python scripts/prepare_embedding.py
uv run python scripts/package_resources.py --verify
uv run python scripts/package_resources.py --output ../dist/momo-resources.zip
```

这是构建步骤，**不是玩家首次启动下载**。离线资源 ZIP 同时包含 ASR、embedding、校验清单与许可，缺失或损坏时构建失败；原生安装器接入属于后续 Tauri 迁移。资源目录约 360 MiB，当前压缩包约 236 MiB。说明见 [资源交付约定](backend/resources/README.md)。

SenseVoice 模型权重遵循 FunASR Model License 1.1，embedding 和 Silero 资源分别保留其 MIT 许可；代码仓库许可不替代模型权重许可。

[thinking 开关真实配对实验与主观评分](evaluations/2026-10-22-thinking/report.md)。

## 验证

```bash
cd frontend && pnpm test && pnpm typecheck && pnpm build
cd backend && uv run pytest
```

## 说明

- 设置与形象列表由 backend `momo.yaml` 权威存储；固定 soul 在资源文件，记忆和会话在用户数据库，localStorage 仅作离线缓存。
- Live2D 模型 zip 存浏览器 IndexedDB（不经 backend）。
- Live2D Cubism Core 运行时从官方 CDN 加载（`VITE_MOMO_CUBISM_CORE_URL` 可换镜像）。

## 已知限制（Tauri 迁移待办）

- **未保存弹窗无法自动移动光标到「保存并离开」**：浏览器没有任何移动系统光标的 JS API（安全限制，防 clickjacking）。迁移 Tauri 后用 `WebviewWindow.set_cursor_position()` 直接实现。
