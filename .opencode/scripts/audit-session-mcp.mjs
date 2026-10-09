#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AgentSessionBridge } from '../lib/audit-runtime/session-bridge.mjs';

const bridge = new AgentSessionBridge();
const server = new McpServer({ name: 'audit-current-session', version: '1.0.0' });
const identity = { engine: z.enum(['opencode', 'codex', 'grow']), session_id: z.string().min(3).max(240).describe('从宿主 Agent 获取的真实当前会话 ID，禁止自行编造') };
const key = input => `${input.engine}:${input.session_id}`;
const reply = async operation => {
  try { const value = await operation(); return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
};
server.registerTool('audit_register', {
  description: '用户要求开始源码审计时，登记当前原生 Agent 会话并继续在该会话执行。后台提供任务板、制品和 Web 进度；此工具不启动另一个主 Agent。',
  inputSchema: { ...identity, directory: z.string().describe('当前 Agent 工作目录的绝对路径'), source_root: z.string(), name: z.string().optional(),
    product_id: z.string().optional(), target_id: z.string().optional(), mining_strategy: z.enum(['focus_area', 'api']).optional(), api_inventory: z.string().optional(),
    memory_mode: z.enum(['full', 'facts_only', 'off', 'blind']).optional(), additional_instructions: z.string().optional(),
    test_environment_enabled: z.boolean().optional().describe('仅用户明确开启授权动态验证时为 true'), test_environment_context: z.string().optional() },
}, input => reply(() => bridge.register(input)));
server.registerTool('audit_command', {
  description: '在已登记审计的后台环境中调用任务板、记忆、知识库或专项 CLI。参数为原 CLI 的参数数组，不使用 shell。',
  inputSchema: { ...identity, tool: z.enum(['task_board', 'memory', 'knowledge', 'bac', 'runtime']), args: z.array(z.string()).max(64) },
}, input => reply(() => bridge.command(key(input), input.tool, input.args)));
server.registerTool('audit_checkpoint', {
  description: '同步当前任务进度并校验已交付报告；此工具不会把自然语言声明当作任务完成。',
  inputSchema: { ...identity, message: z.string().max(8000).optional() },
}, input => reply(() => bridge.checkpoint(key(input), input.message)));
server.server.onclose = () => bridge.close();
await server.connect(new StdioServerTransport());
