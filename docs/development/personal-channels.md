# QQ / 微信个人号桥接（004 / 005）

这是 momo 维护的官方插件，不表示腾讯官方认证。渠道通过 Python 唯一协调器收发，不创建独立的大脑。公开 OAuth 登录接口尚无已核实的普通个人号双向好友聊天权限；网页登录不等于聊天连接。

## Host 合同

仅由已认证的私有 stdio 调用；配置和令牌不进入 HTTP 状态或模型工具目录。

| 方法 / 事件 | 内容 |
| --- | --- |
| `plugins.configure` | `momo-qq` / `momo-wechat`；账号、预期自身 ID、地址、私有令牌、权限、白名单、策略版本 |
| `plugins.promptContext` | 只读的当前回合渠道说明；核验插件、账号、联系人、策略版本和实际连接身份，不返回凭据 |
| `channels.health` | 实际 ID、个人号身份、连接状态、真实能力、执行器静止证据；不返回令牌 |
| `inbox` | 来源 / 插件 / 账号 / 自身 / 联系人 / 发送者 ID、私聊类型、事件 ID、正文、策略版本 |
| `channels.ack` | 后端持久化或明确拒绝后，确认单条 inboxId |
| `channels.send` | 固定账号 / 联系人 / 正文 / 策略版本 / 单次执行许可；无原始平台 API |
| `commands.reconcile` | 核对原命令；closed_unknown 仅在执行器静止后保留未知并暂停插件 |

收发独立授权。白名单关闭不筛选，开启且为空拒绝全部。入口与最终派发重新验权。首版仅私聊文字接收 / 回复，主动发送、群聊、历史、好友与账号管理能力全部为 false。

### 模型如何知道自己在使用什么渠道

当前渠道和联系人身份是两个独立事实：同一位玩家可以从本地 chat、QQ 或微信发消息。Python 每轮重新生成渠道事实，再合入已启用插件提供的 `current_turn` 说明，放在历史之后、本次输入之前。旧历史中的渠道猜测不能充当当前状态；切回本地 chat 后不沿用 QQ / 微信说明。

插件提供的是经过审查的适配器静态说明，包含平台名称、私聊文字交互方式、自动回复路径与实际能力边界。它补充本轮提示词，不改写 soul，也不授予账号权限。账号配置、第三方工具返回值、联系人消息和凭据不能通过这个接口变成系统指令。上下文须匹配当前插件 / 渠道，限制段数和总长度；不可用或不匹配时保留输入并暂停该回合，不能凭旧上下文继续推理。

QQ / 微信的最终回复由协调器投递到原私聊，模型不需要调用额外的发送工具，因此仅修改工具描述不足以提供当前渠道信息。远端回合不提供本地 `attention_control` 或 Live2D 演出指令；即使联系人已证明是玩家，也不据此开放本地专注控制。等待渠道核验期间若停止、开启专注或改变联系人归属，必须在推理前复核活动代际、权限与 audience，不能把已取消的输入重新归入新回合。

## QQ：OneBot 11 正向 WebSocket

