// 三语字典的键必须完全一致，界面用到的键必须真的解析出文案。
//
// 为什么需要这条：i18n 是运行时取值 —— 删错一个键 tsc 不会报错、其它单测也发现不了。
// 曾经误删 settings.title（正则匹配过宽），界面直接把 "settings.title" 显示在工具条上，
// 是 E2E 才抓到的。这里在 unit 层把它拦住。
import { describe, expect, it } from "vitest";

import { en } from "./en";
import { ja } from "./ja";
import { t } from "./index";
import { zh } from "./zh";

function keyPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    keyPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

const DICTS = { zh, ja, en };

describe("三语字典", () => {
  it("三份字典的键集合完全一致（漏翻或删错键在这里红）", () => {
    const base = keyPaths(zh).sort();
    expect(keyPaths(ja).sort()).toEqual(base);
    expect(keyPaths(en).sort()).toEqual(base);
  });

  it("界面用到的关键键不会退化成 key 本身", () => {
    // 这几条是曾经出过问题的位置：工具条、backlog 标题、卡片操作
    const keys = ["settings.title", "backlog.title", "common.edit", "common.del", "social.login.title", "social.login.states.qr_pending", "social.login.errors.RESOURCE_UNAVAILABLE"];
    for (const [lang, dict] of Object.entries(DICTS)) {
      for (const key of keys) {
        const value = key
          .split(".")
          .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], dict);
        expect(value, `${lang} 缺 ${key}`).toBeTypeOf("string");
        expect(value, `${lang} 的 ${key} 退化成了键名`).not.toBe(key);
      }
    }
  });

  it("t() 取到的就是字典里的值", () => {
    expect(t("settings.title")).toBe(zh.settings.title);
  });
});
