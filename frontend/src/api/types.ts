// 接口层类型的统一出口：全部由 backend/openapi.json 生成（`pnpm gen:api`）。
// 想改接口形状就改后端代码，再重新导出 + 生成 —— 不要手写这些类型。
//
// 未收录在这里的：
// - PersistedState（lib/types.ts）：GET /api/state 有意返回 dict[str, Any] ——
//   它要透传 schema 之外的键供前端整体回写，用 response_model 会把它们过滤掉
// - SSE 事件（sentence / done / error，services/chatClient.ts）：OpenAPI 描述不了流式响应体
import type { components } from "./schema";

type Schemas = components["schemas"];

export type Memory = Schemas["Memory"];
export type MemoryCreated = Schemas["MemoryCreated"];
export type CheckpointMeta = Schemas["CheckpointMeta"];
export type CheckpointDetail = Schemas["CheckpointDetail"];
export type CheckpointCreated = Schemas["CheckpointCreated"];
export type StoredMessage = Schemas["StoredMessage"];
export type LiveTranscript = Schemas["LiveTranscript"];
export type ExtProbeResult = Schemas["ProbeResult"];
