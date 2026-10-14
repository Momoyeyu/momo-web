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

- `app/main.py` — FastAPI 入口 + CORS（放行任意 localhost/127.0.0.1 端口）+ state/记忆 REST + 挂载 chat 路由
- `app/store.py` — `data/state.json` 读写；读取时 defaults 深合并（缺键补默认、多键透传、None 视为缺失）
- `app/llm.py` — OpenAI 兼容 chat client（httpx 非流式，tools/tool_calls，60s 超时，错误抛 `LlmError`）
- `app/embed.py` — embeddings client（5s 超时，失败返回 `None` 降级 lexical）
- `app/memory.py` — 普通记忆 `data/memories.json` `{id,content,createdAt}`；embedding 缓存 `data/memory-embeddings.json`（key=sha256(content)，普通记忆与 pin 共用，搜索时懒算落盘）
- `app/agent.py` — ReAct 循环（≤5 轮）+ 工具执行 + zh/en/ja 三套 system prompt 模板（情绪指令段固定追加在末尾）
- `app/chat.py` — `POST /api/chat` SSE 端点

## 契约歧义的实现取舍

- **PUT /api/state 旧数据**：body 里 `memories` 数组逐项导入普通记忆（跳过 `valid==False` 与非字符串 content，去重）；`user` 对象忽略。两个键导入/忽略后**不写回** state.json。
- **GET /api/state**：文件缺失返回 `{}`；存在则返回 defaults 合并后的完整 state（旧 schema 容错，不强行纠正类型）。
- **pin 参与 search**：pin 伪 id 为 `pin:<sha256(content)[:12]>`；`memory.delete` 收到 `pin:*` 或未知 id 返回「不可删除/不存在」说明文本。去重判定也覆盖 pin。
- **search 精排**：候选序 = 普通记忆文件序 + pin 序，`recency = (index+1)/总数`；embedding 降级时 bigram Jaccard 只返回 score>0 的 top-5。
- **REST 错误码**：校验失败 400、去重冲突 409、id 不存在 404；tool 路径同构说明文本作为 tool result 回给模型（不 raise）。
- **SSE**：成功回合 `delta*` + `done`；出错只发 `error`（不发 `done`）。`history` 在 LLM 返回最终 content 后先落盘再推流。
- **persona 扩展字段**：契约模板之外，persona 携带的 `oneLiner/likes/dislikes/traits/tone/taboos/examples` 非空时并入「关于你自己」段（三语模板均有对应 label）。
- **lang**：`settings.general.lang` 按前缀匹配 zh/en/ja，未知回退 zh。