由用户自行运行 [NapCat](https://github.com/NapNeko/NapCatQQ)。NapCat 不是 MIT 许可；本项目不复制、修改或分发其源码 / 二进制，也不修改日常 QQ。Mac 部署可参考独立的 [Mac Installer](https://github.com/NapNeko/NapCat-Mac-Installer)。

1. 专用会话扫码登录 momo 个人号，开启 OneBot 正向 WS 并设置随机 access token。
2. 配置例如 `ws://127.0.0.1:3001`、私有令牌、momo QQ 号。远程必须 WSS。
3. get_login_info 核验真实账号，发送前再次核验。自身回声、群事件、不匹配账号不进入大脑。
4. send_private_msg 只发一个 text 段，CQ 字符串仍是纯文字。
5. echo 仅关联请求，不能保证幂等。已提交发送超时后保留 unknown，绝不重试；迟到回执补记原命令事实，不自动恢复执行。

message ID 只证明平台 / 桥接接受，不能声称对方已读。入站标识组合自身号、私聊对象、平台时间与 sequence / message ID，后端持久去重。OneBot 推送没有持久 ACK，host 只能重试本进程仍保留的事件；桥接重启缺口仍需真实 E2E。

## 微信：窄 HTTP 网关

Bearer 令牌认证，远程 HTTPS，本地仅 loopback HTTP：

- GET /v1/health：status、actualSelfId、identityKind=personal、identityVerified、executorQuiescent、capabilities、verified peers；支持安全停止的桥还返回 executionFence 与 executionGeneration。
- GET /v1/inbox?cursor=…：events 与 cursor；身份字段同统一 inbox。
- POST /v1/grant：停止后显式授予新的 executionGeneration；带围栏的桥在首次连接后也必须先授予。
- POST /v1/send：commandId / expectedSelfId / peerId / text / executionGeneration。响应回带原命令、账号、联系人、静止证明。结果为 client_observed / provider_accepted / provider_rejected / unknown。
- POST /v1/stop：使旧 generation 立即失效，再等待执行器停止；取消请求不能冒充停止 UI 操作。HTTP handler 在读取请求正文前取得准入 generation，迟到的旧请求不能在 stop 后执行。旧桥仍可按权限收发，但不能提供可信的 executorQuiescent 证明。
- 可选 durableAck 能力：POST /v1/ack 确认已处理或明确拒绝的 cursor，实验桥据此删除暂存正文；快照只保留散列。Host 将按账号、自身 ID 和端点隔离的 cursor 原子写入 `MOMO_DATA_DIR/private/channel-cursors.json`（0600，仅元数据），重配权限或重启后不会重读旧的拒绝页。

没有可验证身份、联系人或停止证据就不能启用；不提供匿名接口、CORS 或任意 MCP / UI 工具。

### Mac AX 实验桥

`scripts/wechat-bridge.py` 参考 [wechat-mcp 的 WeChat 4.x AX 研究](https://github.com/dustin573/wechat-mcp)，独立实现窄网关，不包含其完整 MCP。仅直接定位 AX 元素，不激活应用、不抢焦点、不发全局点击 / 按键、不搜索联系人。

```sh
uv venv .workbuddy/wechat-bridge-venv --python 3.14
uv pip install --python .workbuddy/wechat-bridge-venv/bin/python -r scripts/wechat-bridge-requirements.txt
chmod 600 /absolute/private/wechat-bridge.json
.workbuddy/wechat-bridge-venv/bin/python scripts/wechat-bridge.py \
  --config /absolute/private/wechat-bridge.json \
  --state-dir /absolute/private/wechat-bridge-state --doctor
```

配置示意（selector 是占位说明，不能作为真实验证）：

```json
{
  "token": "a-private-random-token-at-least-24-characters",
  "dedicatedSessionAcknowledged": false,
  "expectedSelfId": "wxid_momo",
  "selfIdentity": { "identifier": "verified-account-id-field", "value": "wxid_momo" },
  "chatIdentifier": "chat_detail_view",
  "headerIdentifier": "chat_header",
  "peers": [{
    "peerId": "wxid_player",
    "privateConfirmed": true,
    "identity": { "identifier": "verified-peer-id-field", "value": "wxid_player" }
  }],
  "editorIdentifier": "chat_input_text_view",
  "sendIdentifier": "chat_send_button"
}
```

先由玩家登录专用 momo 号，再核验实际版本的账号 / 联系人 ID 唯一 AX 定位和发送控件。联系人身份、消息列表、编辑器和发送按钮必须同属唯一当前私聊子树；发送前再次定位并核验。缺失时 doctor 返回 setup_required，不能直接把 expectedSelfId 当实际身份；显示名和第一个同名会话不作身份证据。专用会话必须明确确认，不能用于日常微信。

就绪后移除 --doctor，仅监听 127.0.0.1:9848。AX / 屏幕录制权限由用户自行授予；桥接不会自动申请或操作登录窗口。

### 验收边界

- 本机安装 WeChat 4.1.13；尚未登录准备的 momo 号，真实 identity selector / 收发仍待账号级 spike，不能声称微信已打通。
- 实验桥仅处理已验证且**当前可见的单个私聊**，不后台切换 / 遍历好友。全联系人连续监听需稳定原生 ID 网关，或后续受调度的 UI 导航。
- 首屏历史只建立基线；后续匹配连续窗口重叠区，在 SQLite 内分配持久序号。无重叠不猜测；相同文字的两条消息保留不同序号。
- 发送者从内存中的微信自身窗口截图左右边距判断，身份 / 窗口 / 归属不明即拒绝。截图不保存、不发送给外部视觉服务。
- 命令操作前持久登记，重启不重放。观察到自身气泡仅记 client_observed，不能声称服务器送达或对方已读。
- 桥接 JSON / SQLite / 会话 / 录屏属于私有用户数据，不能进 Git、默认导出或发布包。

## 测试

`npm --prefix plugin-host test` 覆盖隔离 OneBot WS / HTTP 网关 fixtures、Mac AX 绑定歧义与 journal 去重 / unknown 恢复。fixture 证明协议和故障语义，不能替代真实账号登录、客户端 AX 和跨端收发 E2E。
