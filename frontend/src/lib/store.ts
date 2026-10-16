// localStorage 持久化 + useSyncExternalStore 订阅。
// 所有跨页面共享状态（设置/人设/初始记忆 pin/形象清单）的唯一入口。
// 普通记忆与对话历史归 backend 管，不进本 store。

import type {
  AvatarMeta,
  AvatarResources,
  McpExtension,
  PersistedState,
  PersonaCard,
  Settings,
} from "./types";
import { fetchState, putState } from "../services/stateClient";

export type { PersistedState };

const STORAGE_KEY = "momo-web.v1";

/** 内置模型（Hiyori）的 avatarId 取值。 */
export const AVATAR_BUILTIN = "builtin";

/**
 * 内置 Hiyori 的资源清单（vendored manifest 的固定值；desc 可在设置页改）。
 * 描述语义沿用内置情绪映射表的选型：m03=害羞 m04=开心 m06=思考
 * m07=惊讶 m08=难过 m09=生气 m10=困倦；m01/m02/m05 为通用待机动作。
 * 模型没有 .exp3.json，expressions 为空（表情段不注入 prompt）。
 */
const BUILTIN_RESOURCES: AvatarResources = {
  expressions: [],
  motions: [
    { name: "Idle/0", desc: "待机轻晃" },
    { name: "Idle/1", desc: "待机动作" },
    { name: "Idle/2", desc: "害羞地低头" },
    { name: "Idle/3", desc: "待机动作" },
    { name: "Idle/4", desc: "思考的样子" },
    { name: "Idle/5", desc: "惊讶" },
    { name: "Idle/6", desc: "难过" },
    { name: "Idle/7", desc: "生气" },
    { name: "Idle/8", desc: "困倦" },
    { name: "TapBody/0", desc: "开心地蹦一下" },
  ],
};

/** 内置形象条目：始终位于 avatars[0]，不可删除。 */
function builtinAvatar(): AvatarMeta {
  return {
    id: AVATAR_BUILTIN,
    builtin: true,
    name: "Hiyori",
    fileName: "",
    manifest: "Hiyori.model3.json",
    size: 0,
    addedAt: "",
    resources: structuredClone(BUILTIN_RESOURCES),
  };
}

const DEFAULT_SETTINGS: Settings = {
  general: {
    lang: "zh",
    chatLang: "auto",
    dialogOpacity: 66,
    textSpeed: 60,
    sentenceSpeed: 60,
    voiceVolume: 100,
    showStatus: true,
    voiceInput: true,
  },
  // 服务地址与模型一律留空：新用户按输入框里的灰色提示自己填。
  // 这里曾经预填过 deepseek / 本机端口 / 某台内网 embedding 服务器的地址 ——
  // 那些是开发者的环境，不该随仓库发给每个 clone 的人。
  llm: { url: "", key: "", model: "" },
  asr: { url: "", key: "" },
  tts: { url: "", key: "", voice: "" },
  embedding: { url: "", key: "", model: "" },
  extensions: [],
};

/**
 * 出厂人设。identity/personality 留空：它们是「按对话语言取」的文案，由
 * i18n 的 persona.defaults.*（placeholder）与 backend prompt 的 _T（注入回落）
 * 各自解析，不把某一种语言写死成配置数据。
 * preferences 不种默认值：空 = 无偏好，prompt 侧整段不注入。
 */
export const DEFAULT_PERSONA: PersonaCard = {
  name: "momo",
  identity: "",
  personality: "",
  age: 16,
  preferences: [],
};

function defaults(): PersistedState {
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    persona: structuredClone(DEFAULT_PERSONA),
    avatars: [builtinAvatar()],
    avatarId: AVATAR_BUILTIN,
  };
}

/** 存储后端抽象：浏览器 localStorage / 无窗口环境内存实现。 */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function defaultBackend(): StorageLike {
  if (typeof globalThis.localStorage !== "undefined") return globalThis.localStorage;
  return createMemoryStorage();
}

let backend: StorageLike = defaultBackend();

/**
 * schema 外顶层字段（将来新增字段）：读取时记下、PUT 时原样带上——
 * PUT 是整体替换，不透传会把它们抹掉。
 */
let passthrough: Record<string, unknown> = {};
const KNOWN_KEYS = new Set(["settings", "persona", "avatars", "avatarId"]);

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** persona 归一化：逐字段与默认合并。 */
function normalizePersona(raw: unknown, d: PersonaCard): PersonaCard {
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Record<string, unknown>;
  return {
    name: typeof o.name === "string" ? o.name : d.name,
    identity: typeof o.identity === "string" ? o.identity : d.identity,
    age:
      typeof o.age === "number" && Number.isFinite(o.age) ? o.age : d.age,
    personality:
      typeof o.personality === "string" ? o.personality : d.personality,
    preferences: Array.isArray(o.preferences)
      ? strArr(o.preferences)
      : d.preferences,
  };
}

