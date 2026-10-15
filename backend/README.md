# momo-web backend

momo web 版的 Python FastAPI 后端（契约见 `docs/backend-api.md`，将来移植 Rust，模块边界保持清晰直白）。

## 运行

```bash
cd backend
uv sync
uv run uvicorn app.main:app --port 7821
```

测试：`uv run pytest`（LLM/embedding 全部 mock，不打真网络）。

## env

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MOMO_EMBEDDING_URL` | `http://10.106.130.222:11434` | OpenAI 兼容 embedding 服务（`POST {url}/v1/embeddings`） |
| `MOMO_EMBEDDING_MODEL` | `bge-m3` | embedding 模型名 |

LLM 配置不走 env，走 `state.settings.llm`（`{url}/v1/chat/completions`，key 空则不带 auth）。

## 模块

- `app/main.py` — FastAPI 入口 + CORS（放行任意 localhost/127.0.0.1 端口）+ 挂载 `app/api/` 路由
- `app/api/` — REST 端点：`state`（配置读写）/ `memories` / `checkpoints`（存档槽位）/ `chat`（SSE）
- `app/store.py` — `data/momo.yaml` 读写（YAML 配置层；HTTP 层载荷仍是 JSON）；读取时 defaults 深合并（缺键补默认、多键透传、None 视为缺失）
- `app/db.py` — `data/momo.db` 单连接 + `tx()` 事务 + schema（memories / memory_vec / sessions / messages）
- `app/llm.py` — OpenAI 兼容 chat client（httpx 非流式，tools/tool_calls，60s 超时，错误抛 `LlmError`）
- `app/embed.py` — embeddings client（5s 超时，失败返回 `None` 降级 lexical）
- `app/memory.py` — 长期记忆 `data/momo.db` memories 表（`pinned=1` 即初始记忆）+ memory_vec 向量表（sqlite-vec cosine KNN，缺向量搜索时懒算补写）
- `app/checkpoint.py` — 会话存档：live 会话行 + 手动槽位快照 + auto 槽；回合落账走代际校验，live.messages 上限 100
- `app/agent/` — ReAct 循环（`loop.py`，≤5 轮）+ 能力执行（`capability.py`）+ system prompt 组装（`prompt.py`，zh/en/ja 三套模板）+ 后台上下文压缩（`compress.py`）+ MCP 拓展（`extend.py`）

## 契约歧义的实现取舍

- **PUT /api/state**：body 整体落盘 `data/momo.yaml`（YAML 明文）；读取时 defaults 合并回吐，写时不做归一化。
- **GET /api/state**：文件缺失返回 `{}`；存在则返回 defaults 合并后的完整 state（残缺字段容错，不强行纠正类型）。
- **pin 参与 search**：初始记忆 = memories 表 `pinned=1` 行，id 即真实行 id；`memory_update`/`memory_delete` 能力对 pinned 行返回「不可修改/删除」说明文本。去重判定也覆盖 pin。
- **search 精排**：候选序 = memories 表 rowid 序（pin 与普通记忆合并排序），`recency = (index+1)/总数`；embedding 降级时 bigram Jaccard 只返回 score>0 的 top-5。
- **REST 错误码**：校验失败 400、去重冲突 409、id 不存在 404；tool 路径同构说明文本作为 tool result 回给模型（不 raise）。
- **SSE**：成功回合 `delta*` + `done`；出错只发 `error`（不发 `done`）。`history` 在 LLM 返回最终 content 后先落盘再推流。
- **persona 扩展字段**：契约模板之外，persona 携带的 `oneLiner/likes/dislikes/traits/tone/taboos/examples` 非空时并入「关于你自己」段（三语模板均有对应 label）。
- **lang**：`settings.general.lang` 按前缀匹配 zh/en/ja，未知回退 zh。
