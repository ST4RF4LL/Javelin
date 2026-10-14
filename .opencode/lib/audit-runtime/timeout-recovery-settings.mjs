import { readFile } from 'node:fs/promises';
import { atomicJson } from '../task-board/contract.mjs';
import { timeoutRecoveryPolicy } from './operation-timeout.mjs';

function normalize(value) {
  const { max_recoveries: limit, retry_delay_seconds: seconds } = value ?? {};
  if (!Number.isInteger(limit) || limit < 0 || limit > 100
    || typeof seconds !== 'number' || !Number.isInteger(seconds * 1000) || seconds < 0 || seconds > 300) {
    throw Object.assign(new Error('自动恢复次数须为 0–100 的整数，等待时间须为 0–300 秒（精确到毫秒）。'),
      { statusCode: 422, code: 'timeout-recovery-settings-invalid' });
  }
  return { max_recoveries: limit, retry_delay_seconds: seconds };
}

export class TimeoutRecoverySettingsStore {
  constructor({ path, environment = process.env }) {
    this.path = path;
    const policy = timeoutRecoveryPolicy(environment);
    this.document = { max_recoveries: policy.limit, retry_delay_seconds: policy.delay_ms / 1000, updated_at: null };
    this.writes = Promise.resolve();
    this.ready = this.initialize();
  }
  async initialize() {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      this.document = { ...normalize(saved), updated_at: saved.updated_at ?? null };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  get policy() { return { limit: this.document.max_recoveries, delay_ms: Math.round(this.document.retry_delay_seconds * 1000) }; }
  async get() { await this.ready; return { ...this.document }; }
  async update(input) {
    const settings = normalize(input);
    await this.ready;
    const operation = this.writes.catch(() => {}).then(async () => {
      const next = { ...settings, updated_at: new Date().toISOString() };
      await atomicJson(this.path, next);
      this.document = next;
      return { ...next };
    });
    this.writes = operation;
    return operation;
  }
}
