import type {McpExtension} from "./types";
import {formatMcpArguments, parseMcpArguments} from "./mcpArguments";
import {mcpPermissions} from "./mcpPermissions";

/** 弹窗表单草稿：args/env/headers 用文本/键值对形态便于编辑，保存时归一。 */
export interface ExtForm extends Pick<McpExtension,"declaredPermissions"|"grantedPermissions"> {
  name: string;
  transport: McpExtension["transport"];
  enabled: boolean;
  command: string;
  /** stdio 参数：支持简短的命令行写法和无损的 JSON 字符串数组。 */
  argsText: string;
  envPairs: [string, string][];
  endpoint: string;
  headerPairs: [string, string][];
}

export function extToForm(ext: McpExtension, previousPolicy: Pick<McpExtension,"declaredPermissions"|"grantedPermissions"> = {}): ExtForm {
  return {
    ...mcpPermissions(previousPolicy),
    ...mcpPermissions(ext),
    name: ext.name,
    transport: ext.transport,
    enabled: ext.enabled,
    command: ext.command,
    argsText: formatMcpArguments(ext.args),
    envPairs: Object.entries(ext.env),
    endpoint: ext.endpoint,
    headerPairs: Object.entries(ext.headers),
  };
}

export function formToExt(f: ExtForm): McpExtension {
  const args = parseMcpArguments(f.argsText);
  if (f.transport === "stdio" && !args) throw new Error("Invalid MCP arguments");
  const dict = (pairs: [string, string][]): Record<string, string> =>
    Object.fromEntries(
      pairs.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]),
    );
  return {
    ...mcpPermissions(f),
    name: f.name.trim(),
    transport: f.transport,
    enabled: f.enabled,
    command: f.command.trim(),
    args: args ?? [],
    env: dict(f.envPairs),
    endpoint: f.endpoint.trim(),
    headers: dict(f.headerPairs),
  };
}

