# 桌面整合的实现边界

本轮以 app/migration/momo-web-baseline.json 冻结的源码快照为基线，包含 001–005、008、009 的实际交付及审查修复，旧 Rust 编排 / app/web 已退出活跃目录。源码中的未提交验收改动也纳入逐文件 SHA-256；原 momo-web 工作区与运行服务不受替换影响。

React 游戏界面和 Python/FastAPI 业务保持原行为。Tauri 只承担窗口、单实例、应用目录、受控 sidecar 和退出清理，不在迁移同时重写业务。

## 桌面运行契约

- Rust 启动本应用打包的后端，向其传递独立 v2 用户数据目录、只读资源目录以及进程内随机凭据。
- 后端绑定 loopback 随机端口，输出带启动 nonce 和子进程 PID 的就绪帧；Rust 校验本次拥有的进程与鉴权健康响应后，主窗口通过 get_runtime IPC 取得地址 / 令牌。
- HTTP 带鉴权头；ASR WebSocket 用第一帧鉴权，不将令牌置于 URL、日志、用户配置或存档。CORS / Origin 限定已支持的稳定 WebView 来源。
- 退出只清理本应用的后端与 MCP 子进程，重复启动聚焦已有窗口；父进程失联时后端终止，不扫描并杀死占用某端口的外部服务。

## 安装资源与用户数据

资源包含默认 Hiyori、动作 / 表情、字体、Cubism Core、SenseVoice / VAD 与 E5。ASR / embedding 的固定校验包在初始安装时解压，运行时不下载。依赖与资源不依赖开发目录或用户已安装的 Python / Node。

配置、记忆、会话、存档、参考音及浏览器导入模型属于用户数据，分别进入 OS 的应用数据目录和稳定 WebView 存储，不混入源码或安装包。旧 Rust 用户目录不自动覆盖。

显式迁移使用一致性 SQLite 备份与带版本 / 校验的归档，包含 YAML、参考音和 IndexedDB 模型 ZIP；导入校验路径和体积、失败回滚。测试使用独立临时目录。

## 验收口径

浏览器测试、tauri dev、冻结后端 smoke、原生桌面 E2E 与安装产物验证分别报告。当前先以 macOS arm64 完成体验和用户验收，再单独推进 Windows x64；Linux 次要且可选，不做手机 / 平板应用。不为每次体验迭代重建整个历史平台矩阵；未运行的平台不标通过。早期实验 MVP 已公开归档，废弃通用基础设施仓库、本地检出与旧站已清退；当前产品与可选 TTS 部署统一在本仓库维护。

## 从干净源码构建

本轮实际最低基底：macOS 14（已锁定 ONNX Runtime 的动态库最低版本）、Linux glibc 2.36 / WebKitGTK 4.1。Windows x64 的原生构建与安装验收仍须实测，不用 WSL 的推理结果代替。macOS 测试应用采用 ad-hoc 签封，未做 Developer ID 公证，不作为公开正式发行版。

已验证的 Linux 候选使用 Debian 12 / Python 3.11 构建；最低 glibc 取决于冻结后端所在的系统。手动 CI 的 Ubuntu 24.04 候选使用较新的 glibc，不能据此宣称兼容 Debian 12。CI 仅生成 DMG、NSIS、DEB 三种候选格式，其他格式尚未验收。

使用 Python 3.12、uv、Node 24、pnpm 12.6 和稳定 Rust；Linux 另需 WebKitGTK / GTK / 系统构建依赖，Windows 需 MSVC 与 WebView2。以下命令从仓库根目录运行；模型下载发生在构建机，安装后的玩家不执行这些命令。

