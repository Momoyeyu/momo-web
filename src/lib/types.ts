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

/** 界面语言（i18n）；新增语言同时在 i18n/ 注册字典。 */
export type Lang = "zh" | "ja" | "en";

/** 通用设置（语言等，与具体服务无关）。 */
export interface GeneralConfig {
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
}

export type MemoryKind = "semantic" | "episodic" | "procedural";

export const MEMORY_KINDS: readonly MemoryKind[] = [
  "semantic",
  "episodic",
  "procedural",
];

export interface Memory {
  id: string;
  kind: MemoryKind;
  content: string;
  createdAt: string;
  updatedAt: string;
  /** 来源描述（回合序号 / "manual"）。 */
  source: string;
  /** false = 已被取代或删除（仅审计可见，不参与召回）。 */
  valid: boolean;
  /** 指向取代它的条目 id；用户删除时为 "void:delete"。 */
  supersededBy?: string;
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

/** 用户身份：帮 momo 理解「对方是谁、你们什么关系」，注入 system prompt。 */
export interface UserProfile {
  /** momo 对用户的称呼。 */
  name: string;
  /** momo 与用户的关系（自由文本，如「朋友」「搭档」）。 */
  relation: string;
  /** 补充画像（原 humanBlock 自由文本）。 */
  note: string;
}

/** 人设卡（persona 页可编辑；渲染进 system prompt）。 */
export interface PersonaCard {
  name: string;
  oneLiner: string;
  /** 身份描述（物种/自我认知）。 */
  identity: string;
  likes: string[];
  dislikes: string[];
  traits: string[];
  tone: string;
  taboos: string[];
  examples: { user: string; assistant: string }[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  emotion?: EmotionTag;
  at: string;
}

export type ChatStatus = "idle" | "listening" | "thinking" | "speaking";
