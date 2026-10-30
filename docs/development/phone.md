# 手机扩展点（011）

手机属于平台，App 不负责创建外壳。当前官方 QQ 同时提供图标、只读视图与真实消息投影；玩家通过对话让 momo 操作，不能在手机里冒用 momo 发送。

## 接入

- 前端 `src/phone/registry.tsx` 的 `registerPhoneApp({id, source, icon, render?})` 返回注销函数。图标与视图由对应 App 模块提供；没有 `render` 时显示待机桌面。官方示例为 `qqApp.tsx` 和 `QQPhoneView.tsx`。
- 后端 `services/phone.py` 的 `register_app(id, reader)` 返回注销函数。可信内置扩展的 reader 接收 `(peer, before)`，返回 App 描述、积压数及当前账号的只读消息分页。`snapshot` 聚合 App 与活动状态。当前动态 Cordis 插件不能注入任意浏览器代码；新增官方 App 需同时集成视图与投影。
- 注销时调用两侧 disposer。视图注册不会增加工具、执行许可或发送能力；业务继续经过 Cordis 与 Python 协调器。

## 显示与事实

- Boot 重置自动展示资格；收到消息只显示积压点，实际手机业务才自动展开。手动收起后本次 Boot 不再自动弹出；任务结束不自动收起。
- 专注不阻止玩家浏览，只暂停业务。浏览不消费队列、不清除积压点。
- QQ 入站来自 inbox；常规回复仅显示已确认可见的消息；主动文字仅在真实成功回执后显示。失败、结果未知显示为操作状态，绝不冒充已送达。附件与管理操作展示执行状态，不模拟不存在的原生 QQ 画面。
- 按 App、当前 QQ 身份和会话隔离；历史分页响应携带视图版本检查，切换时清理。离开 chat 停止轮询；同一 Boot 保留手机显隐偏好，浏览位置不持久化。
- Log 保留渠道与会话标记；QQ 内容不进入本地字幕或语音回放。

## 验证

`backend/tests/test_phone.py` 覆盖账号隔离、回执、只读积压及第二 App 注册；前端 registry/projection 测试覆盖注销、自动显示、跨 App 身份和滚动消息合并。

运行开发服务后，在 frontend 执行 `node scripts/phone-smoke.mjs`，用独立无头浏览器与模拟 API 检查手机导航、长内容触底、手动收起、问号说明与较小 PC 窗口；不登录或发送真实 QQ 消息。
