// 全局共享类型——各模块契约的单一来源。

/** 情绪 tag（固定 8 个，LLM 输出 [tag] 内联标记；同时透传给 TTS emotion 字段）。 */
export type EmotionTag =
  | "neutral"
  | "happy"
  | "sad"
  | "angry"
  | "surprised"
  | "thinking"
  | "shy"
  | "sleepy";

export const EMOTION_TAGS: readonly EmotionTag[] = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "surprised",
  "thinking",
  "shy",
  "sleepy",
];

export function isEmotionTag(s: string): s is EmotionTag {
  return (EMOTION_TAGS as readonly string[]).includes(s);
}

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
  lang: string;
}

/** 语义检索 embedding 端点（http(s)://…，POST /v1/embeddings，OpenAI 对齐）。
 *  由 backend 记忆检索消费；url 留空 = 只用词面召回。 */
export interface EmbeddingConfig {
  url: string;
  model: string;
}

/** 界面语言（i18n）；新增语言同时在 i18n/ 注册字典。 */
export type Lang = "zh" | "ja" | "en";

/** 通用设置（语言等，与具体服务无关）。 */
interface GeneralConfig {
  lang: Lang;
  /** 对话框背景不透明度 0–100（%）。 */
  dialogOpacity: number;
  /** TTS 语音播放音量 0–100（%）。 */
  voiceVolume: number;
  /** chat 页左上角是否显示对话状态条（空闲/聆听/思考/回应）。 */
  showStatus: boolean;
}

export interface Settings {
  general: GeneralConfig;
  llm: LlmConfig;
  asr: AsrConfig;
  tts: TtsConfig;
  embedding: EmbeddingConfig;
}

/** 普通记忆条目（backend /api/memories 返回；pin 不在此列）。 */
export interface Memory {
  id: string;
  content: string;
  createdAt: string;
}

/** 导入的 Live2D 模型元信息（zip 本体存 IndexedDB，key=id）。 */
export interface AvatarMeta {
  id: string;
  /** 显示名（manifest Name 或 zip 文件名）。 */
  name: string;
  /** 原始 zip 文件名。 */
  fileName: string;
  /** zip 内选定的 model3.json 路径。 */
  manifest: string;
  /** zip 体积（字节）。 */
  size: number;
  addedAt: string;
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
  emotion?: EmotionTag;
  at: string;
}

export type ChatStatus = "idle" | "listening" | "thinking" | "speaking";

/** /api/state 持久化载荷（backend state.json ↔ localStorage 缓存共用 schema）。 */
export interface PersistedState {
  settings: Settings;
  persona: PersonaCard;
  /** 初始记忆（pin）：用户维护的常驻事实，backend 注入 system prompt。 */
  pins: string[];
  /** 用户导入的 Live2D 模型清单（blob 在 IndexedDB）。 */
  avatars: AvatarMeta[];
  /** 当前形象：内置 id 或 avatars[].id。 */
  avatarId: string;
}
