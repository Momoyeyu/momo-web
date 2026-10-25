# Cordis 插件宿主

Python 是唯一内核：生活记录、推理、记忆、队列和活动决策均由它负责。这个 Node 子进程只管理审核过的插件、常驻 MCP 连接和可取消的活动，不自行生成回答。`npm ci --ignore-scripts` 后执行 `npm test`；开发入口为 `node src/index.mjs`，由内核通过私有 stdin/stdout 启动。

依赖锁定为 Cordis `4.0.0-rc.12` 与 MCP TypeScript SDK `1.32.2`。Cordis 的服务注入和 `ctx.effect` 回收管理每个插件的连接；禁用时先撤下工具与执行入口，再等待 scope 释放。没有加载任意 JavaScript 插件的接口；Cordis scope 也不构成权限沙箱。

## 本机协议 v1

每行一个 JSON。stdout 只包含协议，传输错误不输出服务地址、响应体、headers、env 或子进程 stderr。每个请求都有唯一 `id`，事件没有 `id`。Python 必须立即持久化事件；宿主内存仅保留最近 500 条回执用于短暂补读。

```json
{"v":1,"id":"1","method":"hello","params":{"coreInstance":"core-uuid","token":"32-character-or-longer-per-run-secret","heartbeatMs":5000}}
{"v":1,"id":"1","ok":true,"result":{"hostInstance":"host-uuid","protocolVersion":1,"heartbeatMs":5000}}
{"v":1,"id":"2","token":"same-secret","method":"heartbeat","params":{"activityEpoch":1}}
```

`hello` 仅可成功一次；后续所有请求验证 token。token 经私有管道传递，不进入命令行、工具声明或文件。每个宿主进程生成新的 `hostInstance`，不能复用旧许可。每次副作用需要：

```json
{"coreInstance":"core-uuid","hostInstance":"host-uuid","activityEpoch":1,"runId":"run-uuid","commandId":"command-uuid","expiresAt":1790000000000}
```

`expiresAt` 是 Unix 毫秒，最长 30 秒。`commandId` 在进程内不可重复执行；达到 10,000 个命令时拒绝新命令，待内核持久化并核对回执后重启宿主。实例与代际也是幂等边界的一部分；内核仍须通过持久 outbox 防止跨进程重放。

| 方法 | params / 返回 |
| --- | --- |
| `heartbeat` | `{activityEpoch}` → `{hostInstance,activityEpoch,paused}`。首个心跳初始化许可，之后只续租，不解除暂停。 |
| `revoke` | `{activityEpoch:更大代际}` → `{stopped,unknownExternal,reason,activityEpoch}`。立即关执行 gate，取消活动和在途 MCP 调用，关闭涉及的连接，之后才 ACK。 |
| `grant` | `{activityEpoch}`。仅成功 revoke 且 `stopped:true` 后允许显式恢复；失联心跳不会自动恢复。 |
| `plugins.configure` | `{plugins:[config],configurationRevision?,tolerateErrors?}`。完整期望集合；相同、健康的配置保留连接；缺失、变更或禁用立即撤下 gate，再释放自己的 scope。较旧配置版本不覆盖新版本；容错模式返回 `failures:[{id,code}]` 并继续启动其他插件。 |
| `plugins.listTools` | 返回 `{version,tools}`；名称为 `pluginId__originalName`，附原始名称和 JSON schema。服务的 catalog 变更通知会更新版本。 |
| `plugins.callTool` | `{name,arguments,permit}` → `{result,receipt}`。取消返回 `CANCELLED`，记录 `unknown`，不假定外部副作用回滚。 |
| `virtual.receive` | `{messageId,accountId,text}` → `{accepted:true}`，发出 inbox 事件，不进行推理或外发。持久去重由内核完成。 |
| `virtual.deliver` | `{text,permit}` → 回执；只是验证外发 gate 的虚拟入口。 |
| `virtual.activityStart` | `{permit,tickMs?}` → `{commandId,started:true}`，可观察的虚拟长活动。 |
| `virtual.activityRenew` | `{permit}`。必须同一 run / command 且仍在活动中，显式续授权，不借心跳扩大权限。 |
| `virtual.activityStop` | `{commandId?}` → `{stopped,ticks}`，停止完成后返回。 |
| `receipts.list` | `{after:seq}` → `{receipts,oldest,latest}`；发现序号缺口应核对事实，不能盲目重放。 |
| `status` | 实例、代际、暂停状态、活动、在途数量和插件连通状态；不包含凭据和配置。 |
| `shutdown` | 关闭 scopes 与自有连接；stdin EOF / SIGTERM 同样触发退出。 |

