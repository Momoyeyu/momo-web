# momo-web

- 当前只在 momo-web/master 开发、提交和推送，默认直接走 master，不自行建 PR 或并行桌面候选。交付前确认当前 master 的 GitHub CI 实际通过。
- frontend/、backend/、plugin-host/ 为共享业务唯一修改源；全部 Web 迭代完成后，仅在用户明确要求时通过 scripts/promote.py 一次性同步到 momo/app。此前不修改、打包或保留本轮 v3 桌面候选。不要改用户保全的旧检出。
- Python 是唯一生活 / 推理 / 记忆协调器；Cordis 只管理插件生命周期与受许可执行。不新增渠道私有推理循环。
- 只有一段连续生活。永久事件、上下文投影、长期记忆分开；失败 / 未展示内容不得充当已发生对话。删除记忆不得从相同旧来源重新学习。
- 账号授权、活动模式、soul 不由模型改写。外部副作用前校验许可，真实迟到回执仍按原命令记事实。
- 用户数据、密钥、录音、模型缓存、测试报告不进 Git。默认 Hiyori / 字体按许可保留；Core / ASR / embedding 按锁定资源契约准备，运行时不下载。
- 中 / 英 / 日界面、已验收的剪影 / ASCII / RoPE 演出保持。设置 / 历史仍属同一次见面；标题才明确离开。
- 新 MOMO_ 环境变量同步 .env.example 和 docs/development/configuration.md；Web 只绑定本机，正式鉴权不能绕过。
- 测试用隔离目录，不跑真实用户数据迁移。先备份再迁移；恢复必须撤销旧活动并阻断自动重放。
- 原生以 macOS 验收为先，Windows 后续；不做移动端。重型构建 / 模型推理遵循外层算力与实验室清理约定。
- 提交前使用 consistent-commit，Conventional Commit 不加 AI trailer；计划先测试再交维护者验收，不能提前标 done。
