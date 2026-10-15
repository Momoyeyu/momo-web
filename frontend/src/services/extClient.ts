// 拓展（MCP server）客户端：POST /api/extensions/probe 连通性探测。
// backend 内部 connect + list_tools + close；永不抛错——失败只是灰点。

import { apiJson, jsonInit } from "./http";
import type { McpExtension } from "../lib/types";

export interface ExtProbeResult {
  ok: boolean;
  /** 连接成功时 server 的 tools/list 条数。 */
  tools: number;
  error?: string;
}

/** 探测单条拓展记录；网络层失败也归一成 {ok:false}。 */
export async function probeExtension(
  ext: McpExtension,
): Promise<ExtProbeResult> {
  try {
    const r = await apiJson<Partial<ExtProbeResult>>(
      "/api/extensions/probe",
      jsonInit("POST", ext),
    );
    return {
      ok: r?.ok === true,
      tools: typeof r?.tools === "number" ? r.tools : 0,
      error: typeof r?.error === "string" ? r.error : undefined,
    };
  } catch (e) {
    return { ok: false, tools: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
