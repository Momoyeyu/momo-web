# QQ 插件受管运行：004 验证记录

日期：2026-10-27。目标是在设置内登录 momo 自己的普通 QQ 号，由插件管理运行资源，玩家无需部署 Docker、网关或签名服务。现有 OneBot 通信原型不等于该目标已交付。

## 原生运行关口尚未通过

本次检查了 NapCat `v4.18.41` 官方 Shell、固定提交的 Mac 安装器，以及本机官方 QQ 的私有复制品。复制品逐项一致，NapCat 下载包的 SHA-256 与官方发行摘要一致。没有启动引擎、申请二维码、登录账号或修改系统 QQ；也没有去签、重签或关闭系统保护。

现成启动参数不足以证明账号隔离：

- `NAPCAT_WORKDIR` 只控制 NapCat 的配置、日志和缓存。Shell 在 macOS 上另用默认 QQ 路径初始化内核 global、login commonPath 和 account_path，不能把 Electron 的 `--user-data-dir` 当作完整账号目录重定位。
- QQ 原生启动器在 JavaScript 入口前解析系统应用组与 Application Support 路径，并参与热更新选择。复制 app 本身不能证明它不读取日常 QQ 的目录。
- 上游安装器明确修改系统 QQ 入口，且两个实例共享 QQ 容器内的登录数据库与 mmkv；因此不能直接包装成独立插件实例。

这些是当前锁定资源和 stock 启动方式的缺口，**不是原生隔离不可能实现的结论**。内核存在显式路径参数，下一步需要完整的独立数据根目录合同或可提供的专用适配，并实际验证所有账号、登录、热更新读写都遵从它。未过关前不提供假二维码或显示已就绪。

## 安装资源也需要单独确认

Mac 安装器的 MIT 许可不覆盖 NapCat、QQ 和原生模块。NapCat 当前自定义许可包含明确授权、再分发、修改版公开发布与非商业条款；现有公开下载不能作为 momo 已取得完整打包权利的证据。这里记录待明确的分发条件，不作法律解释或代替权利人授权。

## 后续实施顺序

1. 固定可提供的 QQ / Electron / NapCat / loader 组合，证明独立目录、更新边界与日常 QQ 不受影响。
2. 实现独立于消息适配器重建的 Cordis 运行与登录管理，区分插件启用、进程、平台会话、连接和业务权限。
3. 接入设置内二维码、过期刷新、取消、真实身份核验、断开与忘记登录；管理令牌只留后端。
4. 在无 Docker / 外部桥接的环境由维护者扫码，验证真实收发、重启、退出、专注 / 停止与进程清理后再验收。

目前保留已有专用测试容器及登录态；原生替代可用后才切换和回收。模拟服务测试只能证明 momo 的协议与授权行为，不能证明原生引擎可用。

## 固定来源

- [NapCat v4.18.41 发行](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.41)
- [Shell 内核路径初始化](https://github.com/NapNeko/NapCatQQ/blob/v4.18.41/packages/napcat-shell/base.ts)
- [NapCat 工作目录](https://github.com/NapNeko/NapCatQQ/blob/v4.18.41/packages/napcat-common/src/path.ts)
- [内核会话路径](https://github.com/NapNeko/NapCatQQ/blob/v4.18.41/packages/napcat-core/index.ts)
- [Mac 安装器及共享目录说明](https://github.com/NapNeko/NapCat-Mac-Installer/blob/d2d15e6288a23287dabfc35378fa9b4735e84b2d/README.md)
- [NapCat 许可原文](https://github.com/NapNeko/NapCatQQ/blob/v4.18.41/LICENSE)
