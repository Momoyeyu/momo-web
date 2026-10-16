# 集成测试（Playwright）

浏览器端到端测试，覆盖标题页 / 设置 / 人设 / 记忆 / 存档 / 对话 / backlog 的现有能力。

## 为什么不用 `webServer`

测试**直接打你正在跑的开发实例**（`http://localhost:5173` → backend `:7821`），
不另起服务——tts / asr / embedding 也复用 mac-studio 那套，测试不碰它们。

因此所有会写状态的用例都必须**用完还原**（见 `helpers.ts` 的 `useStateRestore`）：

| 数据 | 位置 | 处理 |
|---|---|---|
| 配置（语言/滑块/开关/人设/拓展） | `momo.yaml` | `beforeEach` 快照 `/api/state`，`afterEach` 原样 PUT 回去；并先固定界面语言为 zh 保证选择器确定性 |
| 记忆 | `momo.db` | 只做「建 → 断言 → 删」，另有 `e2e-` 前缀的 API 兜底清理 |
| 存档槽 | `momo.db` | 只动自己新建的槽，用完删除 |

### 有意不测的两个能力

「读档」与「开始新会话」都会把当前 live 会话**快照进 AUTO 槽**
（`service/checkpoint.py` 的既有语义），而 AUTO 槽里可能有你自己的存档、
且没有 API 能还原。所以 `05-checkpoint.spec.ts` 只验证这两个模式的渲染与禁用态，
不实际执行。要覆盖它们请用隔离实例：

```bash
MOMO_DATA_DIR=/tmp/momo-e2e uvicorn app.main:app --port 7822   # backend/app 下
MOMO_WEB_API_UPSTREAM=http://127.0.0.1:7822 pnpm dev --port 5174   # frontend 下
MOMO_E2E_BASE_URL=http://localhost:5174 pnpm e2e
```

## 跑

```bash
cd frontend
pnpm e2e            # 全量（约 1 分钟）
pnpm e2e --ui       # 交互模式
pnpm e2e 03-memory  # 单个 spec
```

首次需装浏览器：`pnpm exec playwright install chromium`

## 已知残留

`06-chat.spec.ts` 会真实发出一个回合（`/api/chat` 必然写 live）。`afterEach` 用
`/api/chat/interrupt` 撤掉 assistant 行，但 **user 行没有 API 可删**，所以每跑一次
live 会多一条固定的 user 文案（`只回复四个字：测试通过`）。介意的话跑完用
`MOMO_DATA_DIR` 隔离实例，或按上文自行清理。
