// 记忆客户端：/api/memories CRUD（普通记忆；pins 走 /api/state）。

import { apiFetch, apiJson, jsonInit } from "./http";
import type { Memory } from "../lib/types";

const API = "/api/memories";

export function listMemories(): Promise<Memory[]> {
  return apiJson<Memory[]>(API);
}

export async function addMemory(content: string): Promise<string> {
  const res = await apiJson<{ id: string }>(API, jsonInit("POST", { content }));
  return res.id;
}

export function editMemory(id: string, content: string): Promise<Memory> {
  return apiJson<Memory>(`${API}/${id}`, jsonInit("PATCH", { content }));
}

export async function deleteMemory(id: string): Promise<void> {
  await apiFetch(`${API}/${id}`, { method: "DELETE" });
}
