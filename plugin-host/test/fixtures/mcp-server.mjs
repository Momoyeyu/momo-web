import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

let calls = 0, dynamicTool = false;
const server = new Server({ name: 'momo-host-test', version: '1' }, { capabilities: { tools: { listChanged: true } } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', description: 'Test persistent echo', inputSchema: { type: 'object' } }, { name: 'slow', description: 'Wait until cancelled', inputSchema: { type: 'object' } }, ...(dynamicTool ? [{ name: 'new', inputSchema: { type: 'object' } }] : [])] }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  calls++;
  if (request.params.arguments?.addTool) { dynamicTool = true; await server.notification({ method: 'notifications/tools/list_changed' }); }
  if (request.params.name === 'slow') {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 10000);
      extra.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  return { content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, calls, text: request.params.arguments?.text ?? '' }) }] };
});
await server.connect(new StdioServerTransport());
