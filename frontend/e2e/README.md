# 浏览器回归测试

Playwright 验证 Web 的 React 界面。必须指定隔离实例的 `MOMO_E2E_BASE_URL`；禁止连接玩家正在使用的实例。用例会修改配置与连续记录，不能依靠事后删除几条记录保证安全。

先按 [Web 开发说明](../../README.md#本机开发) 准备固定 Core 和离线模型，默认位置为 `frontend/public/live2d/` 与 `resources/models/`。从本仓库根目录准备测试依赖：

```sh
uv sync --project backend --frozen
npm --prefix plugin-host ci --ignore-scripts
pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend exec playwright install chromium
```

使用仓库内的隔离启动器：

```sh
# 只验证启动、标题和路由（4 项），不代表完整回归通过
node scripts/browser-e2e.mjs --smoke
# 完整浏览器回归（含真实模型 ZIP / YAML / SQLite 备份恢复）
node scripts/browser-e2e.mjs
```

启动器创建新的临时数据目录，预置合成会话与仅绑定回环地址的确定性模型服务，并显式设置 `MOMO_E2E_BASE_URL`。它禁用真实供应商 opt-in，不读取玩家配置；退出或中断时只清理自己启动的子进程。日志和 Playwright 证据默认保留在 `target/browser-e2e/`，临时数据路径会打印出来。端口占用会直接报错，不终止其他服务。

可用 `--api-port 7822 --web-port 5174` 调整端口、`--resources-dir PATH` 指定已准备的离线模型目录，或用 `--evidence-dir PATH` 指定证据目录。需要单独调试用例时，在自行启动的隔离实例上设置 `MOMO_E2E_BASE_URL`，再执行 `pnpm --dir frontend test:e2e`。真实 LLM / TTS 用例须单独 opt-in；真实浏览器模型用例另以 `MOMO_BROWSER_LLM_CONFIG` 指向私有测试配置 YAML，不默认读取玩家配置。不要将私人配置和会话放进测试产物。

当前整个 v3 阶段只推进 Web。最终同步与桌面验收等维护者明确要求后再做，不属于本轮浏览器回归。

`21-runtime-meeting.spec.ts` 需要额外设置 `MOMO_RUNTIME_SMOKE=1`，直接使用真实 Python / Cordis，不由页面拦截模拟见面接口。分别准备未配置的新资料和已有合成对话的资料，覆盖错误 API 拦截、多窗口独占、设置 / 历史刷新续接。默认的合成套件通过不能替代这组运行时检查。
