import {expect,it} from 'vitest';
import {extToForm,formToExt} from './mcpForm';
import type {McpExtension} from './types';

it('retains restricted scopes while a user edits an adapter connection',()=>{
  const original:McpExtension={name:'game',transport:'stdio',enabled:true,command:'node',args:['game.mjs'],env:{},endpoint:'',headers:{},declaredPermissions:['mcp.tools','activities.game'],grantedPermissions:['mcp.tools','activities.game']};
  const draft=extToForm(original);draft.name='renamed game';
  expect(formToExt(draft)).toEqual({...original,name:'renamed game'});
});
it('does not invent a permission grant for a legacy general-MCP form',()=>{
  const original:McpExtension={name:'general',transport:'http',enabled:true,command:'',args:[],env:{},endpoint:'https://example.test/mcp',headers:{}};
  expect(formToExt(extToForm(original))).toEqual(original);
});
it('connection-only JSON fill cannot erase an existing adapter policy',()=>{
  const connection:McpExtension={name:'game',transport:'http',enabled:false,command:'',args:[],env:{},endpoint:'https://example.test/mcp',headers:{}};
  const scoped=extToForm({...connection,declaredPermissions:['activities.game'],grantedPermissions:['activities.game']});
  expect(formToExt(extToForm({...connection,name:'updated connection'},scoped))).toMatchObject({declaredPermissions:['activities.game'],grantedPermissions:['activities.game']});
  expect(formToExt(extToForm({...connection,declaredPermissions:[],grantedPermissions:[]},scoped))).toMatchObject({declaredPermissions:[],grantedPermissions:[]});
});

it('round-trips empty, quoted and whitespace-containing arguments through a single connection draft', () => {
  const args = ["--root", "/Users/Test User", "", `She said "it's done".`, "two\nlines", "C:\\Program Files\\MCP\\", "[literal]"];
  const original: McpExtension = {name:"fixture", transport:"stdio", enabled:false, command:"node", args, env:{}, endpoint:"", headers:{}};
  expect(formToExt(extToForm(original))).toEqual(original);
  const draft = extToForm({...original, args:["-y", "example"]});
  expect(draft.argsText).toBe("-y example");
  draft.argsText = `--root '/Users/Test User' --message "it's fine" ''`;
  expect(formToExt(draft).args).toEqual(["--root", "/Users/Test User", "--message", "it's fine", ""]);
  for (const invalid of ["'unfinished", "[1]", '["unterminated']) {
    expect(() => formToExt({...draft,argsText:invalid})).toThrow();
  }
});
