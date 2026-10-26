# momo · Web 开发预览

**Can you feel my heart?**

momo 是一个逐渐熟悉你的 AI 伙伴。这是 v3 的 Web 体验迭代仓；已发行桌面应用、官网与 TTS 部署在 [momo](https://github.com/Momoyeyu/momo)。当前 v3 是开发预览，尚未作为正式版本发布。

[产品主页](https://momoyeyu.github.io/momo/) · [开发与验证](docs/development/v3-runtime.md) · [晋级桌面快照](docs/development/web-promotion.md)

## 这一版

- **同一个 momo**：只有一段持续关系，聊天自动保存；可以回顾历史、管理长期记忆和导出整份备份。
- **面对面见面**：见面由服务端租约协调，切到设置 / 历史仍保留见面；退出后才释放。多窗口不会各自抢着生成。
- **可停止的拓展**：Python 保留唯一推理与记忆，Cordis 管常驻插件、MCP 连接与可撤销执行。当前用虚拟入口验证底座，QQ / 微信 / Minecraft 尚未接入。
- 继续保留 soul、逐句表情 / 动作与语音同步、初次见面、中英日界面，以及内置 ASR / embedding。

完整历史与模型上下文分开保存，压缩不删除原文。下一步将与项目维护者共同研究上下文管理，尤其是长期目标、压缩质量与记忆的配合。

## 本机开发

需要 Node.js 22.23.3 或更新的兼容版本、pnpm 12.6 与 uv；后端 `.python-version` 固定本轮已验证的 Python 3.14。生产桌面包自带运行时；Web 预览是本机开发入口，不是可直接公开部署的多人服务。

```sh
cd backend && uv sync --frozen && cd ..
cd frontend && pnpm install --frozen-lockfile && cd ..
cd plugin-host && npm ci && cd ..
python3 scripts/prepare-core.py
python3 scripts/prepare-models.py /absolute/path/to/momo-resources.zip
pnpm dev
```

`prepare-models.py` 需要显式传入与 `scripts/offline-resources.json` 匹配的固定资源包。已有安装资源时可跳过该步，用 `MOMO_RESOURCES_DIR` 指向包含 `resource-manifest.json` 的资源根目录再启动。从上游源码准备模型见 [资源构建说明](backend/resources/README.md)；下载只发生在开发 / 构建阶段，运行中不下载模型。

打开终端显示的本机地址，首次见面时连接兼容 OpenAI 格式的 LLM API；TTS 可稍后配置。

默认预览数据在 `.workbuddy/dev-data/`，与桌面数据分开。启动器会检查端口、独占本目录、生成临时鉴权并管理自己启动的进程。端口被占用时明确退出，不杀其他服务；Ctrl+C 会回收自己的内核和插件进程。

## 验证

```sh
node frontend/node_modules/typescript/bin/tsc --noEmit --project frontend/tsconfig.json
cd frontend && node node_modules/vitest/vitest.mjs run && cd ..
cd backend && .venv/bin/python -m pytest -q && cd ..
npm --prefix plugin-host test
backend/.venv/bin/python -m pytest scripts/test_promote.py -q
node scripts/browser-e2e.mjs
```

真实供应商、内置模型推理与原生安装包另行显式验证；模拟供应商通过不代表真实 LLM / TTS 已通过。测试使用临时数据，不会读取玩家聊天。详细命令与边界见开发文档。

## 两仓如何协作

当前直接在本仓库 `master` 修改、提交和推送，通过当前提交的 GitHub CI 后交维护者体验。整个 v3 阶段只推进 Web；等维护者明确要求时，再以固定 Git revision 用 `scripts/promote.py` 一次性导入 momo 的 `app/`，清单记录来源与哈希，目标漂移时拒绝覆盖。原有 momo 作为将来同步的基线。

旧 Web 实验工作区和它的未提交源码已保全，恢复开发不会覆盖原数据。请勿在两仓分别修改同一份共享代码，或让两个内核共用同一生活目录。

## 数据、素材与许可

用户配置、API 密钥、聊天、记忆、录音与自选参考音不进入 Git 或安装包。没有默认角色参考音频；玩家自行提供有权使用的素材。Hiyori、Cubism Core、字体和离线模型适用各自许可，见 [第三方声明](THIRD_PARTY_NOTICES.md)。项目代码采用 [MIT](LICENSE.md)。

问题与改进建议欢迎通过 [Issues](https://github.com/Momoyeyu/momo-web/issues) 提交；报告时隐藏密钥与私人对话，并注明复现步骤、系统和 revision。
