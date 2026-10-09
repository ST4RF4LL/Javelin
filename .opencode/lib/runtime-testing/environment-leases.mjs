import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { atomicJson } from "./controller.mjs";

const queues = new Map();
const terminal = new Set(["completed", "cancelled", "failed", "interrupted", "artifact_only"]);
const clean = new Set(["NOT_REQUIRED", "SUCCEEDED"]);
const hash = value => createHash("sha256").update(value).digest("hex");
const error = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
export function environmentLeaseKey(origin) {
  const url = new URL(origin);
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ? `${url.protocol}//loopback:${url.port || (url.protocol === "https:" ? 443 : 80)}` : `origin:${url.origin}`;
}
export const environmentLeaseId = origin => hash(environmentLeaseKey(origin));
const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (cause) { return cause.code !== "ESRCH"; }
};
async function jsonFile(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw error("environment-lease-file-invalid", "环境占用记录无法安全读取。");
    const bytes = await readFile(path);
    return { value: JSON.parse(bytes), revision: hash(bytes), created_at: info.birthtime.toISOString() };
  } catch (cause) { if (cause.code === "ENOENT") return null; throw cause; }
}

// Serialize file inspection + replacement across both requests and processes.
// SQLite releases this short-lived lock even if the platform exits abruptly.
export class EnvironmentLeaseStore {
  constructor({ stateRoot }) { this.stateRoot = resolve(stateRoot); this.root = join(this.stateRoot, "runtime-environment-leases"); }
  async exclusive(operation) {
    const prior = queues.get(this.root) ?? Promise.resolve(); let unlock;
    const gate = new Promise(resolve => { unlock = resolve; }); queues.set(this.root, gate);
    await prior;
    let db;
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      db = new DatabaseSync(join(this.root, ".operations.sqlite"));
      try { db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE;"); }
      catch { throw error("environment-lease-busy", "环境占用记录正在更新，请刷新后重试。"); }
      return await operation();
    } finally { try { db?.close(); } finally { unlock(); if (queues.get(this.root) === gate) queues.delete(this.root); } }
  }
  path(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw error("environment-lease-id-invalid", "环境占用编号无效。", 422);
    return join(this.root, `${id}.json`);
  }
  async inspect(id) {
    const record = await jsonFile(this.path(id));
    if (!record) return null;
    const lease = record.value;
    const validAudit = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(lease.audit_id ?? "");
    const audit = validAudit ? (await jsonFile(join(this.stateRoot, lease.audit_id, "run.json")))?.value : null;
    const runtimeRoot = lease.runtime_root ?? (audit?.paths?.reports_root ? join(audit.paths.reports_root, "runtime-testing", lease.audit_id) : null);
    const runtime = runtimeRoot ? (await jsonFile(join(runtimeRoot, "state.json")))?.value : audit?.runtime_testing_state;
    const state = runtime ?? audit?.runtime_testing_state;
    let origin = lease.origin;
    if (!origin && runtimeRoot) {
      const grant = (await jsonFile(join(runtimeRoot, "authorization.json")))?.value;
      origin = grant?.origins?.find(value => environmentLeaseId(value) === id);
    }
    const ownerLive = lease.status === "active" && alive(lease.pid);
    const auditActive = audit && !terminal.has(audit.status);
    const canRelease = Boolean(audit && terminal.has(audit.status) && !ownerLive);
    const safe = Boolean(state && !state.active_packet && (state.browser_allocated === false || clean.has(state.cleanup_status)) && state.reason !== "BROWSER_CLOSE_FAILED");
    return { id, revision: record.revision, origin: origin ?? "地址未记录", audit_id: lease.audit_id ?? null,
      audit_name: audit?.name ?? lease.audit_id ?? "原任务不可用", audit_status: audit?.status ?? "unknown",
      acquired_at: lease.acquired_at ?? record.created_at, status: ownerLive || auditActive ? "active" : "needs_review",
      runtime_reason: state?.reason ?? lease.reason ?? null, cleanup_status: state?.cleanup_status ?? lease.cleanup_status ?? "UNKNOWN",
      can_release: canRelease, can_auto_release: canRelease && safe,
      message: ownerLive || auditActive ? "原任务仍占用该环境，请先结束原任务。" : !audit ? "找不到原任务，无法确认是否已停止。"
        : safe ? "原任务已结束，记录表明无需清理或已完成清理，下次申请时可自动回收。"
          : "原任务已结束，但清理结果未知或失败。核对原任务的测试操作后，可解除占用供新任务使用。" };
  }
  async list() {
    const names = await readdir(this.root).catch(cause => { if (cause.code === "ENOENT") return []; throw cause; });
    const items = (await Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => this.inspect(name.slice(0, -5))))).filter(Boolean);
    const historyRoot = join(this.root, "history");
    const historyNames = await readdir(historyRoot).catch(cause => { if (cause.code === "ENOENT") return []; throw cause; });
    const history = (await Promise.all(historyNames.filter(name => name.endsWith(".json")).sort().slice(-20).map(async name => (await jsonFile(join(historyRoot, name)))?.value))).filter(Boolean).reverse();
    return { items, history };
  }
  async remove(id, summary, decision, note) {
    const entry = { ...summary, decision, note, released_at: new Date().toISOString() };
    await mkdir(join(this.root, "history"), { recursive: true, mode: 0o700 });
    await atomicJson(join(this.root, "history", `${Date.now()}-${randomUUID()}.json`), entry);
    await rm(this.path(id));
    return entry;
  }
  async release(id, { revision, reviewed, note } = {}) {
    if (reviewed !== true || typeof note !== "string" || !note.trim() || note.length > 2000) throw error("environment-lease-review-required", "请确认已核对原任务，并填写核对说明。", 422);
    return this.exclusive(async () => {
      const summary = await this.inspect(id);
      if (!summary) throw error("environment-lease-not-found", "该占用已解除，请刷新列表。", 404);
      if (summary.revision !== revision) throw error("environment-lease-changed", "占用记录已变化，请刷新后重新核对。", 412);
      if (!summary.can_release) throw error("environment-lease-owner-active", summary.message);
      return this.remove(id, summary, "manual_review", note.trim());
    });
  }
  async acquire({ origins, auditId, runtimeRoot, owner }) {
    return this.exclusive(async () => {
      const leases = [];
      try {
        for (const origin of [...new Set(origins)].sort()) {
          const id = environmentLeaseId(origin);
          if (leases.some(lease => lease.id === id)) continue;
          const existing = await this.inspect(id);
          if (existing?.can_auto_release) await this.remove(id, existing, "automatic", "原任务已结束，清理记录允许自动回收。");
          else if (existing) throw Object.assign(error(existing.status === "active" ? "ENVIRONMENT_ALREADY_LEASED" : "ENVIRONMENT_LEASE_REQUIRES_REVIEW", existing.message), { environment_lease: existing });
          const record = { protocol: "runtime-environment-lease.v2", audit_id: auditId, owner, origin: new URL(origin).origin,
            runtime_root: resolve(runtimeRoot), pid: process.pid, status: "active", acquired_at: new Date().toISOString() };
          await writeFile(this.path(id), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
          leases.push({ id, owner });
        }
        return leases;
      } catch (cause) {
        for (const lease of leases) await this.removeOwned(lease);
        throw cause;
      }
    });
  }
  async removeOwned(lease) {
    const current = await jsonFile(this.path(lease.id));
    if (current?.value.owner === lease.owner) await rm(this.path(lease.id));
  }
  async abandon(leases) { await this.exclusive(async () => { for (const lease of leases) await this.removeOwned(lease); }); }
  async finish(leases, state) {
    await this.exclusive(async () => {
      for (const lease of leases) {
        const current = await jsonFile(this.path(lease.id));
        if (current?.value.owner !== lease.owner) continue;
        const safe = state?.browser_allocated === false || clean.has(state?.cleanup_status) && state?.reason !== "BROWSER_CLOSE_FAILED";
        if (safe) await this.removeOwned(lease);
        else await atomicJson(this.path(lease.id), { ...current.value, pid: null, status: "needs_review",
          closed_at: new Date().toISOString(), cleanup_status: state?.cleanup_status ?? "UNKNOWN", reason: state?.reason ?? "ENVIRONMENT_STATE_UNKNOWN" });
      }
    });
  }
}
