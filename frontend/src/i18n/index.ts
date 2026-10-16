// i18n：字典按语言分文件（zh 为 key 结构基准），t() 支持 {var} 插值。
// 新增语言：创建 xx.ts（ satisfies Dict 同形 ）→ 在 DICTS 注册一行 →
// settings.langs 字典加显示名即可。

import { useSyncExternalStore } from "react";
import { getSettings, subscribe } from "../lib/store";
import type { GeneralConfig, Lang } from "../lib/types";
import { zh } from "./zh";
import type { Dict } from "./zh";
import { ja } from "./ja";
import { en } from "./en";

export type { Dict };

const DICTS: Record<Lang, Dict> = { zh, ja, en };

export const LANGS: readonly Lang[] = ["zh", "ja", "en"];

export function currentLang(): Lang {
  return getSettings().general.lang;
}

/**
 * 解析对话语言（纯函数，便于非组件处与测试使用）。
 *
 * settings.general.chatLang；auto/缺失 → 回落界面语言 lang；未知 → zh。
 * 语义与后端 prompt._lang_of 对齐。
 */
export function resolvePromptLang(g: GeneralConfig): Lang {
  const raw = String(g.chatLang || "").toLowerCase();
  const code = !raw || raw === "auto" ? String(g.lang || "zh").toLowerCase() : raw;
  for (const l of LANGS) {
    if (code.startsWith(l)) return l;
  }
  return "zh";
}

/**
 * momo 对话语言（settings.general.chatLang；auto/缺失 → 回落界面语言）。
 *
 * prompt 组装、出厂默认人设、TTS 合成语言都按它选，语义与后端
 * prompt._lang_of 对齐；取词用 tFor(promptLang(), …) 而不是 t()（后者跟界面语言）。
 */
export function promptLang(): Lang {
  return resolvePromptLang(getSettings().general);
}

function lookup(dict: Dict, key: string): string | undefined {
  let cur: unknown = dict;
  for (const seg of key.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return typeof cur === "string" ? cur : undefined;
}

/** 取翻译；缺失时回落中文，再回落 key 本身。{k} 用 vars 替换。 */
export function t(key: string, vars?: Record<string, string>): string {
  let s = lookup(DICTS[currentLang()], key) ?? lookup(zh, key) ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, v);
    }
  }
  return s;
}

/** 指定语言取词（不跟随界面语言）——用于按「对话语言」渲染的预览文案。 */
export function tFor(
  lang: Lang,
  key: string,
  vars?: Record<string, string>,
): string {
  let s = lookup(DICTS[lang], key) ?? lookup(zh, key) ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, v);
    }
  }
  return s;
}

/** React hook：语言变更触发重渲染。 */
export function useT(): (key: string, vars?: Record<string, string>) => string {
  useSyncExternalStore(subscribe, currentLang);
  return t;
}
