# Minecraft 开发验收场景

用于 007 的原版机制检查，正式支持范围为 Java 1.21.1 / Fabric。仍使用测试者现有的客户端与账号；仅增加独立存档 `momo-007-fixtures`。当前安装版尚未整体验收。

```mermaid
flowchart LR
  A[原存档 level.dat 只读模板] --> B[新存档：生存、正常难度、空背包]
  B --> C[显式开发标记＋一次性准备模组]
  C --> D[生成场景、保存退出]
  D --> E[移除准备模组和 JVM 标记]
  E --> F[正式 Companion 执行正常游戏操作]
  F --> G[服务端回执＋实际库存／世界状态]
```

## 场景与验收范围

场景预置工作站、材料箱、农民及围栏门、水池、轨道和未激活的维度入口。玩家初始背包与经验为空；物品需要通过真实容器操作取得。准备时固定为晴天并关闭自然刷怪，用于隔离 UI、加工、装备、交易及缺氧等用例。

第二版另设三个普通牛靶、遮阳区域内的一只普通骷髅及一只中立僵尸猪灵，供弹道、防御及不主动攻击中立生物的验证。生物使用正常 AI、生命和伤害规则；它们是明确的测试前提，不能算作自然遇敌或模型自选目标的证据。站点区域与战斗区域分开，控制仍只能由正式执行器按真实玩家规则进行。

这些预置材料作为测试前提明确记录。自然资源获取、自然夜间危险、完整战斗和自主连续生活，继续保留各自的验收要求与证据。场景生成、资源预置或准备模组的成功，不算 momo 执行成功。

## 准备与移除

1. 使用 Java 21、Gradle 8.10.2，准备已锁定依赖后，在仓库根目录执行：

   ```sh
   gradle -p plugin-host/minecraft-fabric build remapFixtureJar
   uv run --project backend --frozen python scripts/test_minecraft_fixture_world.py
   uv run --project backend --frozen python scripts/test_build_minecraft_component.py
   ```

2. 生成新测试存档，模板只读；已有目标目录会直接拒绝：

   ```sh
   uv run --project backend --frozen python scripts/minecraft_fixture_world.py --template '<原存档>/level.dat' --saves '<专用测试实例>/saves'
   ```

3. 将 `.workbuddy/007/fixture-build/momo-acceptance-fixtures-0.1.0.jar` 临时放入同一专用测试实例的 `mods`，在启动器增加 JVM 参数 `-Dmomo.fixture.prepare=007-fixtures`，进入新测试存档。
4. 准备完成后会生成 `.momo-fixture-prepared`。保存并退出，移除该开发模组与 JVM 参数，再进入同一个测试存档。
5. 后续验收只保留正式 Companion 与固定的 Baritone 依赖。核对生存模式、正常难度、实际装备／材料／任务回执；测试报告保留在本地忽略目录。

准备模组只识别名称严格匹配且具有精确标记的专用新存档；缺少开关、错误存档、符号链接、已有玩家数据或已准备标记都会拒绝执行。它没有 HTTP、模型工具或命令行执行入口。

## 产物隔离

开发代码位于独立 `src/fixture` / `src/fixtureTest` source set，产物输出到忽略的 `.workbuddy/007/fixture-build`。正式 Companion 仍只来自 `build/libs/momo-fabric-companion-0.1.0.jar`。

`build-minecraft-component.py` 在交付前检查正式 JAR，拒绝开发准备类、准备模组身份及嵌套准备 JAR；CI 同时运行存档隔离、一次性标记、模板只读与产物排除回归。桌面资源准备使用正式 JAR 的固定文件名，不复制该开发 source set。最终安装包仍需核验实际资源清单。
