# 浏览器回归测试

Playwright 验证共享 React 界面，不替代真实 Tauri WebView 或安装产物验收。必须指定隔离实例的 `MOMO_E2E_BASE_URL`；禁止连接玩家正在使用的实例。部分旧用例会改 live / AUTO / 配置，不能依靠事后删除几条记录保证安全。

先按[桌面迁移](../../../docs/development/migration.md)准备固定 Core 和离线模型，默认位置为 `app/frontend/public/live2d/` 与 `app/resources/models/`。从仓库根目录准备测试依赖：

```sh
uv sync --project app/backend --frozen
pnpm --dir app/frontend install --frozen-lockfile
pnpm --dir app/frontend exec playwright install chromium
```

使用仓库内的隔离启动器：

```sh
# 只验证启动、标题和路由（4 项），不代表完整回归通过
node app/scripts/browser-e2e.mjs --smoke
# 完整浏览器回归（含真实模型 ZIP / YAML / SQLite 备份恢复）
node app/scripts/browser-e2e.mjs
```

启动器创建新的临时数据目录，预置合成会话与仅绑定回环地址的确定性模型服务，并显式设置 `MOMO_E2E_BASE_URL`。它禁用真实供应商 opt-in，不读取玩家配置；退出或中断时只清理自己启动的子进程。日志和 Playwright 证据默认保留在 `app/target/browser-e2e/`，临时数据路径会打印出来。端口占用会直接报错，不终止其他服务。

可用 `--api-port 7822 --web-port 5174` 调整端口、`--resources-dir PATH` 指定已准备的离线模型目录，或用 `--evidence-dir PATH` 指定证据目录。需要单独调试用例时，在自行启动的隔离实例上设置 `MOMO_E2E_BASE_URL`，再执行 `pnpm --dir app/frontend test:e2e`。真实 LLM / TTS 用例须单独 opt-in；真实浏览器模型用例另以 `MOMO_BROWSER_LLM_CONFIG` 指向私有测试配置 YAML，不默认读取 `backend/data/momo.yaml`。不要将私人配置和会话放进测试产物。

原生 E2E 在 `app/scripts/*.e2e.mjs`，通过 `build:e2e` / `test:native` 驱动实际应用，使用独立 identifier / 数据目录。真实供应商验证另需 `MOMO_E2E_LLM_CONFIG` 私有配置文件，默认跳过；不将密钥放到源码或控制台。完整构建步骤见 [桌面迁移](../../../docs/development/migration.md)。
