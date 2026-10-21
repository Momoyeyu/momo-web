"""后端的数据形状。

这些类型此前只存在于 docstring 和行尾注释里（`dict[str, Any]` 满天飞），
调用方必须读注释才知道键名。集中到这里后：

- 调用点自解释：`state["settings"]["llm"]["url"]` 无需注释；
- 归一化边界（`state.normalize_state`）之后的字段存在性由类型承诺，
  于是那层 `(state.get("settings") or {}).get(...) or {}` 的死防御可以删掉；
- `Literal` 别名取代魔法字符串（角色、SSE 事件名、transport）。

TypedDict 零运行时开销：这些形状本来就是 dict，构造点一行都不用改。
"""

from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict

# ==================== 配置层（data/momo.yaml） ====================

Transport = Literal["stdio", "http"]


class LlmConfig(TypedDict):
    url: str
    key: str
    model: str


class AsrConfig(TypedDict):
    """ASR 端点。mode: "builtin" 用内置 SenseVoice；"openai" 用任何兼容
    OpenAI /v1/audio/transcriptions 的服务（url 为 base，如 http://host:8080/v1）。"""

    mode: str
    url: str
    key: str


class TtsConfig(TypedDict):
    """TTS 端点（GPT-SoVITS api_v2 的地址）。

    voice = 参考音频的**服务端路径**（音色来源）；prompt = 那段音频的文本，
    留空则以 ref_free 模式合成（音色相似度会降一点）。
    """

    url: str
    key: str
    voice: str
    prompt: str


class EmbeddingConfig(TypedDict):
    url: str
    key: str
    model: str


class Extension(TypedDict):
    """一条 MCP server 记录；stdio 与 http 分支的字段并存。"""

    name: str
    transport: Transport
    enabled: bool
    command: str
    args: list[str]
    env: dict[str, str]
    endpoint: str
    headers: dict[str, str]


class GeneralSettings(TypedDict):
    lang: str
    chatLang: str
    dialogOpacity: int
    textSpeed: int
    sentenceSpeed: int
    voiceVolume: int
    showStatus: bool
    voiceInput: bool


class Settings(TypedDict):
    general: GeneralSettings
    llm: LlmConfig
    asr: AsrConfig
    tts: TtsConfig
    embedding: EmbeddingConfig
    extensions: list[Extension]


class Resource(TypedDict):
    """形象控件：稳定标识、实际表现、展示名称与使用语境。"""

    name: str
    desc: str
    label: NotRequired[str]
    context: NotRequired[str]
    enabled: NotRequired[bool]


class AvatarResources(TypedDict):
    expressions: list[Resource]
    motions: list[Resource]


class Avatar(TypedDict):
    id: str
    builtin: bool
    name: str
    fileName: str
    manifest: str
    size: int
    addedAt: str
    resources: AvatarResources


class State(TypedDict):
    """归一化后的完整配置（`state.normalize_state` 的产物）。

    **不含人设**：名称/年龄/身份/性格写死在 resources/soul.md，用户改不到
    （避免用户在设置里乱玩人设），改人设＝改那个常量。

    归一化保证这些键都存在，因此内部消费方无需防御式下钻。
    注意：这是**读视图**——momo.yaml 里 schema 外的键会原样透传（PUT 时原样带回），
    所以实际 dict 可能比这里多键。
    """

    settings: Settings
    avatars: list[Avatar]
    avatarId: str


# ==================== 数据层（data/momo.db） ====================

Role = Literal["user", "assistant"]


class Memory(TypedDict):
    id: str
    content: str
    createdAt: str
    pinned: bool


class MemoryRef(TypedDict):
    """召回结果：只回 id + 原文，id 供 update/delete 使用。"""

    id: str
    content: str


class MemoryCreated(TypedDict):
    """POST /api/memories 的响应：只回新建项的定位信息。"""

    id: str
    pinned: bool


class StoredMessage(TypedDict):
    """momo.db 里的一条会话消息（落库形态，不含指令）。

    role 只会有两个值——begin_turn 写 user、append_sentence 写 assistant。
    """

    role: Role
    text: str
    at: str


class CheckpointMeta(TypedDict):
    """存档列表项（卡片展示用）。slot 为 None 的是 auto 槽。"""

    id: str
    title: str
    auto: bool
    slot: int | None
    createdAt: str
    updatedAt: str
    preview: str


class CheckpointDetail(TypedDict):
    """存档全文（读取/覆盖往返用）。

    刻意**不继承** CheckpointMeta：preview 只是列表项的展示字段，
    `_entry()` 不产出它。注意这些类型会被 FastAPI 当 response_model 校验，
    多一个必填字段就会让端点 500。
    """

    id: str
    title: str
    auto: bool
    slot: int | None
    createdAt: str
    updatedAt: str
    summary: str
    messages: list[StoredMessage]


class CheckpointCreated(TypedDict):
    """POST /api/checkpoints 的响应：只回新存档的定位信息。"""

    id: str
    slot: int | None


class LiveTranscript(TypedDict):
    """GET /api/checkpoints/live：前端启动时恢复字幕/backlog。"""

    summary: str
    messages: list[StoredMessage]


# ==================== LLM 交互（OpenAI 兼容） ====================

ChatRole = Literal["system", "user", "assistant", "tool"]


class ToolCallFunction(TypedDict):
    name: str
    arguments: str


class ToolCall(TypedDict):
    id: str
    type: Literal["function"]
    function: ToolCallFunction


class ChatMessage(TypedDict):
    """发给 LLM 的一条消息。

    带 tool_calls 的 assistant 消息 content 为 None（OpenAI 语义）；
    role="tool" 的消息带 tool_call_id。这两个字段只在对应角色下出现，
    所以用 NotRequired——比 `total=False` 保留了 role/content 的存在性承诺。
    """

    role: ChatRole
    content: str | None
    tool_calls: NotRequired[list[ToolCall]]
    tool_call_id: NotRequired[str]


class ToolResultMessage(TypedDict):
    """能力执行结果，回填成 role="tool" 的消息。"""

    role: Literal["tool"]
    tool_call_id: str
    content: str


class ProbeResult(TypedDict):
    """MCP server 连通性探测结果（设置页状态点）。"""

    ok: bool
    tools: int
    error: NotRequired[str]


# ==================== SSE 事件（契约见 backend/openapi.json 与 /docs） ====================

ErrorService = Literal["llm", "backend"]


class ExpressionCue(TypedDict):
    name: str
    intensity: float
    duration: NotRequired[float]


class PerformanceCue(TypedDict):
    id: str
    offset: int
    expression: NotRequired[ExpressionCue | None]
    motion: NotRequired[str]


class SentenceEvent(TypedDict):
    """一句话落账后的推送：正文已剥离指令，控制随 cues 一起下发。

    切句由后端唯一口径完成（core/sentences.py），前端不再切句。
    """

    t: Literal["sentence"]
    no: int
    text: str
    cues: list[PerformanceCue]
    at: str


class ErrorEvent(TypedDict):
    t: Literal["error"]
    message: str
    service: ErrorService


class DoneEvent(TypedDict):
    t: Literal["done"]


#: agent 层产出的事件（done 由 api 层在回合成功后追加）。
TurnEvent = SentenceEvent | ErrorEvent
SseEvent = SentenceEvent | ErrorEvent | DoneEvent
