# Windows 原生候选验证

目标为 PC x64。本轮验证环境是 Windows 11 26200 / WebView2 155；不据此承诺 Windows ARM64、Windows 10 实机或缺少 WebView2 的干净 VM 已通过。详细结果见 [011 验证记录](../../evaluations/2026-10-23-windows-candidate.md)。

## 构建

按 [迁移边界](migration.md) 准备 Node / pnpm、uv、Rust MSVC、Visual Studio C++ 工具链和固定资源。后端必须在 Windows 上冻结，不能复制 macOS 的 sidecar。

在 `app/` 运行：

```powershell
uv run --project backend --frozen python scripts/freeze-backend.py
uv run --project backend --frozen python scripts/smoke-frozen.py resources
pnpm exec tauri build --bundles nsis
```

冻结步骤会使用已安装的 Visual Studio redistributable、复制其许可并审计依赖与导出。安装器包含离线 WebView2 安装资源、固定模型与运行依赖。无需给客户端配置 GPU；外部 GPT-SoVITS 是独立服务。

## 安装与 E2E

1. 先安装真实 NSIS 产物，验证普通生产进程：窗口、重复启动、正常退出、强制退出后的自有后端回收。升级前备份原有数据。
2. `pnpm build:e2e` 生成另一个 target 下的测试构建；仅本构建启用 WebDriver。复制实际安装目录到专用测试目录，只替换其中的 `momo.exe` 为测试构建，保留安装得到的全部资源。
3. 将 `MOMO_E2E_APP` 指向该测试目录的可执行文件，运行 `pnpm test:native`。测试应用标识为 `dev.momo.app.e2e`，不可指向正式玩家目录。
4. 测试新用户时，同时隔离 `%APPDATA%/dev.momo.app.e2e`（后端）和 `%LOCALAPPDATA%/dev.momo.app.e2e`（WebView）。关闭测试进程后才可清理；不能用正式标识替代路径。

`setup.e2e.mjs` 的首次配置检查应在独立的新档案运行。启用 `MOMO_E2E_SETUP=1`；真实模型和 TTS 分别通过 `MOMO_E2E_LLM_CONFIG`、`MOMO_E2E_TTS_CONFIG` 指向私有 JSON。参考音频也只在测试目录，绝不放入资源目录或提交。测试后回收证据、删除临时凭据与档案。

原生认证 smoke 会调用打断接口验证 generation 响应头；在首次见面前，这会按契约取消待播放的开场。后续用户流程不能再等待已取消的台词，但仍须验证名字记忆、真实对话和存档恢复。此契约有后端独立测试覆盖。

浏览器测试与原生测试不能相互替代；真实音频检查使用合成语音输入 ASR，避免采集环境录音。已安装运行时的机器也不能代替缺依赖的干净 VM。
