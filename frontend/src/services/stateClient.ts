// state 客户端：GET/PUT /api/state。backend 权威，localStorage 是离线缓存；
// 不可达/空/非法一律返回 null/false，由调用方静默降级。

import { apiFetch, jsonInit } from "./http";
import type { PersistedState } from "../lib/types";

const STATE_API = "/api/state";

/** 拉取远端 state；不可达/空/非法返回 null。 */
export async function fetchState(): Promise<Partial<PersistedState> | null> {
  try {
    const raw = await apiFetch(STATE_API).then((r) => r.text());
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (!parsed || typeof parsed !== "object" || !("settings" in parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** 整体写入远端 state；成功 true，失败 false。 */
export async function putState(state: Record<string, unknown>, signal?: AbortSignal): Promise<boolean> {
  try {
    await apiFetch(STATE_API, {...jsonInit("PUT", state), signal});
    return true;
  } catch {
    return false;
  }
}
