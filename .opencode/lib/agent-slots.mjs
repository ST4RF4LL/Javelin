// Process-wide budget for independently launched audit workers.
export class AgentSlots {
  constructor(limit = 4) { this.limit = Math.max(1, Math.min(16, Number(limit) || 4)); this.active = new Set(); this.listeners = new Set(); }
  tryAcquire(key) {
    if (this.active.size >= this.limit || this.active.has(key)) return null;
    this.active.add(key); let released = false;
    return () => { if (released) return; released = true; this.active.delete(key); for (const callback of this.listeners) queueMicrotask(callback); };
  }
  subscribe(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
}
export const globalAgentSlots = new AgentSlots(process.env.AUDIT_WORKER_CONCURRENCY ?? 4);
