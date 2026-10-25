import { describe, expect, it } from "vitest";
import { McpJsonError, parseMcpJson } from "./mcpJson";

describe("parseMcpJson", () => {
  it("parses mcpServers wrapper with multiple stdio/http entries", () => {
    const out = parseMcpJson(
      JSON.stringify({
        mcpServers: {
          tavily: {
            command: "npx",
            args: ["-y", "tavily-mcp@latest"],
            env: { TAVILY_API_KEY: "tvly-x" },
          },
          remote: {
            url: "https://mcp.example.com/mcp",
            headers: { "X-Token": "t" },
          },
        },
      }),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      name: "tavily",
      transport: "stdio",
      enabled: true,
      command: "npx",
      args: ["-y", "tavily-mcp@latest"],
      env: { TAVILY_API_KEY: "tvly-x" },
    });
    expect(out[1]).toMatchObject({
      name: "remote",
      transport: "http",
      endpoint: "https://mcp.example.com/mcp",
      headers: { "X-Token": "t" },
    });
  });

  it("parses a single server object with name field", () => {
    const out = parseMcpJson(
      '{"name":"fs","command":"uvx","args":["mcp-fs"]}',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: "fs",
      transport: "stdio",
      command: "uvx",
      args: ["mcp-fs"],
    });
  });

  it("maps apiKey to Authorization bearer header", () => {
    const [ext] = parseMcpJson(
      '{"url":"https://x/mcp","apiKey":"sek"}',
    );
    expect(ext.transport).toBe("http");
    expect(ext.headers.Authorization).toBe("Bearer sek");
  });

  it("keeps explicit Authorization over apiKey", () => {
    const [ext] = parseMcpJson(
      '{"url":"https://x/mcp","apiKey":"old","headers":{"Authorization":"Bearer new"}}',
    );
    expect(ext.headers.Authorization).toBe("Bearer new");
  });

  it("detects http via type field without url", () => {
    const [ext] = parseMcpJson('{"type":"sse","endpoint":"https://x/sse"}');
    expect(ext.transport).toBe("http");
    expect(ext.endpoint).toBe("https://x/sse");
  });

  it("splits a full-line command when args absent", () => {
    const [ext] = parseMcpJson('{"command":"npx -y tavily-mcp"}');
    expect(ext.command).toBe("npx");
    expect(ext.args).toEqual(["-y", "tavily-mcp"]);
  });

  it("prepends split command tokens ahead of explicit args", () => {
    const [ext] = parseMcpJson(
      '{"command":"npx -y","args":["tavily-mcp"]}',
    );
    expect(ext.command).toBe("npx");
    expect(ext.args).toEqual(["-y", "tavily-mcp"]);
  });

  it("rejects invalid json / empty mcpServers / unknown shape", () => {
    expect(() => parseMcpJson("not json")).toThrow(McpJsonError);
    expect(() => parseMcpJson('{"mcpServers":{}}')).toThrow(McpJsonError);
    expect(() => parseMcpJson('{"foo":1}')).toThrow(McpJsonError);
    expect(() => parseMcpJson('{"mcpServers":{"x":42}}')).toThrow(McpJsonError);
  });

  it("honours enabled:false and drops non-string env values", () => {
    const [ext] = parseMcpJson(
      '{"command":"npx","enabled":false,"env":{"A":"1","B":2}}',
    );
    expect(ext.enabled).toBe(false);
    expect(ext.env).toEqual({ A: "1" });
  });
  it('retains adapter permissions instead of turning a game into a general tool',()=>{
    const [ext]=parseMcpJson(JSON.stringify({command:'node',declaredPermissions:['activities.game'],grantedPermissions:['activities.game']}));
    expect(ext).toMatchObject({declaredPermissions:['activities.game'],grantedPermissions:['activities.game']});
  });
  it.each([{declaredPermissions:['activities.game','unknown'],grantedPermissions:['activities.game']},{declaredPermissions:'all'},{grantedPermissions:[{}]}])('keeps invalid explicit permissions denied: %j',policy=>{
    const [ext]=parseMcpJson(JSON.stringify({command:'node',...policy}));
    expect(ext).toMatchObject({declaredPermissions:[],grantedPermissions:[]});
  });
});
