# Web → 桌面晋级

共享源码在 momo-web：`frontend/`、`backend/`、`plugin-host/`；桌面导入到 `momo/app/` 对应目录。资源清单、Core 校验与示例配置也在显式映射中。Tauri、官网与发行不反向复制。

```sh
python3 scripts/promote.py --target /absolute/path/to/momo --revision HEAD --bootstrap
python3 scripts/promote.py --target /absolute/path/to/momo --revision HEAD --bootstrap --apply --check "浏览器验证记录路径"
```

首次导入才加 `--bootstrap`：所有既有目标文件必须仍与目标 HEAD 相同，未跟踪同名文件拒绝覆盖。之后省略此参数，校验 `app/migration/web-source.json` 中上次拥有的每个文件，包括待删除文件；目标本地改动 / 哈希漂移 / 新路径冲突全部拒绝。只删除上次拥有而新 revision 不再包含的文件。

源必须已提交且工作区干净；读取 Git blob，不遍历工作区收集数据。默认 dry-run。`--check` 只记录已有验证证据，**不执行测试，也不证明测试通过**。应用前全量检查，失败时回滚文件；相同 revision 二次晋级不产生 diff。目标提交应同时包含共享快照与清单，避免下次误判未提交漂移。

晋级到独立桌面候选分支后，准备离线资源、Node 宿主与冻结后端；macOS 原生产物验证继续 / 重启 / 单实例 / 退出清理。浏览器通过不能替代原生安装产物验证。当前不会自动覆盖玩家已安装的应用或数据，也不自动发布未验收 v3。
