# 007 — Autonomous, continuous Minecraft play

Approved replacement specification, 2026-11-13. Status: implementation in progress; not accepted/done. This is the single active implementation specification. Historical plan and research are evidence, not competing designs.

## Product contract

Control the player's existing Fabric Java 1.21.1 client, account and world. No extra client/account, Docker, Bash, arbitrary generated script, cheats or second reasoning personality. Vanilla common gameplay is supported; modded mechanics are best effort with explicit unsupported feedback. Use normal player knowledge, visible discoveries and exploration memory; collision navigation is allowed, underground resource scanning is not. Unified gameplay permission includes PvP. Target continuous normal-player combat rather than competitive win rates.

The player can say "play on your own" and see sustained, meaningful action without low-level instructions. Game progression, curiosity, aesthetics, helping, social play and rest can all be goals. Local physical execution continues during conversation while every model decision uses the existing single Python coordinator.

```mermaid
flowchart TB
  Context[Personality / memories / player / world] --> Brain[Single momo coordinator]
  Brain --> Goal[Durable goal and bounded skill plan]
  Goal --> Host[Cordis permission and lifecycle]
  Host --> Body[Fabric task executor]
  Body --> Nav[Baritone API navigation / mining / building]
  Body --> Skill[Inventory / crafting / combat / interactions]
  Nav --> Tick[Continuous game tick]
  Skill --> Tick
  Tick --> Reflex[Local survival and control arbitration]
  Reflex --> Tick
  Tick --> Events[Progress / success / blocked / failure]
  Events --> Brain
  Stop[User takeover / stop / Home / revoke] --> Body
```

## Runtime and interfaces

Retain local authentication, world/account binding, activity epochs, vision eligibility and revoke barriers. Replace short key pulses as the primary API with capabilities, observe, submit, events, cancel/stop. A submit receipt means accepted, never completed. Tasks have queued/running/paused/succeeded/failed/cancelled states and state-based result evidence. One physical owner, bounded queued work, ordered event cursors and snapshot recovery after a gap. Lost replies are reconciled by task ID rather than replaying effects.

Game-thread code must not block on model, HTTP, screenshot encoding or large path search. Input control advances on healthy game ticks; path work uses Baritone's worker machinery. Task heartbeat is independent of model response; identity changes, disconnect, Home, revoke and takeover release controls and clear pending actions. Stop cannot activate reflexes or restart work. Menus pause valid tasks; death terminates execution and returns the decision to momo. Food, shields, weapons and combat coordinate through a single body arbiter.

Plans compose typed skills with bounded sequences, conditions and retries. No arbitrary JS. Keep low-level GUI/slot controls for uncommon mechanics, with honest capability reporting. Replace the old per-minute micro-action count with separate queue, work, time and event budgets.

## Capability matrix

| Group | Required behavior |
| --- | --- |
| Observe/explore | Visible terrain/entities/hazards, own state/inventory/screens, explored memory, unknown/unreachable |
| Navigate | Walk/sprint/jump/sneak/swim/climb/follow/detour/stuck recovery |
| Gather/build | Correct tools, mine until block changes, collect drops, place/build/light with legal reach/materials |
| Inventory | Stack/split/transfer/drop/hotbar/armor/offhand/durability |
| Craft/process | Recipes, player/workbench grids, furnace and vanilla processing screens, real material checks |
| Combat/survival | PvE/PvP pursuit, melee/ranged/shield, eat/equip/retreat/hazard response |
| World | Doors/beds/workstations/containers/entities/farming/transport/dimension transitions |
| Special vanilla | Enchant/brew/trade/anvil with semantic adapters and low-level UI composition |
| Social | Chat, give items, cooperate/follow/help, change goals |

Mechanics are reusable; objectives are not hardcoded recipes such as always acquiring diamonds. No /give, teleportation or creative/admin fallback.

## Goals and presentation

Goal records include source/reason/target/constraints/status/progress/evidence/next step. Important events trigger replanning; one no-event review at most per 30s, no unnecessary model call when nothing changes. Survival is local. Goal snapshot survives context compaction; meaningful experiences enter existing memory, ticks do not. Restart restores intentions only, never authority or side effects. Revalidate world/account/permissions/state before continuation. In-game text is untrusted.

