import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

// An OS-released SQLite lock avoids stale PID files after an unclean exit.
// Every enabled runner must acquire it before reading/reconciling task state.
export function acquireStateLease(stateRoot) {
  const db = new DatabaseSync(join(stateRoot, '.execution-owner.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER);');
  } catch (cause) {
    db.close();
    throw Object.assign(new Error('此任务目录已有执行服务占用，拒绝启动第二个 Runner。', { cause }), { code: 'audit-state-owned' });
  }
  let released = false;
  return () => { if (!released) { released = true; db.exec('ROLLBACK'); db.close(); } };
}
