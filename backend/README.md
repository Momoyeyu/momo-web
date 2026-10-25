# momo Web 内核

FastAPI 是唯一生活、推理与长期记忆权威。Cordis 子进程负责插件连接与受许可执行，不能独立产生第二套对话循环。

开发从仓库根目录 `pnpm dev` 启动：独立数据目录、loopback 端口、临时令牌、宿主依赖和退出清理由启动器统一处理。不要把无鉴权的手动 uvicorn 实例暴露到网络，也不要复用桌面正式数据目录。

```sh
uv sync --frozen
.venv/bin/python -m pytest -q
.venv/bin/python scripts/export_openapi.py
```

修改 REST / SSE 契约后从 frontend 执行 `node scripts/gen-api.mjs` 并一起提交契约。数据层迁移、摘要和记忆遗忘测试必须使用临时目录。

[运行边界](../docs/development/v3-runtime.md) 说明连续账本、展示 ACK、租约、活动代际和恢复边界。资源 / 真实供应商测试为显式 opt-in；默认不分发角色参考音。