```sh
uv sync --project app/backend --frozen
pnpm --dir app install --frozen-lockfile
pnpm --dir app/frontend install --frozen-lockfile
uv run --project app/backend --frozen python app/backend/scripts/download_asr_models.py
uv run --project app/backend --frozen --with huggingface-hub==2.2.0 python app/backend/scripts/prepare_embedding.py
uv run --project app/backend --frozen python app/backend/scripts/package_resources.py --output app/dist/momo-resources.zip
uv run --project app/backend --frozen python app/scripts/prepare-models.py app/dist/momo-resources.zip
uv run --project app/backend --frozen python app/scripts/prepare-core.py
uv pip install --python app/backend/.venv pyinstaller==6.20.0
uv run --project app/backend --frozen python app/scripts/freeze-backend.py
uv run --project app/backend --frozen python app/scripts/smoke-frozen.py app/resources
pnpm --dir app test:shell
pnpm --dir app build
```

macOS 的 SSH / 无 Finder 构建环境使用 `pnpm --dir app build:macos`，会验证签封后用 hdiutil 制作普通 DMG；不用 Finder AppleScript 排版。原生 E2E 使用 `pnpm --dir app build:e2e` 与 `pnpm --dir app test:native`，测试专用 identifier / 数据目录与正式版分离。正常发行依赖树不包含驱动插件。测试脚本通过真实 WebView 的标准 WebDriver 接口调用 IPC，不依赖旧版 JS mock 注入。

当前不支持 `tauri dev` 原生热更新：开发服务器来源与原生固定来源不同，debug 资源目录也未接入安装资源流程。`pnpm --dir app dev` 会给出说明并退出，不以放宽发行版鉴权来绕过。界面和业务开发仍使用独立浏览器前后端；原生壳的验证使用上面的实际构建 / E2E 路径。

```sh
# 两个终端分别运行；先准备离线资源，数据目录应使用自己的测试目录。
MOMO_DATA_DIR=/tmp/momo-dev MOMO_RESOURCES_DIR="$PWD/app/resources/models" uv run --project app/backend --frozen uvicorn app.main:app --app-dir app/backend --host 127.0.0.1 --port 7822
MOMO_WEB_API_UPSTREAM=http://127.0.0.1:7822 pnpm --dir app/frontend dev --host 127.0.0.1 --port 5174
```

完整浏览器回归使用 `node app/scripts/browser-e2e.mjs`，自动创建合成配置 / 会话并回收测试服务；只验证启动可加 `--smoke`。测试准备与 opt-in 条件见 [浏览器测试说明](../../app/frontend/e2e/README.md)。

官网独立在 `site/` 使用 pnpm 安装、test / build / test:browser。品牌 SVG 原稿在 `brand/`，应用和官网使用相同副本；原生图标从 `brand/momo-icon.svg` 生成。CI 的 native workflow 只上传候选产物，不自动公开发行。

## 启动画面

`frontend/index.html` 的本地 HTML / SVG / `public/startup.css` 在 React 初始化前直接显示。`src/startup/presence.ts` 只在运行时连接、恢复记录、就绪 / 失败时更新状态；CSS 承担动画，不计算虚构进度，不等待远端服务或额外预热模型。React 首次提交后释放 root 的 inert / aria-hidden，再短淡出移除启动层；减少动态时直接移除。错误界面使用固定三语文案，不渲染原始异常，重试重新加载当前窗口。

`e2e/18-startup-presence.spec.ts` 在隔离来源中控制启动延迟与故障，验证阶段、动作、语言、错误重试和去遮挡；`scripts/startup.e2e.mjs` 检查实际安装资源和正常 / 刷新后的可交互状态。当前只验收 macOS。

## 早期 MVP 的开发档迁移

此段仅供维护者处理 momo-web 实验数据，不属于面向玩家的使用指南。

旧版 momo-web 没有新的整包导出入口。先停止旧后端并复制它的完整用户数据目录（包含配置、参考音和 SQLite / WAL）；保留原目录作为回退。使用新仓库的浏览器开发模式，以复制目录作为 MOMO_DATA_DIR 启动后端，并在原来的浏览器来源（包括端口）打开新前端。这样导出入口才能同时读取复制的后端数据和该来源 IndexedDB 中的形象。

在设置中导出归档，退出临时开发服务，然后在桌面版导入。两边都先保留备份；确认对话、记忆、形象、参考音和存档完整后再处理旧目录。不要同时用两个后端写同一个数据目录，也不要把原目录直接交给迁移测试。
