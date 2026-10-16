// 全局共享类型——各模块契约的单一来源。

/** OpenAI 兼容 LLM 端点（url 可为 base 或完整 /chat/completions 地址）。 */
export interface LlmConfig {
  url: string;
  key: string;
  model: string;
}

/** ASR 端点（ws(s)://…[/v1/listen]，Deepgram 对齐流式）。 */
export interface AsrConfig {
  url: string;
  key: string;
}

/** TTS 端点（http(s)://…，POST /v1/audio/speech，OpenAI 对齐）。 */
export interface TtsConfig {
  url: string;
  key: string;
  voice: string;
  // 语言不在这里：TTS 合成语言跟随**对话语言**（settings.general.chatLang），
  // 由调用方按请求传入（见 services/ttsClient.ts 的 SpeakOptions.lang）。
}

/** 语义检索 embedding 端点（http(s)://…，POST /v1/embeddings，OpenAI 对齐）。
 *  由 backend 记忆检索消费；url 留空 = 只用词面召回。 */
export interface EmbeddingConfig {
  url: string;
  key: string;
  model: string;
}

/** 界面语言（i18n）；新增语言同时在 i18n/ 注册字典。 */
export type Lang = "zh" | "ja" | "en";

/** 通用设置（语言等，与具体服务无关）。 */
export interface GeneralConfig {
  /** 界面语言（产品 UI）。 */
  lang: Lang;
  /** momo 对话语言；"auto" = 跟随界面语言。 */
  chatLang: Lang | "auto";
  /** 对话框背景不透明度 0–100（%）。 */
  dialogOpacity: number;
  /** 文字速度 0–100：句内逐字上屏速率上限（100 = 贴着 LLM 生成速度）。 */
  textSpeed: number;
  /** 切句速度 0–100：句间停顿与无 TTS 驻留的统一缩放。 */
  sentenceSpeed: number;
  /** TTS 语音播放音量 0–100（%）。 */
  voiceVolume: number;
  /** chat 页左上角是否显示对话状态条（空闲/聆听/思考/回应）。 */
  showStatus: boolean;
  /** 语音输入（ASR 麦克风）；asr.url 未配置时强制为关。 */
  voiceInput: boolean;
  /** 记忆语义检索（embedding）；embedding.url 未配置时强制为关。 */
}

/** MCP 拓展登记项：外部 MCP server 的连接配置（backend 每回合按此连接并
 *  导入 tools/list，工具以 {server}_{tool} 注入）。
 *  通用字段 {name, transport, enabled}；stdio 分支 {command, args, env}，
 *  http 分支 {endpoint, headers}——两分支字段并存，按 transport 取用。 */
export interface McpExtension {
  /** 显示名；同时用作工具名前缀（backend 会合法化为 [a-zA-Z0-9_]）。 */
  name: string;
  /** 连接方式：stdio = 本地命令子进程；http = Streamable HTTP 端点。 */
  transport: "stdio" | "http";
  /** 开关；关闭即不连接不注入（下一回合生效）。 */
  enabled: boolean;
  /** stdio：可执行名（如 `npx`、`uvx`）。 */
  command: string;
  /** stdio：参数数组，按序传给子进程（如 ["-y","tavily-mcp"]）。 */
  args: string[];
  /** stdio：环境变量键值对——密钥类凭据走这里（如 TAVILY_API_KEY）。 */
  env: Record<string, string>;
  /** http：MCP 端点 URL（http(s)://…）。 */
  endpoint: string;
  /** http：请求头键值对——鉴权统一走这里（Authorization: Bearer …）。 */
  headers: Record<string, string>;
}

export interface Settings {
  general: GeneralConfig;
  llm: LlmConfig;
  asr: AsrConfig;
  tts: TtsConfig;
  embedding: EmbeddingConfig;
  /** 已登记的 MCP 拓展清单。 */
  extensions: McpExtension[];
}

/** 记忆条目（backend /api/memories 返回；pinned=true 即初始记忆 pin）。 */
export interface Memory {
  id: string;
  content: string;
  createdAt: string;
  pinned: boolean;
}

/** Live2D 资源语义层条目：资源名 + 可编辑的含义描述（写给 LLM 看）。 */
export interface AvatarResource {
  /** 表情 = FileReferences.Expressions[].Name；动作 = "组名/序号"。 */
  name: string;
  /** 语义描述（可为空；注入 prompt 时写作 "- 名称 — 描述"）。 */
  desc: string;
}

/** 模型的表情/动作资源清单：导入时从 manifest 解析，desc 在设置页编辑。 */
export interface AvatarResources {
  expressions: AvatarResource[];
  motions: AvatarResource[];
}

/** Live2D 模型元信息。导入模型 zip 本体存 IndexedDB（key=id）；
 *  内置模型（builtin=true）无 zip，仅占位携带资源清单。 */
export interface AvatarMeta {
  id: string;
  /** 内置模型标记（不可删除，idb 无 blob）。 */
  builtin?: boolean;
  /** 显示名（manifest Name 或 zip 文件名）。 */
  name: string;
  /** 原始 zip 文件名。 */
  fileName: string;
  /** zip 内选定的 model3.json 路径。 */
  manifest: string;
  /** zip 体积（字节）。 */
  size: number;
  addedAt: string;
  /** 表情/动作资源清单 + 语义描述；缺省 = 尚未从 manifest 解析。 */
  resources?: AvatarResources;
}

/** 人设卡（persona 页可编辑；backend 渲染进 system prompt）。 */
export interface PersonaCard {
  name: string;
  /** 身份描述（物种/自我认知）。 */
  identity: string;
  age: number;
  /** 性格描述（自由文本）。 */
  personality: string;
  /** 偏好列表（如「喜欢草莓蛋糕」「讨厌苦的东西」）。 */
  preferences: string[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
}

export type ChatStatus = "idle" | "listening" | "thinking" | "speaking";

/** 存档里的单条消息（backend history 快照；无前端 id）。 */
export interface CheckpointMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
}

/** 存档槽列表项（GET /api/checkpoints；preview = 末条消息截断）。 */
export interface CheckpointMeta {
  id: string;
  title: string;
  /** 自动存档槽：load 前 backend 自动写入，不占手动槽位。 */
  auto: boolean;
  /** 手动槽位号 1–120（auto 槽为 null）。 */
  slot: number | null;
  createdAt: string;
  updatedAt: string;
  preview: string;
}

/** 存档全文（GET /api/checkpoints/{id} 与 load 返回）。 */
export interface CheckpointSave extends CheckpointMeta {
  summary: string;
  messages: CheckpointMessage[];
}

/** /api/state 持久化载荷（backend momo.yaml ↔ localStorage 缓存共用 schema）。
 *  初始记忆（pin）与会话历史在 momo.db，不在此 schema。 */
export interface PersistedState {
  settings: Settings;
  persona: PersonaCard;
  /** Live2D 模型清单（含内置条目；导入模型 blob 在 IndexedDB）。 */
  avatars: AvatarMeta[];
  /** 当前形象：avatars[].id。 */
  avatarId: string;
}
