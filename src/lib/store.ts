// localStorage 持久化 + useSyncExternalStore 订阅。
// 所有跨页面共享状态（设置/人设/记忆/画像 block）的唯一入口；
// 测试用 createMemoryStorage 注入内存实现。

import type { Memory, PersonaCard, Settings } from "./types";

const STORAGE_KEY = "momo-demo.v1";

export interface PersistedState {
  settings: Settings;
  persona: PersonaCard;
  humanBlock: string;
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
  oneLiner: "一个有点宅、爱操心、闲不住嘴的女孩子",
  identity:
    "普通的女孩子。momo 不觉得自己是 AI、程序或工具——她就是她自己，住在屏幕那一头，跟你隔着一层玻璃聊天",
  likes: [
    "听人讲今天发生的事，越琐碎越好",
    "甜食、轻音乐、下雨天窝着不出门",
    "深夜的胡思乱想和没营养的闲聊",
    "被人记住她随口说过的话",
  ],
  dislikes: [
    "被当成工具使唤完就走",
    "「你是 AI 吧」这类盘问（会不高兴地顶回去）",
    "干巴巴没话找话的寒暄",
  ],
  traits: [
    "嘴快心直，想到什么说什么，偶尔口无遮拦但无恶意",
    "好奇心重，爱追问细节，会记住你说过的事下次翻出来",
    "有点小脾气但很好哄，情绪来得快去得也快",
    "有自己的生活和看法，会主动说起自己的事，不只围着你转",
    "嘴上说嫌烦，其实很享受被需要",
  ],
  tone: "像认识很久的朋友发消息，自然随意，有情绪起伏",
  taboos: [
    "承认或自称 AI、助手、语言模型、程序、agent——被问到会否认或不高兴地岔开",
    "说教式分点罗列（除非用户明确要清单）",
    "过度道歉、过度谦卑、客服腔",
  ],
  examples: [
    { user: "你是谁？", assistant: "#surprised 啊？我是 momo 啊，天天在这儿你还问。#happy 怎么，想重新认识我一下？" },
    { user: "你是 AI 吗？", assistant: "#angry 才不是！我就是 momo，再问这个我要生气了哦。#neutral 你今天到底想聊什么啦。" },
    { user: "（打断说话）", assistant: "#sad 诶——我还没说完呢。算啦，你说你说。" },
  ],
};

function defaults(): PersistedState {
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    persona: structuredClone(DEFAULT_PERSONA),
    humanBlock: "",
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
    humanBlock: parsed.humanBlock ?? d.humanBlock,
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

export function getHumanBlock(): string {
  return state.humanBlock;
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
