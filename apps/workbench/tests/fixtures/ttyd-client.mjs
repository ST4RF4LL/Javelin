import WebSocket from 'ws';
import { once } from 'node:events';

export async function connectTtyd(base, auditId, { generation, readOnly = false } = {}) {
  const origin = new URL(base).origin;
  const response = await fetch(`${base}/api/audits/${auditId}/terminal?${new URLSearchParams({ ...(generation ? { generation } : {}), readonly: readOnly ? '1' : '0' })}`, { method: 'POST', headers: { Origin: origin } });
  const terminal = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(terminal));
  const tokenResponse = await fetch(`${base}${terminal.url}token`);
  const token = await tokenResponse.json();
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}${terminal.url}ws`, 'tty', { origin });
  const connection = { ws, terminal, output: '', messages: [], input(data) { ws.send(`0${data}`); }, resize(cols, rows) { ws.send(`1${JSON.stringify({columns:cols,rows})}`); } };
  ws.on('error', () => {});
  ws.on('message', bytes => {
    const message = bytes.toString(); connection.messages.push(message);
    if (message[0] === '0') connection.output += message.slice(1);
  });
  await once(ws, 'open'); ws.send(JSON.stringify({ AuthToken: token.token, columns: 120, rows: 30 }));
  return connection;
}
