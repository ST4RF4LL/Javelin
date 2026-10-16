import { readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// The ttyd service revokes a checkpoint terminal as soon as the audit leaves
// paused/terminal state. Wait for its owned process to close before resuming.
export async function waitForInteractiveRelease(path, { timeout = 10000, alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
} } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let lease;
    try { lease = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!Number.isSafeInteger(lease.pid) || lease.pid <= 1) throw new Error('交互终端连接记录无效，请先关闭交互终端。');
    if (!alive(lease.pid)) { await rm(path, { force: true }); return; }
    if (Date.now() >= deadline) throw new Error('Grow 交互终端尚未关闭，请关闭终端窗口后恢复任务，避免同时写入同一会话。');
    await delay(100);
  }
}
