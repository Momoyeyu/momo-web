// localStorage 持久化 + useSyncExternalStore 订阅。
// 所有跨页面共享状态（设置/人设/初始记忆 pin/形象清单）的唯一入口；
// 测试用 createMemoryStorage 注入内存实现。
// 普通记忆与对话历史归 backend 管，不进本 store。

import type {
  AvatarMeta,
  Memory,
  PersistedState,
  PersonaCard,
  Settings,
} from "./types";
import { fetchState, putState } from "../services/stateClient";

export type { PersistedState };

const STORAGE_KEY = "momo-web.v1";
/** momo-demo 时代的旧 key：首次读取时迁移（读旧→写新→删旧）。 */
const LEGACY_STORAGE_KEY = "momo-demo.v1";

/** 内置模型（Hiyori）的 avatarId 取值。 */
export const AVATAR_BUILTIN = "builtin";

export const DEFAULT_SETTINGS: Settings = {
  general: { lang: "zh", dialogOpacity: 66, voiceVolume: 100, showStatus: true },
  llm: { url: "https://api.deepseek.com", key: "", model: "deepseek-chat" },
  asr: { url: "ws://127.0.0.1:7810/v1/listen", key: "" },
  tts: { url: "http://127.0.0.1:7811", key: "", voice: "", lang: "zh" },
};

export const DEFAULT_PERSONA: PersonaCard = {
  name: "momo",
  identity: "AI",
  age: 16,
  personality: "乖巧听话",
  preferences: ["喜欢草莓蛋糕", "讨厌苦的东西"],
};

export const DEFAULT_PINS: string[] = [
  "用户的名称是夜羽",
  "夜羽是我的创造者",
];

function defaults(): PersistedState {
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    persona: structuredClone(DEFAULT_PERSONA),
    pins: [...DEFAULT_PINS],
    avatars: [],
    avatarId: AVATAR_BUILTIN,
  };
}

/** 存储后端抽象：浏览器 localStorage / 测试内存实现。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createMemoryStorage(): StorageLike {
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

/** 旧 schema 遗留的普通记忆：随下一次 PUT /api/state 透传给 backend 导入一次，随后丢弃。 */
let legacyMemories: Memory[] | null = null;

/**
 * schema 外顶层字段（backend 维护的 history、以及将来的新字段）：
 * 读取时记下、PUT 时原样带上——PUT 是整体替换，不透传会把它们抹掉。
 * user/memories/humanBlock 属旧 schema，被 migrate 消费，不透传。
 */
let passthrough: Record<string, unknown> = {};
const KNOWN_KEYS = new Set([
  "settings",
  "persona",
  "pins",
  "avatars",
  "avatarId",
  "user",
  "memories",
  "humanBlock",
]);

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * persona 归一化：新 schema 逐字段合并；旧 schema（oneLiner/likes/
 * dislikes/traits/tone/taboos/examples）映射——name/identity 保留，
 * personality ← traits.join("，")，preferences ← likes+dislikes 改写。
 */