Reuse existing activity entry and plugin cards: start, pause/resume, stop/handoff; show goal/current action/blocked reason, reveal detail on demand. Support zh/en/ja. Keep internal JSON/diagnostics out of dialogue. Chat changes or stops work through the same coordinator; no additional game LLM or history.

## Milestones and evidence gates

1. Pin Baritone 1.21.1 API artifact with checksum/source/license. Compile and real-client probe navigation/gather/path continuity/cancel/takeover and normal-player perception. Do not spread implementation before compatibility is established; remove replaced simple pathing after gate.
2. Implement task engine, events, authority/input arbitration and capability matrix in grouped increments; deterministic checks and bounded real game tests, not repeated installation per small change.
3. Integrate goals/events/chat through existing coordinator, validate independent continuation without operator micro-instructions.
4. Full review, schemas, suites and exact-revision CI; promote business source, sign once with stable identity, installed model smoke and cleanup.

Installed acceptance: autonomous explore→gather→craft→use/build; containers/workstations/transport/dimensions; continuous combat/eat/retreat and authorized PvP fixture; recovery from obstacles/material shortage/full inventory/disappearance/death/disconnect; chat and compact preserve goal; button/chat/manual/Home/revoke stop and reject late effects. Verify actual items/positions/world/screen, not model narration. No step-by-step 300ms/slot hints.

On a healthy 20 TPS local game, target local danger/revoke response beginning within two ticks; no artificial LLM wait gaps during continuous skills; no new visible game stall from path/vision/transport. Record control timing separately from model API latency, plus calls/tokens and outcomes. These are targets, not achieved claims. Retain failures and known limits; archive done only after full accepted scope passes.

## Delivery

Shared source first, one business implementation, batch promotion to macOS. Preserve data/world/config, use additive goal storage, do not restore activity grants. Bundle verified dependencies with provenance/licenses, no external service maintenance. Windows follows macOS acceptance. Keep one latest installed version and necessary development artifacts. Bash and sandbox require separate justified plan and approval if future evidence changes the current decision.


## Implementation ledger — 2026-11-13

- Approved specification committed as `04279ab`, exact-source CI passed.
- Baritone official Fabric 1.11.3 artifact verified against release SHA-256 and embedded 1.21.1/identity/license metadata. Runtime preparation is build-time only, offline at packaging; no runtime downloads.
- Loom compiled real Baritone API calls; final companion nests the unmodified upstream jar (including its native-pathfinder dependency). Lifecycle tests cover local continuation, evidenced arrival, duplicate rejection, cancellation, expired lease and unreachable result. New CI compiles Fabric rather than relying only on Node mocks.
- These are build/lifecycle checks. Real client loading, continuous navigation and manual takeover probe remain pending; later capability/goal milestones have not started. No installed app replaced.

- Real-client probe: existing official launcher/account and test world, nested Baritone and native nether-pathfinder loaded. One submitted goal continued moving without model calls; an invalid-height destination returned unreachable, a valid surface goal returned succeeded/arrived. Scoped navigation disables implicit breaking/placing and restores borrowed settings. A running-task stop was checked against subsequent task/position state. These are direct bridge compatibility probes, not model autonomy acceptance. Menu pause/resume and expired-pause handling have lifecycle tests; actual human-input takeover remains pending.
- GUI tools do not enumerate the Java game window. The test used the official Quick Play singleplayer option to enter the existing temporary world; no extra account/world, inventory injection or teleportation. Launcher credentials were kept in memory and never printed/stored in source. A save-and-return-to-title click exceeded the short command timeout; ping was reconciled to confirm world exit rather than replaying it. This reinforces separating accepted receipts from long operation completion in the next task protocol.

- The temporary navigation-only lifecycle is replaced by one generic task runtime: five live tasks, idempotent request keys, queued/running/paused/terminal states, independent heartbeat with absolute lifetime, bounded ordered events and gap signal, scoped reset, and stop-uncertainty barriers. Pure-Java lifecycle tests and actual Fabric/API compilation passed. Only navigate is currently advertised; other semantic skills, host/Python continuation and the goal UI are still pending. This generic runtime has not yet been live-game smoke tested.

