// 全局共享类型——各模块契约的单一来源。

/** OpenAI 兼容 LLM 端点（url 可为 base 或完整 /chat/completions 地址）。 */
export interface LlmConfig {
  url: string;
  key: string;
  model: string;
  thinking: boolean;
}

/** TTS 端点：GPT-SoVITS api_v2 服务地址（前端统一走 backend 的 /api/tts/speech）。 */
export interface TtsConfig {
  /** GPT-SoVITS api_v2 的服务地址（如 http://127.0.0.1:9880）。 */
  url: string;
  key: string;
  /** 参考音频的**服务端路径**（音色来源），如 GPT-SoVITS 里的 reference/xx.wav。 */
  voice: string;
  /** 参考音频对应的文本；留空则 ref_free 合成（相似度略降）。 */
  prompt: string;
  // 语言不在这里：TTS 合成语言跟随**对话语言**（settings.general.chatLang），
  // 由调用方按请求传入（见 services/ttsClient.ts 的 SpeakOptions.lang）。
}

/** 界面语言（i18n）；新增语言同时在 i18n/ 注册字典。 */
// 与后端契约同形的类型由 OpenAPI 生成（api/types.ts），这里只转出 ——
// 页面继续从 lib/types 取类型，不必关心它们从哪来。
export type { Memory } from "../api/types";
/** Durable transcript identity, independent of the prompt's bounded context window. */
export type StoredMessage = import("../api/types").StoredMessage & {
  eventId?: string;
  runId?: string;
  source?: string;
  externalMessageId?: string | null;
  seq?: number;
};

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
  /** 使用内置识别的语音输入开关。 */
  voiceInput: boolean;
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
  tts: TtsConfig;
  /** 已登记的 MCP 拓展清单。 */
  extensions: McpExtension[];
}

/** 记忆条目（backend /api/memories 返回；pinned=true 即初始记忆 pin）。 */
/** Live2D 资源语义层：稳定 ID、展示名称、实际表现与使用语境。 */
export interface AvatarResource {
  enabled?: boolean;
  /** 表情 = FileReferences.Expressions[].Name；动作 = 相对 manifest 的文件路径。 */
  name: string;
  /** 可观察的实际表现；不要把使用场景混入这里。 */
  desc: string;
  /** 展示名称，与稳定资源 ID 分离。 */
  label?: string;
  /** 适用语境与避免的场景，不代替实际动作描述。 */
  context?: string;
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

export interface ChatMessage {
  id: string;
  eventId?: string;
  runId?: string;
  source?: string;
  externalMessageId?: string | null;
  seq?: number;
  role: "user" | "assistant";
  text: string;
  at: string;
}

export type ChatStatus = "idle" | "listening" | "thinking" | "speaking";

/** /api/state 持久化载荷（backend momo.yaml ↔ localStorage 缓存共用 schema）。
 *  初始记忆（pin）与会话历史在 momo.db，不在此 schema。 */
export interface PersistedState {
  settings: Settings;
  /** Live2D 模型清单（含内置条目；导入模型 blob 在 IndexedDB）。 */
  avatars: AvatarMeta[];
  /** 当前形象：avatars[].id。 */
  avatarId: string;
}
