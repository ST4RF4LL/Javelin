import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { PROTOCOL, TERMINAL, atomicJson, check, controlledBytes, digest, hash, normalizeApiList, normalizeTask, selectMiningStrategy, summarize, timestamp } from "./contract.mjs";
import { TASK_PLAN, bacSelection } from "../bac/contract.mjs";
import { checkReportIntegrity } from "./report-integrity.mjs";

// Only snapshots prepared by this store can enter the shared commit path.
// Keep validated bytes private so callers cannot replace them after validation.
const preparedReceipts = new WeakMap();

export async function readBoard(path) {
  const board = JSON.parse(await readFile(path, "utf8"));
  check(board.protocol === PROTOCOL && Array.isArray(board.tasks) && Array.isArray(board.api_sources), "任务面板格式无效。");
  if (board.mining_strategy != null) {
    check(["focus_area", "api"].includes(board.mining_strategy), "任务面板的漏洞挖掘策略无效。");
    check(board.tasks.every(task => task.kind === board.mining_strategy), "任务面板包含不属于所选策略的任务。");
    check(board.mining_strategy === "api" ? board.api_sources.length > 0 : board.api_sources.length === 0, "任务面板的 API 清单与挖掘策略不匹配。");
  }
  return board;
}

export async function createBoard({ path, auditId, apiList = "", scopeDigest = null, miningStrategy = null, bacMode = null }) {
  const apiSources = normalizeApiList(apiList);
  if (miningStrategy != null) selectMiningStrategy(miningStrategy, apiList);
  try {
    const existing = await readBoard(path);
    check(existing.audit_id === auditId && digest(existing.api_sources) === digest(apiSources), "任务面板的审计或 API 清单绑定已变化。");
    check((existing.mining_strategy ?? null) === miningStrategy, "任务面板的漏洞挖掘策略已变化。");
    if (bacMode != null && existing.bac_analysis) check(existing.bac_analysis.mode === bacMode, "任务面板的越权专项选择已变化。");
    return existing;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const board = { protocol: PROTOCOL, audit_id: auditId, revision: 0, scope_digest: scopeDigest, created_at: timestamp(), updated_at: timestamp(),
    ...(miningStrategy ? { mining_strategy: miningStrategy } : {}),
    ...(bacMode != null ? { bac_analysis: { ...bacSelection(bacMode), task_plan_contract: TASK_PLAN } } : {}),
    publication: { state: "OPEN", empty_reason: null }, api_sources: apiSources, tasks: [], attempts: [], validation: { status: "NOT_STARTED" } };
  await atomicJson(path, board);
  return board;
}

// Exactly one service owns mutations. HTTP clients never write this file.
export class TaskBoardStore {
  constructor({ path, reportsRoot, auditId, scopeDigest, onChange = async () => {} }) {
    this.path = path; this.reportsRoot = reportsRoot; this.auditId = auditId; this.scopeDigest = scopeDigest;
    this.onChange = onChange; this.queue = Promise.resolve(); this.owner = randomUUID();
  }
  async open() {
    this.lockPath = `${this.path}.lock`;
    await mkdir(dirname(this.path), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await writeFile(this.lockPath, JSON.stringify({ pid: process.pid, owner: this.owner }), { flag: "wx", mode: 0o600 }); break; }
      catch (error) {
        if (error.code !== "EEXIST" || attempt) throw error;
        const lock = JSON.parse(await readFile(this.lockPath, "utf8"));
        check(Number.isInteger(lock.pid) && lock.pid > 0, "任务服务锁无效，拒绝并发接管。");
        let alive = true;
        try { process.kill(lock.pid, 0); } catch (probe) { if (probe.code === "ESRCH") alive = false; }
        check(!alive, "任务面板已有运行中的调度服务。");
        await rm(this.lockPath);
      }
    }
    try {
      this.board = await readBoard(this.path);
      check(this.board.audit_id === this.auditId && (!this.board.scope_digest || this.board.scope_digest === this.scopeDigest), "任务面板与冻结源码范围不一致。");
      await this.mutate(board => {
        board.scope_digest = this.scopeDigest;
        for (const task of board.tasks) if (task.status === "RUNNING") {
          const old = board.attempts.find(row => row.attempt_id === task.attempt_id);
          if (old) { old.status = "INTERRUPTED"; old.reason = "调度服务中断，旧执行尝试已失效。"; }
          task.status = "PENDING"; task.attempt_id = null;
        }
      });
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  async mutate(operation) {
    const result = this.queue.catch(() => {}).then(async () => {
      const next = structuredClone(this.board);
      const value = await operation(next);
      next.revision++; next.updated_at = timestamp();
      await atomicJson(this.path, next); this.board = next;
      // Notification failure cannot turn a durably committed claim into a lost job.
      try { await this.onChange(summarize(next)); } catch (error) { this.notificationError = error; }
      return value;
    });
    this.queue = result;
    return result;
  }
  snapshot() { return structuredClone(this.board); }
  summary() { return summarize(this.board); }
  async publish({ tasks = [] }) {
    check(Array.isArray(tasks) && tasks.length > 0 && tasks.length <= 100, "每次发布 1 至 100 个任务。");
    return this.mutate(board => {
      const published = [];
      for (const input of tasks) {
        const spec = normalizeTask(input, board), specDigest = digest(spec);
        const existing = board.tasks.find(task => task.task_id === spec.task_id);
        if (existing) { check(existing.spec_digest === specDigest, "已有任务内容不同；请使用新的任务 ID 发布补充任务。"); published.push(existing.task_id); continue; }
        check(board.publication.state === "OPEN", "本轮任务发布已封存。");
        if (spec.parent_task_id) check(board.tasks.some(task => task.task_id === spec.parent_task_id), "关联的原任务不存在。");
        check(board.tasks.length < 10_000, "本轮任务数量超过上限。");
        board.tasks.push({ ...spec, spec_digest: specDigest, status: "PENDING", attempt_id: null, attempt_count: 0, report: null, reason: null, created_at: timestamp() });
        published.push(spec.task_id);
      }
      return { published };
    });
  }
  async seal({ empty_reason: emptyReason = null } = {}) {
    return this.mutate(board => {
      if (board.publication.state === "SEALED") return { sealed: true };
      const missing = board.api_sources.filter(source => !board.tasks.some(task => task.kind === "api" && task.source_ref === source.source_id));
      check(!missing.length, `还有 ${missing.length} 项 API 未发布任务：${missing.slice(0, 8).map(row => row.source_id).join("、")}。`);
      check(board.tasks.length || typeof emptyReason === "string" && emptyReason.trim(), "空面板必须说明未产生审计任务的原因。");
      board.publication = { state: "SEALED", sealed_at: board.publication.sealed_at ?? timestamp(), empty_reason: board.tasks.length ? null : emptyReason.trim() };
      return { sealed: true };
    });
  }
  async claim(domain, leaseMs) {
    return this.mutate(board => {
      if (board.tasks.some(task => task.domain === domain && task.status === "RUNNING")) return null;
      const task = board.tasks.find(task => task.domain === domain && task.status === "PENDING");
      if (!task) return null;
      const attemptId = `attempt-${randomUUID()}`;
      task.status = "RUNNING"; task.attempt_id = attemptId; task.attempt_count++;
      const attempt = { attempt_id: attemptId, task_id: task.task_id, domain, status: "RUNNING", started_at: timestamp(), lease_expires_at: new Date(Date.now() + leaseMs).toISOString() };
      board.attempts.push(attempt);
      return { task: structuredClone(task), attempt: structuredClone(attempt) };
    });
  }
  async prepareReceipt({ taskId, attemptId, receipt, inputRoot, requireCompleteJson = false }) {
    check(receipt?.protocol === PROTOCOL && receipt.audit_id === this.auditId && receipt.task_id === taskId && receipt.attempt_id === attemptId, "报告回执与当前任务或执行尝试不匹配。");
    check(["REPORTED", "GAP"].includes(receipt.outcome), "回执结果必须为 REPORTED 或 GAP。");
    check(receipt.outcome !== "GAP" || typeof receipt.reason === "string" && receipt.reason.trim(), "缺口交付必须说明原因。");
    // Bind immutable bytes and check deterministic BAC identity before acceptance.
    const bytes = receipt.outcome === "REPORTED" ? await controlledBytes(inputRoot, receipt.report_path) : null;
    const reportDigest = bytes ? hash(bytes) : null;
    // Recovery needs whole JSON, while normal receipt acceptance still leaves
    // malformed/report-quality gaps to the independent review as before.
    if (requireCompleteJson && bytes && receipt.report_path.endsWith(".json")) JSON.parse(bytes.toString("utf8"));
    if (bytes) await checkReportIntegrity(bytes, { reportsRoot: this.reportsRoot, taskId });
    const snapshot = Object.freeze({});
    preparedReceipts.set(snapshot, { store: this, taskId, attemptId, receipt: structuredClone(receipt), bytes, reportDigest });
    return snapshot;
  }
  async receive(input, options) {
    return this.receivePreparedReceipt(await this.prepareReceipt(input), options);
  }
  async receivePreparedReceipt(snapshot, { canReceive = () => true } = {}) {
    const prepared = preparedReceipts.get(snapshot);
    check(prepared?.store === this, "交付快照未经当前任务服务验证。");
    const { taskId, attemptId, receipt, bytes, reportDigest } = prepared;
    return this.mutate(async board => {
      check(canReceive(), "交付快照已失效。");
      const task = board.tasks.find(row => row.task_id === taskId);
      check(task && task.attempt_id === attemptId, "旧执行尝试不得提交报告。");
      if (TERMINAL.has(task.status)) {
        check(task.status === receipt.outcome && (task.report?.sha256 ?? null) === reportDigest && (task.reason ?? null) === (receipt.outcome === "GAP" ? receipt.reason.trim() : null), "重复回执与已接收结果不同。");
        return { received: true, duplicate: true };
      }
      check(task.status === "RUNNING", "任务当前未运行。");
      if (bytes) await checkReportIntegrity(bytes, { reportsRoot: this.reportsRoot, taskId });
      if (bytes) {
        const extension = receipt.report_path.endsWith(".md") ? "md" : "json";
        const file = join(this.reportsRoot, "task-board", this.auditId, "reports", `${hash(taskId).slice(0, 24)}.${attemptId}.${extension}`);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, bytes, { mode: 0o600 });
        task.report = { path: relative(this.reportsRoot, file).split("\\").join("/"), sha256: reportDigest, byte_length: bytes.length };
      }
      check(canReceive(), "交付快照已失效。");
      task.status = receipt.outcome; task.reason = receipt.outcome === "GAP" ? receipt.reason.trim() : null; task.completed_at = timestamp();
      Object.assign(board.attempts.find(row => row.attempt_id === attemptId), { status: receipt.outcome, completed_at: task.completed_at });
      return { received: true, report: task.report };
    });
  }
  async fail(taskId, attemptId, reason, { interrupted = false } = {}) {
    return this.mutate(board => {
      const task = board.tasks.find(row => row.task_id === taskId);
      if (!task || task.attempt_id !== attemptId || task.status !== "RUNNING") return;
      if (!interrupted) task.failure_count = (task.failure_count ?? 0) + 1;
      task.status = interrupted || task.failure_count < 3 ? "PENDING" : "FAILED"; task.reason = String(reason).slice(0, 2000);
      Object.assign(board.attempts.find(row => row.attempt_id === attemptId), { status: interrupted ? "INTERRUPTED" : "FAILED", reason: task.reason, completed_at: timestamp() });
    });
  }
  async skip({ task_id: taskId, reason }) {
    check(typeof reason === "string" && reason.trim() && reason.length <= 4000, "跳过任务必须提供具体原因。");
    return this.mutate(board => {
      const task = board.tasks.find(row => row.task_id === taskId);
      check(task && ["PENDING", "FAILED"].includes(task.status), "只能显式关闭待处理或失败的任务。");
      task.status = "GAP"; task.reason = reason.trim(); task.completed_at = timestamp();
    });
  }
  async close() {
    await this.queue.catch(() => {});
    if (!this.lockPath) return;
    try { const lock = JSON.parse(await readFile(this.lockPath, "utf8")); if (lock.owner === this.owner) await rm(this.lockPath); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
