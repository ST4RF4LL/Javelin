import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const endpoint = process.env.AUDIT_PROPOSAL_ENDPOINT, token = process.env.AUDIT_PROPOSAL_TOKEN;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint ?? '') || !token) throw new Error('proposal-lease-missing');
async function request(path, body = {}) {
  const response = await fetch(endpoint + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'proposal-request-failed');
  return result;
}
const server = new Server({ name: 'audit-proposal', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [await request('/schema')] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    if (params.name !== 'submit') throw new Error('proposal-tool-unknown');
    const value = await request('/submit', params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
await server.connect(new StdioServerTransport());
