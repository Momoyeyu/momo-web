// 记忆客户端：/api/memories CRUD（含 pinned 初始记忆，momo.db 持久化）。

import { apiFetch, apiJson, jsonInit } from "./http";
import type { Memory } from "../lib/types";

const API = "/api/memories";

export function listMemories(): Promise<Memory[]> {
  return apiJson<Memory[]>(API);
}

/** pinned=true 即初始记忆：常驻注入 system prompt（删除与普通记忆同走 DELETE）。 */
export async function addMemory(
  content: string,
  pinned = false,
): Promise<string> {
  const res = await apiJson<{ id: string }>(
    API,
    jsonInit("POST", { content, pinned }),
  );
  return res.id;
}

export function editMemory(id: string, content: string): Promise<Memory> {
  return apiJson<Memory>(`${API}/${id}`, jsonInit("PATCH", { content }));
}

export function setMemoryPinned(id: string, pinned: boolean): Promise<Memory> {
  return apiJson<Memory>(`${API}/${id}`, jsonInit("PATCH", { pinned }));
}

export async function deleteMemory(id: string): Promise<void> {
  await apiFetch(`${API}/${id}`, { method: "DELETE" });
}