### 持续技能实现进度（2026-11-13，非整体验收）

Fabric 增加严格声明的语义技能与最多 24 步的本地顺序计划，可按真实库存条件执行、跳过或最多重试两次。Node 与 Fabric 共用同一份数据契约，拒绝未知字段、嵌套计划和脚本。任务结果仍需现场证据；工作站适配目前提供普通槽位 / 按钮路径，不能把 API 路径存在当作全部机制已实测。

已在现有测试存档实测：可见草方块破坏；放置工作台 → 打开 → 合成木棍（0→4）→ 关闭的一次本地连续计划。第一次放置目标与玩家碰撞，未误报成功；换到合法相邻位置后跑通。该探针直接调用执行器，不是模型自主游玩验收。

新增可见实体、已解锁配方、工作站信息；本地存档身份独立于维度，任务额外绑定实际 ClientWorld 实例。物理鼠标输入接管与最新元数据目前只完成构建检查，留待集中真实 smoke。旧短时输入和旧平面跟随仍作为迁移代码存在，正式验收前需移除被替代的控制器。

### 目标、事件续接与玩家入口

目标和实际任务回执增量存入独立表，按世界/角色隔离，不进入 009 的待压缩历史。恢复只加载意图，不重放操作。Python 的身体监视器只续租与同步事件；不调用模型；活动、账号、世界、模型能力或激活租约失效就撤回控制。事件丢失先读快照，不重新提交副作用。

自主决策使用现有 chat SSE、唯一协调器和同一人格。首次启动/任务结束触发评估，无事件最多每 30 秒复查一次；玩家交谈与展示优先。观察事件不会写成玩家说过的话。常用入口加入暂停/继续和当前目标/动作，合并原先分散的游玩权限；没有独立 PvP 开关。

当前检查：后端全量 831 通过、3 平台跳过（随后新增的上下文隔离和自动决策门控等定向 34 通过）；前端 256 通过、类型检查通过。尚未完成真实模型自主游玩、完整原版能力组覆盖或新安装版验收，007 保持进行中。

### 身体与上下文的后续收敛

旧平面跟随控制器已删除，跟随也使用同一任务队列与 Baritone 导航。新增本地生存优先级（危急脱险、持续进食、近身防御），在暂停任务后借用单一身体；停止、菜单和接管优先。截图仅在游戏线程捕获，缩放/PNG 编码移到通信工作线程。补充掉落物拾取、加工结果等待、原版商人交易，以及独立于完成证据的当前步骤进度。

世界授权标识对应存档/服务器，维度独立作为观察事实。传送门引起的 ClientWorld 切换终止当前任务并反馈，再由同一 momo 重新观察；不会把两个本地存档因同为主世界而混为同一身份。

真实模型预检发现：一次观察携带全部已解锁配方，同时请求全部技能定义，会触发 009 的预算保护。本次改为默认少量配方、按需配方查询、单技能参数查询；没有提升或绕过上下文硬上限。该预检尚未进入实际自主操作，修复后需重新做真实模型 smoke。

最近检查：Fabric 真实构建及任务/计划/生存/参数烟测通过；Node 定向 15 通过；Python 定向 39 通过；前端类型检查通过。最新身体、生存、元数据与参数查询变更尚需实际重载模组复测。

### 自主 smoke 暴露的问题与修复

当前配置的真实模型已自行提出“在草地上安个家”的目标，并执行多个连续导航任务；还发现两处实际问题，不能据此整体验收：任务提交后同轮继续轮询，最终耗尽 ReAct 轮数；路径自动拾取与后续 pickup 步骤衔接时，实体已被收走而误报失败。

协调器现于任务接收后结束本轮工具调度（必要时仅做一次无工具的自然回应），后续由任务事件继续驱动；常用技能签名随现有工具声明提供，避免每轮重复查询所有参数。停止时回收本作用域已完成的真实任务回执，未知传输结果撤销绑定，确定的本地输入错误不作未知副作用处理。专注对话会立即释放游戏控制，不再等待身体轮询。该增量已有定向回归测试，真实模型需重新复测。
