# 运行配置

玩家只配置 LLM 和可选 TTS；语音识别与 embedding 内置。thinking 默认关闭，按已支持供应商协议启用。配置由应用数据目录中的 momo.yaml 管理，配置契约与示例在本仓库维护。

| 变量 | 用途 |
| --- | --- |
| MOMO_DATA_DIR | 显式隔离的应用数据目录；桌面壳自动传入 v2 路径，测试必须使用临时目录 |
| MOMO_RESOURCES_DIR | 已安装的只读 ASR / embedding 资源根目录；不含用户数据 |
| MOMO_ASR_MODELS | 仅开发调试覆盖 ASR 目录，普通用户不需要设置 |
| MOMO_DESKTOP_TOKEN | 桌面壳临时随机令牌，仅传入子进程环境；不写配置 / URL / 日志 |
| MOMO_DESKTOP_NONCE | 本次受控子进程就绪握手挑战，仅当前运行有效 |

桌面入口接受 --data-dir、--resources-dir、--port 0；地址由后端自行绑定并回传。浏览器开发实例保持显式的本地开发端口，不能被桌面壳误认成自有后端。

应用前端通过统一 runtime adapter 访问 REST、SSE、上传、探测和 WebSocket。测试驱动只允许进入测试构建，正式发行包不得带远程控制接口。

测试专用变量：`MOMO_E2E_BASE_URL` 必须显式指向隔离浏览器实例；`MOMO_E2E_APP` 可覆盖测试构建可执行路径；`MOMO_E2E_LLM_CONFIG` 指向仅供真实模型 opt-in 原生 E2E 的私有 JSON 配置，`MOMO_BROWSER_LLM_CONFIG` 为浏览器真实模型用例提供私有 YAML。

`MOMO_E2E_SETUP=1` 启用 `setup.e2e.mjs` 的首次连接验证，需单独选择该 spec，并使用全新的测试 identifier / 数据目录；不能接入已有玩家档。先验证错误模型不保存、不进入对话，再用上述私有 LLM 配置验证真实健康检查与后续对话。

`MOMO_E2E_TTS_CONFIG` 可单独启用原生真实 GPU 语音测试，JSON 字段为 `url`、可选 `key` / `prompt`、本地参考音绝对路径 `reference` 与可选文件名 `referenceName`。它使用固定对话供应商，观测实际 PCM 播放、采样率、播放完成和打断恢复，并将受控合成语音送入打包后的 SenseVoice 验证识别；不需要调用付费 LLM。运行时只使用隔离测试档。这些文件不属于玩家配置，不随安装包或测试报告交付。

## v3 Web / 插件宿主

Web 仓路径为 `frontend/`、`backend/`、`plugin-host/`；以下配置在根 `.env.example`。默认用 `pnpm dev`，无需手填 token。

| 变量 | 用途 |
| --- | --- |
| MOMO_API_PORT / MOMO_WEB_PORT | 启动器本机端口，默认 7821 / 5173；占用则退出，不杀其他服务 |
| MOMO_WEB_ORIGIN | 启动器生成的精确 127.0.0.1 源，用于鉴权 / CORS；不开放任意公网来源 |
| MOMO_NODE | 仅开发覆盖 Node 可执行文件；正式包强制使用随包 runtime，不依赖系统 PATH |
| MOMO_PLUGIN_HOST | 仅开发覆盖私有宿主入口；正式包固定随包代码 |
| MOMO_TEST_VIRTUAL | 仅隔离测试为 1 时启用虚拟入口 / 活动；正式应用默认不启用 |

默认 Web 数据 `.workbuddy/dev-data/`，与桌面正式 profile 隔离；同目录第二内核会被 OS 锁拒绝。Web 代理持有一次性 `MOMO_DESKTOP_TOKEN`，不放入 `VITE_*`、浏览器存储或 URL。生产仍由 Tauri 提供临时 capability。

后端开发环境由 `backend/.python-version` 固定为已验证的 Python 3.14，使用 `uv sync --frozen` 建立；不会随机器默认 Python 自动切换。
