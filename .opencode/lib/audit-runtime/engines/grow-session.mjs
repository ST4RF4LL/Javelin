import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function canonical(path) {
  let value; try { value = realpathSync.native(path); } catch { value = resolve(path); }
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** A prepared UUID is not proof of a started session. Grow 2.2.2 writes this
 * summary itself after creating the session; inspect only the private home. */
export function hasPersistedGrowSession(sessionHome, sessionId, cwd) {
  if (!sessionHome || !UUID.test(sessionId || '') || !cwd) return false;
  try {
    for (const entry of readdirSync(join(sessionHome, 'sessions'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const summary = JSON.parse(readFileSync(join(sessionHome, 'sessions', entry.name, sessionId, 'summary.json'), 'utf8'));
        if (summary.info?.id === sessionId && typeof summary.info.cwd === 'string' && canonical(summary.info.cwd) === canonical(cwd)) return true;
      } catch {}
    }
  } catch {}
  return false;
}

/** Select an interactive fork only after Grow has actually persisted it. */
export function readCheckpointSession(sessionHome, fallbackId) {
  if (!sessionHome || !UUID.test(fallbackId || '')) return fallbackId;
  try {
    const manifest = JSON.parse(readFileSync(join(sessionHome, 'javelin-session.json'), 'utf8'));
    const head = JSON.parse(readFileSync(join(sessionHome, 'javelin-interactive-head.json'), 'utf8'));
    if (head.schema === 'javelin-grow-interactive-head.v1' && head.baseSessionId === fallbackId && manifest.sessionId === fallbackId && head.cwd === manifest.cwd) {
      if (hasPersistedGrowSession(sessionHome, head.sessionId, head.cwd)) return head.sessionId;
      // Preparing another terminal must not lose an earlier, persisted branch
      // when the browser never connects to the newly prepared one.
      if (hasPersistedGrowSession(sessionHome, head.parentSessionId, head.cwd)) return head.parentSessionId;
    }
  } catch {}
  return fallbackId;
}
