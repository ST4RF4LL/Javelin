#!/usr/bin/env node
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const [command, ...args] = process.argv.slice(2);
const option = key => args[args.indexOf(key) + 1];
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`;
if (args.includes('--help')) {
  console.log('--format --session --agent --dir --title --attach');
} else if (command === 'serve') {
  let sink;
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== auth) { res.writeHead(401).end(); return; }
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/session') {
      let body = ''; for await (const chunk of req) body += chunk;
      appendFileSync(join(process.cwd(), 'session-create.jsonl'), `${body}\n`);
      appendFileSync(join(process.cwd(), 'creates.txt'), 'created\n');
      res.end(JSON.stringify({ id: 'ses_shared_fixture' }));
    } else if (/^\/session\//.test(url.pathname)) res.end(JSON.stringify({ id: url.pathname.split('/').pop() }));
    else if (url.pathname === '/run') {
      sink = res;
      res.writeHead(200, { 'Content-Type': 'application/jsonl' });
      res.write(`${JSON.stringify({ type: 'text', sessionID: url.searchParams.get('session'), part: { text: 'FIXTURE_STARTED', env: process.env.AUDIT_FIXTURE_MARKER } })}\n`);
    } else if (url.pathname === '/input') {
      let body = ''; for await (const chunk of req) body += chunk;
      sink?.write(`${JSON.stringify({ type: 'text', sessionID: 'ses_shared_fixture', part: { text: body } })}\n`);
      res.end('ok');
    } else if (url.pathname === '/finish') { sink?.end(); res.end('ok'); }
    else res.end('alive');
  });
  server.listen(0, '127.0.0.1', () => console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`));
} else if (command === 'run') {
  const result = await fetch(`${option('--attach')}/run?session=${option('--session')}`, { headers: { Authorization: auth } });
  if (!result.ok) process.exit(1);
  for await (const chunk of result.body) process.stdout.write(chunk);
} else if (command === 'attach') {
  const check = await fetch(args[0], { headers: { Authorization: auth } });
  if (!check.ok) process.exit(1);
  process.stdout.write(`\x1b[2J\x1b[HATTACH_READY ${option('--session')}\r\n`);
  process.stdin.setRawMode?.(true);
  process.on('SIGWINCH', () => process.stdout.write(`SIZE ${process.stdout.columns}x${process.stdout.rows}\r\n`));
  process.stdin.on('data', async bytes => {
    const message = bytes.toString();
    await fetch(`${args[0]}/input`, { method: 'POST', headers: { Authorization: auth }, body: message });
    process.stdout.write(`INPUT_SENT ${message}\r\n`);
  });
}
