// 会话存档客户端：/api/checkpoints 槽位 REST（Save/Load）。
// 保存 = 快照 backend 当前会话；读取 = 存档覆盖当前会话（返回全文供引擎灌入）。

import { apiFetch, apiJson, jsonInit } from "./http";
import type { CheckpointCreated, LiveTranscript } from "../api/types";
import type {
  CheckpointMessage,
  CheckpointMeta,
  CheckpointSave,
} from "../lib/types";

const API = "/api/checkpoints";

export function listCheckpoints(): Promise<CheckpointMeta[]> {
  return apiJson<CheckpointMeta[]>(API);
}

/** 当前 live 会话全文：启动时恢复 backlog/字幕（backend momo.db 权威）。 */
export function liveTranscript(): Promise<LiveTranscript> {
  return apiJson<{ summary: string; messages: CheckpointMessage[] }>(
    `${API}/live`,
  );
}

/** 新建存档：slot 指定目标空槽（1–120），未指定由 backend 取最小编号空槽。 */
export async function createCheckpoint(
  title?: string,
  slot?: number,
): Promise<CheckpointCreated> {
  return apiJson<{ id: string; slot: number }>(
    API,
    jsonInit("POST", { title, slot }),
  );
}

/** 覆盖写入（title 非空时同时重命名）。 */
export function overwriteCheckpoint(
  id: string,
  title?: string,
): Promise<CheckpointMeta> {
  return apiJson<CheckpointMeta>(`${API}/${id}`, jsonInit("PUT", { title }));
}

export async function deleteCheckpoint(id: string): Promise<void> {
  await apiFetch(`${API}/${id}`, { method: "DELETE" });
}

/** 当前会话写入 auto 槽（不清空 live）。从对话页退回标题页时调用。 */
export async function saveAutoCheckpoint(): Promise<void> {
  await apiFetch(`${API}/auto`, { method: "POST" });
}

/** 开启新会话：live 非空先快照进 auto 槽，然后清空 live。 */
export async function newSession(): Promise<void> {
  await apiFetch(`${API}/live/new`, { method: "POST" });
}

/** 读取存档：覆盖当前会话，返回存档全文（messages 灌进引擎）。 */
export function loadCheckpoint(id: string): Promise<CheckpointSave> {
  return apiJson<CheckpointSave>(`${API}/${id}/load`, { method: "POST" });
}