function migratePersona(raw: unknown, d: PersonaCard): PersonaCard {
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Record<string, unknown>;
  if (typeof o.personality === "string" || Array.isArray(o.preferences)) {
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
  const traits = strArr(o.traits);
  const likes = strArr(o.likes);
  const dislikes = strArr(o.dislikes);
  const migrated = [
    ...likes.map((x) => `喜欢${x}`),
    ...dislikes.map((x) => `讨厌${x}`),
  ];
  return {
    name: typeof o.name === "string" && o.name ? o.name : d.name,
    identity: typeof o.identity === "string" && o.identity ? o.identity : d.identity,
    age: d.age,
    personality: traits.length ? traits.join("，") : d.personality,
    preferences: migrated.length ? migrated : d.preferences,
  };
}

/**
 * pins 归一化：新 schema 原样采用；旧版 user{name,relation,note} 迁移为
 * `用户的名称是${name}` + relation/note 原文各一条（空字段跳过）。
 */
function migratePins(raw: Record<string, unknown>, d: string[]): string[] {
  if (Array.isArray(raw.pins)) return strArr(raw.pins);
  const u = raw.user;
  if (u && typeof u === "object") {
    const o = u as Record<string, unknown>;
    const pins: string[] = [];
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (name) pins.push(`用户的名称是${name}`);
    const relation = typeof o.relation === "string" ? o.relation.trim() : "";
    if (relation) pins.push(relation);
    const note =
      typeof o.note === "string"
        ? o.note.trim()
        : typeof raw.humanBlock === "string"
          ? raw.humanBlock.trim()
          : "";
    if (note) pins.push(note);
    return pins;
  }
  return d;
}

/** parsed 里夹着旧版 memories 数组时接住，留待下一次 PUT 带给 backend 导入。 */
function captureLegacyMemories(raw: Record<string, unknown>): void {
  const m = raw.memories;
  if (!Array.isArray(m) || !m.length) return;
  legacyMemories = m.filter(
    (x): x is Memory =>
      !!x && typeof x === "object" && typeof (x as Memory).content === "string",
  );
  if (!legacyMemories.length) legacyMemories = null;
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
  captureLegacyMemories(parsed as Record<string, unknown>);
  capturePassthrough(parsed as Record<string, unknown>);
  return {
    settings: {
      general: { ...d.settings.general, ...s?.general },
      llm: { ...d.settings.llm, ...s?.llm },
      asr: { ...d.settings.asr, ...s?.asr },
      tts: { ...d.settings.tts, ...s?.tts },
    },
    persona: migratePersona(parsed.persona, d.persona),
    pins: migratePins(parsed as Record<string, unknown>, d.pins),
    avatars: parsed.avatars ?? d.avatars,
    avatarId:
      parsed.avatarId &&
      (parsed.avatarId === AVATAR_BUILTIN ||
        (parsed.avatars ?? []).some((a) => a.id === parsed.avatarId))
        ? parsed.avatarId
        : AVATAR_BUILTIN,
  };
}

/** 旧 key 迁移：新 key 无数据且旧 key 有 → 读旧→写新→删旧。 */
function migrateStorageKey(): void {
  try {
    if (backend.getItem(STORAGE_KEY)) return;
    const old = backend.getItem(LEGACY_STORAGE_KEY);
    if (!old) return;
    backend.setItem(STORAGE_KEY, old);
    backend.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // 迁移失败无碍：按无存档走默认
  }
}

function load(): PersistedState {
  migrateStorageKey();
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

/** 防抖 PUT /api/state；失败静默（localStorage 仍兜底）。
 *  带一次旧版 memories 透传：首个成功 PUT 后丢弃该字段。 */
function remoteSave(): void {
  if (!inBrowser()) return;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const body: Record<string, unknown> = {
      ...passthrough,
      ...state,
      ...(legacyMemories ? { memories: legacyMemories } : {}),
    };
    void putState(body).then((ok) => {
      // backend 已收到旧 memories（会自行导入），本地不再携带
      if (ok) legacyMemories = null;
    });
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

/** 测试注入内存后端；返回恢复函数。 */
export function _setBackendForTest(b: StorageLike): () => void {
  const prev = backend;
  const prevState = state;
  const prevLegacy = legacyMemories;
  const prevPassthrough = passthrough;
  backend = b;
  legacyMemories = null;
  passthrough = {};
  state = load();
  return () => {
    backend = prev;
    state = prevState;
    legacyMemories = prevLegacy;
    passthrough = prevPassthrough;
  };
}

export function getState(): PersistedState {
  return state;
}

export function getSettings(): Settings {
  return state.settings;
}

export function getPersona(): PersonaCard {
  return state.persona;
}

/** 铭牌/说话人显示名：人设卡名留空时退回默认。 */
export function personaName(): string {
  return state.persona.name || DEFAULT_PERSONA.name;
}

export function getPins(): string[] {
  return state.pins;
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
