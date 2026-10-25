import type {McpExtension,McpPermission} from './types';

const SCOPES: readonly McpPermission[] = ['mcp.tools','channels.send','activities.game','activities.computer'];
type Policy=Pick<McpExtension,'declaredPermissions'|'grantedPermissions'>;

/** Missing policy retains the legacy general-MCP contract. Invalid explicit
 * policy must remain denied: filtering unknown scopes could broaden access. */
export function mcpPermissions(raw:Policy|Record<string,unknown>):Policy {
  const result:Policy={};
  for(const key of ['declaredPermissions','grantedPermissions'] as const){
    if(!(key in raw))continue;
    const value=raw[key];
    if(!Array.isArray(value)||value.some(scope=>!SCOPES.includes(scope as McpPermission)))
      return {declaredPermissions:[],grantedPermissions:[]};
    result[key]=[...new Set(value)] as McpPermission[];
  }
  return result;
}
