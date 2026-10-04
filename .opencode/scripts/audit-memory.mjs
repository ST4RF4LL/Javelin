#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
const [op = 'context', file] = process.argv.slice(2);
if (op === '--help') {
  process.stdout.write('audit-memory context|search|show|issue|compare|propose|todos|todo-create|todo-answer [输入JSON文件]\n使用平台注入的 AUDIT_MEMORY_CONNECTION_PATH；历史记录必须重新核查。\n');
} else {
  try {
    if (!process.env.AUDIT_MEMORY_CONNECTION_PATH) throw new Error('当前会话没有启用长期记忆接口。');
    const connection = JSON.parse(await readFile(process.env.AUDIT_MEMORY_CONNECTION_PATH, 'utf8'));
    const url = new URL(connection.endpoint); if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('记忆接口地址无效。');
    const input = file ? JSON.parse(await readFile(file, 'utf8')) : {};
    const response = await fetch(`${connection.endpoint}/memory`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ op, input }), signal: AbortSignal.timeout(30000) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error ?? data.message ?? `记忆请求失败：${response.status}`);
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