/** avatars 归一化：保证内置条目在首位；内置条目缺 resources 时补出厂清单
 * （导入条目缺省保留 undefined——设置页再按需懒解析 zip 补回）。 */
function normalizeAvatars(raw: unknown): AvatarMeta[] {
  const list = (Array.isArray(raw) ? raw : []).filter(
    (a): a is AvatarMeta =>
      !!a && typeof a === "object" && typeof (a as AvatarMeta).id === "string",
  );
  const norm = list.map((a) =>
    a.id === AVATAR_BUILTIN
      ? {
          ...a,
          builtin: true as const,
          resources: a.resources ?? structuredClone(BUILTIN_RESOURCES),
        }
      : a,
  );
  if (!norm.some((a) => a.id === AVATAR_BUILTIN)) norm.unshift(builtinAvatar());
  return norm;
}

/** extensions 归一化：逐条补默认字段，非对象条目丢弃；enabled 缺省视为开。
 *  旧 apiKey 字段已废除——读到直接丢弃，不做迁移。 */
function normalizeExtensions(raw: unknown): McpExtension[] {
  const strDict = (v: unknown): Record<string, string> =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).filter(
            (e): e is [string, string] => typeof e[1] === "string",
          ),
        )
      : {};
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((o) => ({
      name: typeof o.name === "string" ? o.name : "",
      transport: o.transport === "stdio" ? ("stdio" as const) : ("http" as const),
      enabled: o.enabled !== false,
      command: typeof o.command === "string" ? o.command : "",
      args: strArr(o.args),
      env: strDict(o.env),
      endpoint: typeof o.endpoint === "string" ? o.endpoint : "",
      headers: strDict(o.headers),
    }));
}

/** 记下 schema 外顶层字段，PUT 时原样带回。 */
function capturePassthrough(raw: Record<string, unknown>): void {
  for (const k of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(k)) passthrough[k] = raw[k];
  }
}

let state: PersistedState = load();
const listeners = new Set<() => void>();

function merge(parsed: Partial<PersistedState>): PersistedState {
  const d = defaults();
  const s = parsed.settings;
  capturePassthrough(parsed as Record<string, unknown>);
  const avatars = normalizeAvatars(parsed.avatars ?? d.avatars);
  return {
    settings: {
      general: { ...d.settings.general, ...s?.general },
      llm: { ...d.settings.llm, ...s?.llm },
      asr: { ...d.settings.asr, ...s?.asr },
      tts: { ...d.settings.tts, ...s?.tts },
      embedding: { ...d.settings.embedding, ...s?.embedding },
      extensions: normalizeExtensions(s?.extensions),
    },
    persona: normalizePersona(parsed.persona, d.persona),
    avatars,
    avatarId:
      parsed.avatarId && avatars.some((a) => a.id === parsed.avatarId)
        ? parsed.avatarId
        : AVATAR_BUILTIN,
  };
}

function load(): PersistedState {
  try {
    const raw = backend.getItem(STORAGE_KEY);
    if (!raw) return defaults();
    return merge(JSON.parse(raw) as Partial<PersistedState>);
  } catch {
    return defaults();
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

const inBrowser = (): boolean =>
  typeof window !== "undefined" && typeof fetch === "function";

/**
 * 启动时从 backend 恢复配置（backend 权威，localStorage 仅离线缓存）。
 * backend 无数据或不可达时静默维持 localStorage 态。
 */
export async function bootPersist(): Promise<void> {
  if (!inBrowser()) return;
  const remote = await fetchState();
  if (!remote) return;
  state = merge(remote);
  persist();
}

/** 防抖 PUT /api/state；失败静默（localStorage 仍兜底）。 */
function remoteSave(): void {
  if (!inBrowser()) return;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void putState({ ...passthrough, ...state });
  }, 300);
}

function persist(): void {
  try {
    backend.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储满/隐私模式：内存态仍然生效
  }
  remoteSave();
}

export function getState(): PersistedState {
  return state;
}

/**
 * 外部改动 backend state 后（如读档）重拉 passthrough。
 * 先掐掉在途防抖写：它携带的仍是改动前的 passthrough。
 */
export async function resyncPassthrough(): Promise<void> {
  if (!inBrowser()) return;
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const remote = await fetchState();
  if (!remote) return;
  passthrough = {};
  capturePassthrough(remote as Record<string, unknown>);
}

export function getSettings(): Settings {
  return state.settings;
}

/** 铭牌/说话人显示名：人设卡名留空时退回默认。 */
export function personaName(): string {
  return state.persona.name || DEFAULT_PERSONA.name;
}

export function getAvatars(): AvatarMeta[] {
  return state.avatars;
}

export function getAvatarId(): string {
  return state.avatarId;
}

/** 局部更新 + 持久化 + 通知订阅者。 */
export function update(patch: Partial<PersistedState>): void {
  state = { ...state, ...patch };
  persist();
  for (const l of listeners) l();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function newId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replaceAll("-", "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}
