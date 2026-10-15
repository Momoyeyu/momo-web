// 会话存档客户端：/api/sessions 槽位 REST（Save/Load）。
// 保存 = 快照 backend 当前会话；读取 = 存档覆盖当前会话（返回全文供引擎灌入）。

import { apiFetch, apiJson, jsonInit } from "./http";
import type { SessionMeta, SessionSave } from "../lib/types";

const API = "/api/sessions";

export function listSessions(): Promise<SessionMeta[]> {
  return apiJson<SessionMeta[]>(API);
}

/** 新建存档：slot 指定目标空槽（1–120），未指定由 backend 取最小编号空槽。 */
export async function createSession(
  title?: string,
  slot?: number,
): Promise<{ id: string; slot: number }> {
  return apiJson<{ id: string; slot: number }>(
    API,
    jsonInit("POST", { title, slot }),
  );
}

export function getSession(id: string): Promise<SessionSave> {
  return apiJson<SessionSave>(`${API}/${id}`);
}

/** 覆盖写入（title 非空时同时重命名）。 */
export function overwriteSession(
  id: string,
  title?: string,
): Promise<SessionMeta> {
  return apiJson<SessionMeta>(`${API}/${id}`, jsonInit("PUT", { title }));
}

export async function deleteSession(id: string): Promise<void> {
  await apiFetch(`${API}/${id}`, { method: "DELETE" });
}

/** 读取存档：覆盖当前会话，返回存档全文（messages 灌进引擎）。 */
export function loadSession(id: string): Promise<SessionSave> {
  return apiJson<SessionSave>(`${API}/${id}/load`, { method: "POST" });
}
