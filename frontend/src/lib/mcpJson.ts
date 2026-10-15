// 拓展「从 JSON 填入」解析：标准 MCP 配置片段 → McpExtension[]。
// 接受 {"mcpServers": {"<name>": {...}}}（多条逐个导入）或单 server 对象；
// command→stdio，url/endpoint/type→http，apiKey→headers.Authorization。
// 解析失败抛 McpJsonError——表单报错，不落库。

import type { McpExtension } from "./types";

export class McpJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpJsonError";
  }
}

const strDict = (v: unknown): Record<string, string> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(
        Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
          typeof x === "string" && k.trim() ? [[k.trim(), x]] : [],
        ),
      )
    : {};

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** 单 server 对象 → McpExtension；无法识别 transport 时抛错。 */
function toExtension(name: string, raw: unknown): McpExtension {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new McpJsonError("server entry is not an object");
  }
  const o = raw as Record<string, unknown>;
  const finalName =
    name || (typeof o.name === "string" ? o.name : "");
  const enabled = o.enabled !== false;
  const headers = strDict(o.headers);
  // 兼容旧式 apiKey → Authorization: Bearer
  if (typeof o.apiKey === "string" && o.apiKey && !headers.Authorization) {
    headers.Authorization = `Bearer ${o.apiKey}`;
  }
  const command = typeof o.command === "string" ? o.command.trim() : "";
  const url =
    (typeof o.url === "string" && o.url.trim()) ||
    (typeof o.endpoint === "string" ? o.endpoint.trim() : "");
  const type = typeof o.type === "string" ? o.type.toLowerCase() : "";
  if (command) {
    // command 应为可执行名；含空格（旧式整行命令）时首 token 作命令、
    // 其余前置于 args。
    const parts = command.split(/\s+/).filter(Boolean);
    const cmd = parts[0];
    const args = [...parts.slice(1), ...strArr(o.args)];
    return {
      name: finalName,
      transport: "stdio",
      enabled,
      command: cmd,
      args,
      env: strDict(o.env),
      endpoint: "",
      headers: {},
    };
  }
  if (url || type === "http" || type === "sse" || type === "streamable-http") {
    return {
      name: finalName,
      transport: "http",
      enabled,
      command: "",
      args: [],
      env: {},
      endpoint: url,
      headers,
    };
  }
  throw new McpJsonError("cannot detect transport (need command or url)");
}

/**
 * 解析粘贴的 MCP 配置文本。
 * - `{"mcpServers": {name: cfg, ...}}` → 逐条导入（key 作 name）
 * - 单 server 对象（可含 name 字段）→ 一条
 * 返回数组（≥1）；任何失败抛 McpJsonError。
 */
export function parseMcpJson(text: string): McpExtension[] {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new McpJsonError("invalid JSON");
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new McpJsonError("not an object");
  }
  const root = obj as Record<string, unknown>;
  const servers = root.mcpServers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    const entries = Object.entries(servers as Record<string, unknown>);
    if (!entries.length) throw new McpJsonError("empty mcpServers");
    return entries.map(([name, cfg]) => toExtension(name, cfg));
  }
  return [toExtension("", root)];
}
