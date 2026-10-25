// localStorage 持久化 + useSyncExternalStore 订阅。
// 所有跨页面共享状态（设置/形象清单）的唯一入口。
// 普通记忆与对话历史归 backend 管，不进本 store。

import type {
  AvatarMeta,
  McpExtension,
  PersistedState,
  Settings,
} from "./types";
import { mergeBuiltinResources } from "../live2d/controlCatalog";
import { fetchState, putState } from "../services/stateClient";

export type { PersistedState };

const STORAGE_KEY = "momo-web.v1";

/** 内置模型（Hiyori）的 avatarId 取值。 */
export const AVATAR_BUILTIN = "builtin";

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
    resources: mergeBuiltinResources(),
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
  llm: { url: "", key: "", model: "", thinking: false },
  tts: { url: "", key: "", voice: "", prompt: "" },
  extensions: [],
};

/** 说话人显示名（铭牌、backlog 用）。人设本体在 backend/resources/soul.md，
 *  前端只需要一个显示名 —— 改人设名时两处一起改。 */
export const SPEAKER_NAME = "momo";

function defaults(): PersistedState {
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
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
const KNOWN_KEYS = new Set(["settings", "avatars", "avatarId"]);

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

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
          resources: mergeBuiltinResources(a.resources),
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
      llm: { ...d.settings.llm, ...s?.llm, thinking: s?.llm?.thinking === true },
      tts: { ...d.settings.tts, ...s?.tts },
      extensions: normalizeExtensions(s?.extensions),
    },
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
let saveInFlight: Promise<boolean> = Promise.resolve(true);
let persistencePaused = 0;
let saveQueued = false;

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
  if (persistencePaused) { saveQueued = true; return; }
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const snapshot = { ...passthrough, ...state };
    saveInFlight = saveInFlight.then(() => putState(snapshot));
  }, 300);
}

/** Hold debounced writes across a consistent backup or destructive restore.
 * Successful restore leaves the hold active until document reload; otherwise
 * an old local calibration update could overwrite the imported configuration.
 */
export async function pausePersistence(): Promise<() => void> {
  persistencePaused++;
  if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
  saveQueued = false;
  const resume = (): void => {
    persistencePaused--;
    if (!persistencePaused && saveQueued) { saveQueued = false; remoteSave(); }
  };
  try {
    await saveInFlight;
    if (inBrowser() && !await putState({ ...passthrough, ...state }))
      throw new Error('Could not save configuration');
    return resume;
  } catch (error) { resume(); throw error; }
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
export function speakerName(): string {
  return SPEAKER_NAME;
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