成功为 `{v,id,ok:true,result}`，失败为 `{v,id,ok:false,error:{code,message}}`。事件为 `{v,event,data}`，包括 `inbox`、`receipt`、`activity.tick`、`activity.stopped`、`tools.changed`、`host.paused`。回执固定携带原来的 `coreInstance / hostInstance / activityEpoch / runId / commandId`；过时代际的已知执行结果仍记录 `stale:true` 的事实，不能据此继续规划或改写当前对话。

## 插件配置

虚拟插件：`{id:"virtual",type:"virtual",enabled:true}`。MCP 插件：

```json
{"id":"example","type":"mcp","enabled":true,"transport":"stdio","command":"node","args":["/absolute/path/server.mjs"],"env":{},"cwd":"/absolute/path","timeoutMs":15000}
```

网络传输使用 `transport:"streamable-http"` 或 `"sse"`，提供 `url` 和可选 `headers`。这些仅通过受信任的内核管道配置，不向 LLM 暴露；stdio 子进程使用 SDK 的最小默认环境，再加该插件的显式 env。开启 / 关闭另一个插件不会重建已有健康连接。

独立 watchdog 默认 5 秒未收到内核心跳就暂停、撤销代际、停止活动。stdio MCP 的自有进程会关闭；网络 MCP 取消无法保证远端副作用停止，存在在途请求时 `revoke` 返回 `stopped:false,unknownExternal:true`，要求内核进入故障暂停并核对外部事实。不要将传输取消视为跨平台事务回滚。

`momoCapabilities / momoChannels / momoCredentials` 是 scope 依赖边界。首版凭据门面仅接受“不存在授权就失败”的默认行为，不伪造 OAuth 提供方；用户授权、账号绑定和安全存储由内核和后续渠道计划实现。LLM、记忆门面暂不向内置插件开放，没有第二套推理路径。

Python 的 `core/mcp.py` 只投影目录并通过唯一协调器发出命令。设置更新是权威来源，旧回合快照不能重新启用已经禁用的插件；跨线程配置重排通过 `configurationRevision` 拦截。探测使用独立、短期宿主，不关闭真实对话的连接。

已由用户启用的一般 MCP 配置视为可信任的 `mcp.tools` 授权。审核过的渠道 / 游戏 / 电脑适配器须声明 `declaredPermissions`，另由用户明确赋予 `grantedPermissions`；有效权限还要与当前活动相交。面对面模式禁止 `channels.send / activities.game / activities.computer`。这无法识别任意一般 MCP 服务器的隐藏副作用，也不构成权限沙箱；后续平台适配器不能将活动伪装成一般工具绕过此边界。

内核 `core/credentials.py` 提供最小受控存储：随机不透明 ref、插件与已验证账号绑定、声明 / 授予 / 当前活动三重权限检查、过期与撤销。文件位于生活目录外的忽略路径 `.workbuddy/credentials/<profile>/`，目录 0700、文件 0600，默认备份不包含它。首版没有 OAuth / OIDC 交换端点，不能仅凭昵称、邮箱或登录成功推定获得平台聊天权限；具体提供方须在专项计划接入和验证。

## 已验证的上游契约

- [Cordis Fiber](https://github.com/cordiverse/cordis/blob/main/packages/core/src/fiber.ts)：`ctx.effect()` 归属 scope；异步 effect 的启动需要等待，`fiber.dispose()` 等待释放。实际安装包的 `lib/fiber.d.ts` 与生命周期测试共同校验锁定版本。
- [Cordis Registry](https://github.com/cordiverse/cordis/blob/main/packages/core/src/registry.ts)：插件 `inject`、服务依赖和 `fiber.await()`。
- [MCP SDK 1.32.2 Client](https://github.com/modelcontextprotocol/typescript-sdk/blob/1.32.2/docs/client.md)：stdio / Streamable HTTP / SSE 常驻连接和关闭。
- [MCP SDK 1.32.2 Protocol](https://github.com/modelcontextprotocol/typescript-sdk/blob/1.32.2/docs/protocol.md)：`callTool` 的 AbortSignal 取消；取消不意味着远端动作未发生。
