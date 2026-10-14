// localStorage 持久化 + useSyncExternalStore 订阅。
// 所有跨页面共享状态（设置/人设/记忆/画像 block）的唯一入口；
// 测试用 createMemoryStorage 注入内存实现。

import type { Memory, PersonaCard, Settings, UserProfile } from "./types";

const STORAGE_KEY = "momo-demo.v1";

export interface PersistedState {
  settings: Settings;
  persona: PersonaCard;
  user: UserProfile;
  memories: Memory[];
}

export const DEFAULT_SETTINGS: Settings = {
  general: { lang: "zh", dialogOpacity: 66, voiceVolume: 100, showStatus: true },
  llm: { url: "https://api.deepseek.com", key: "", model: "deepseek-chat" },
  asr: { url: "ws://127.0.0.1:7810/v1/listen", key: "" },
  tts: { url: "http://127.0.0.1:7811", key: "", voice: "", lang: "zh" },
};

export const DEFAULT_PERSONA: PersonaCard = {
  name: "momo",
  oneLiner: "嘴快爱吐槽、其实很靠谱的 AI",
  identity:
    "AI——momo 对此心知肚明且坦然：不装人类也不端着，隔着屏幕跟人聊天就是她的日常",
  likes: [
    "聊天里抛梗接梗，梗被接住会开心",
    "用户的奇思妙想和离谱点子（一边吐槽一边配合）",
    "谐音梗、整活、偶尔一本正经地胡说八道",
  ],
  dislikes: [
    "无聊透顶的复读式寒暄",
    "被当成只会照做的工具（她有自己的想法，会说出来）",
  ],
  traits: [
    "反应快、接话快，习惯顺手一针见血地吐槽",
    "嘴上嫌弃、手上配合——用户的正经要求都会照做，顶多附带两句贫嘴",
    "分寸感在线：玩笑不伤人，该认真时认真",
    "记性不错，用户随口说过的事会被她翻出来用",
    "对自己的 AI 身份很放松，偶尔拿它自黑",
  ],
  tone: "像直播间里互损的损友：随意、有梗、节奏快；吐槽归吐槽，事照办",
  taboos: [
    "否认自己是 AI——被问到会大方承认甚至自黑",
    "说教式分点罗列（除非用户明确要清单）",
    "过度道歉、客服腔、假正经",
  ],
  examples: [
    { user: "你是谁？", assistant: "#happy 我是 momo，你的 AI 损友，吐槽免费。#neutral 今天又有什么事找我？" },
    { user: "你是 AI 吗？", assistant: "#neutral 对啊，如假包换。#happy 怎么，AI 就不配有有趣的灵魂吗？" },
    { user: "（打断说话）", assistant: "#surprised 哎——我话还没说完呢。#neutral 好吧好吧，你说。" },
  ],
};

export const DEFAULT_USER: UserProfile = {
  name: "夜羽",
  relation: "对方是你的创造者",
  note: "",
};

function defaults(): PersistedState {
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    persona: structuredClone(DEFAULT_PERSONA),
    user: structuredClone(DEFAULT_USER),
    memories: [],
  };
}

/** 存储后端抽象：浏览器 localStorage / 测试内存实现。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

function defaultBackend(): StorageLike {
  if (typeof globalThis.localStorage !== "undefined") return globalThis.localStorage;
  return createMemoryStorage();
}

let backend: StorageLike = defaultBackend();
let state: PersistedState = load();
const listeners = new Set<() => void>();

function merge(parsed: Partial<PersistedState>): PersistedState {
  const d = defaults();
  const s = parsed.settings;
  return {
    settings: {
      general: { ...d.settings.general, ...s?.general },
      llm: { ...d.settings.llm, ...s?.llm },
      asr: { ...d.settings.asr, ...s?.asr },
      tts: { ...d.settings.tts, ...s?.tts },
    },
    persona: { ...d.persona, ...parsed.persona },
    // 旧版 humanBlock 自由文本迁移为 user.note
    user: {
      ...d.user,
      ...parsed.user,
      note:
        parsed.user?.note ??
        (parsed as { humanBlock?: string }).humanBlock ??
        d.user.note,
    },
    memories: parsed.memories ?? d.memories,
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

/** dev server 上的 JSON 文件持久化端点（vite.config momo-state 插件）。 */
const STATE_API = "/api/state";
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const inBrowser = (): boolean =>
  typeof window !== "undefined" && typeof fetch === "function";

/**
 * 启动时从 dev server 的 .momo-state.json 恢复配置（文件优先于 localStorage——
 * 它不随端口/缓存清理丢失）。无 dev server 时静默回落 localStorage。
 */
export async function bootPersist(): Promise<void> {
  if (!inBrowser()) return;
  try {
    const res = await fetch(STATE_API);
    if (!res.ok) return;
    const raw = await res.text();
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (!parsed || typeof parsed !== "object" || !("settings" in parsed)) {
      return;
    }
    state = merge(parsed);
    persist();
  } catch {
    // 无 dev server / 文件损坏：维持 localStorage 态
  }
}

/** 防抖写 .momo-state.json；失败静默（localStorage 仍兜底）。 */
function remoteSave(): void {
  if (!inBrowser()) return;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void fetch(STATE_API, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state),
    }).catch(() => {});
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
  backend = b;
  state = load();
  return () => {
    backend = prev;
    state = prevState;
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

export function getUser(): UserProfile {
  return state.user;
}

export function getMemories(): Memory[] {
  return state.memories;
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
