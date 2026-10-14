# momo-demo

momo Web 版 MVP：纯前端单页应用，浏览器直连用户自配的 LLM / ASR / TTS endpoint，无自有后端。

## 跑起来

```bash
pnpm install
pnpm dev        # http://localhost:5173
```

## 页面

- **title**：主页，Live2D 形象（默认 Hiyori）+ 右侧视觉小说式菜单（开始/记忆/设置）
- **chat**：VN 式底部对话框（momo 铭牌 + 字幕 + 输入行 + 快捷栏）。文字输入或麦克风连续语音 → LLM 流式回复 → 字幕 + TTS 播放 + 口型/表情；说话中可随时打断（语音 barge-in 或停止按钮）
- **backlog**：回顾子页（chat 快捷栏「回顾」进入），视觉小说式历史回放；引擎为应用级单例，离开 chat 回合不中断
- **settings**：顶部横向 tab——LLM（OpenAI 兼容，url/key/model）、ASR（ws(s)://…/v1/listen，Deepgram 对齐）、TTS（http(s)://…/v1/audio/speech，OpenAI 对齐）、人格（人设卡查看/编辑、用户画像、长期记忆列表 查看/检索/编辑/删除）；双栏表单，保存立即生效

## 默认 endpoint

| 能力 | 默认 | 协议 |
|---|---|---|
| LLM | `https://api.deepseek.com` + `deepseek-chat` | OpenAI `POST /v1/chat/completions`（SSE） |
| ASR | `ws://127.0.0.1:7810` | Deepgram 对齐流式 `/v1/listen`（PCM s16le 16kHz 上行，`?token=` 鉴权） |
| TTS | `http://127.0.0.1:7811` | OpenAI 对齐 `POST /v1/audio/speech`（流式 s16le 24kHz） |

endpoint 按 base-URL 语义处理：填 base（含 `/v1` 或代理前缀）会自动拼接资源路径；已含完整端点路径则原样使用。

ASR/TTS 本地服务可用 momo-infra 的 momo-svc-asr / momo-svc-tts；也可填任何同形态第三方服务（DeepSeek API 已确认自带 CORS；本地 momo-svc 需 `common.py` 的 CORSMiddleware 补丁或走 dev 代理）。

无后端冒烟：`pnpm mock` 在 :5399 起一个 mock（LLM 流式应答 + TTS 静音 PCM），设置页把 LLM/TTS 地址填 `http://127.0.0.1:5399` 即可离线跑通文字+语音回合。

## dev 代理

`vite.config.ts` 内置 `/proxy/{llm,asr,tts}` 反代，用于浏览器直连被 CORS 拦截的本地服务：
设置页填 `http://localhost:<devPort>/proxy/tts` 即转发到对应上游；上游默认 `127.0.0.1:7820/17810/17811`，可用 `MOMO_DEMO_{LLM,ASR,TTS}_UPSTREAM` env 覆盖。

## 情绪与动作指令

LLM 输出与正文解耦的两条通道：模型以 `#tag` 独立指令表示情绪/动作切换（`neutral happy sad angry surprised thinking shy sleepy`，兼容遗留 `[tag]` 形式）。指令只驱动 Live2D 动作与 TTS emotion 参数，**绝不进入字幕、消息或 TTS 文本**；白名单外指令静默丢弃。

## 结构

```
src/
  lib/        类型 + localStorage 持久化 store
  llm/        SSE 客户端、system prompt 组装、情绪指令解析
  asr/ tts/ audio/  Deepgram WS / OpenAI HTTP / 采集与播放（AudioWorklet）
  live2d/     pixi.js v7 + pixi-live2d-display 舞台、口型与情绪动作
  memory/     回合后 LLM 抽取（JSON ops add/invalidate）+ 关键词召回注入
  chat/       回合协调器（打断、TTS 保序播放、状态机）+ 应用级引擎单例
  pages/      title / chat / backlog / settings（含人格 tab）
```

## 验证

```bash
pnpm test        # vitest：pcm/解析/记忆等纯逻辑
pnpm typecheck   # tsc --noEmit
pnpm build
```

## 说明

- 状态（设置/人设/记忆）双写：localStorage + 项目根 `.momo-state.json`（dev server 的 `/api/state` 端点读写，300ms 防抖；启动时文件优先恢复）。`.momo-state.json` 已 gitignore，含 key 不入库；非 dev 环境退化为纯 localStorage。
- 对话历史仅存内存（应用级引擎单例），刷新清空。
- Live2D Cubism Core 运行时从官方 CDN 加载（`VITE_MOMO_CUBISM_CORE_URL` 可换镜像）；Hiyori 为 Cubism 官方 sample，许可见 `public/live2d/hiyori/LICENSE.md`。

## 已知限制（Tauri 迁移待办）

- **未保存弹窗无法自动移动光标到「保存并离开」**：浏览器没有任何移动系统光标的 JS API（安全限制，防 clickjacking）。假光标替身方案被否——动画期间用户若移动鼠标会跳回真实位置，且光标未动时点击仍落在原位。迁移 Tauri 后用 `WebviewWindow.set_cursor_position()` 直接实现。

