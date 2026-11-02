import { randomUUID } from "node:crypto";
import { verifyIncrementalReplacement } from "./incremental.mjs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { PROTOCOL, TERMINAL, atomicJson, check, controlledBytes, digest, hash, normalizeApiList, normalizeTask, selectMiningStrategy, selectMiningStrategies, miningStrategies, hasMiningStrategy, taskStrategy, MINING_CONTRACT, MINING_STRATEGIES, summarize, timestamp } from "./contract.mjs";
import { TASK_PLAN, bacSelection } from "../bac/contract.mjs";
import { checkReportIntegrity } from "./report-integrity.mjs";
import { createFileSweep, claimFile, completeFile, filePage, readFilePage, recordFileRead, assertSweepSealable, taskKindForStrategy } from "./file-sweep.mjs";

// Only snapshots prepared by this store can enter the shared commit path.
// Keep validated bytes private so callers cannot replace them after validation.
const preparedReceipts = new WeakMap();

export async function readBoard(path) {
  const board = JSON.parse(await readFile(path, "utf8"));
  check(board.protocol === PROTOCOL && Array.isArray(board.tasks) && Array.isArray(board.api_sources), "任务面板格式无效。");
  if (board.mining_strategies != null) {
    check(board.mining_contract === MINING_CONTRACT && Array.isArray(board.strategy_runs), "多策略工作项看板契约无效。");
    const selected = selectMiningStrategies(board.mining_strategies, board.api_sources.length ? "已冻结 API 清单" : "", board.mining_strategy ?? null);
    check(digest(selected) === digest(board.mining_strategies), "看板挖掘方式顺序无效。");
    check(board.strategy_runs.length === selected.length && new Set(board.strategy_runs.map(run => run.strategy_id)).size === selected.length
      && board.strategy_runs.every(run => selected.includes(run.strategy_id) && ["OPEN", "SEALED"].includes(run.state)), "策略发布状态无效。");
    check(board.publication.state !== "SEALED" || board.strategy_runs.every(run => run.state === "SEALED"), "全局封存前仍有方式未完成发布。");
    check(board.tasks.every(task => selected.includes(task.strategy_id) && task.kind === taskKindForStrategy(task.strategy_id)), "看板包含未启用方式的工作项。");
  } else if (board.mining_strategy != null) {
    check(MINING_STRATEGIES.includes(board.mining_strategy), "任务面板的漏洞挖掘策略无效。");
    check(board.tasks.every(task => task.kind === taskKindForStrategy(board.mining_strategy)), "任务面板包含不属于所选策略的任务。");
    check(board.mining_strategy === "api" ? board.api_sources.length > 0 : board.api_sources.length === 0, "任务面板的 API 清单与挖掘策略不匹配。");
  }
  return board;
}

export async function createBoard({ path, auditId, apiList = "", scopeDigest = null, miningStrategy = null, miningStrategies: strategiesInput = null, bacMode = null, auditMode = null }) {
  const apiSources = normalizeApiList(apiList);
  const strategies = strategiesInput == null ? null : selectMiningStrategies(strategiesInput, apiList, miningStrategy);
  if (miningStrategy != null) selectMiningStrategy(miningStrategy, apiList);
  check(strategies || miningStrategy !== "creed", "CREED 必须使用新版多策略契约创建。");
  try {
    const existing = await readBoard(path);
    check(existing.audit_id === auditId && digest(existing.api_sources) === digest(apiSources), "任务面板的审计或 API 清单绑定已变化。");
    check(strategies ? digest(miningStrategies(existing)) === digest(strategies) : (existing.mining_strategy ?? null) === miningStrategy, "任务面板的漏洞挖掘策略已变化。");
    if (bacMode != null && existing.bac_analysis) check(existing.bac_analysis.mode === bacMode, "任务面板的越权专项选择已变化。");
    return existing;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const board = { protocol: PROTOCOL, audit_id: auditId, revision: 0, scope_digest: scopeDigest, created_at: timestamp(), updated_at: timestamp(),
    ...(auditMode ? { audit_mode: auditMode } : {}),
    ...(strategies ? { mining_contract: MINING_CONTRACT, mining_strategies: strategies, strategy_runs: strategies.map(strategy_id => ({ strategy_id, state: auditMode === "dynamic" ? "SEALED" : "OPEN", empty_reason: null })) } : miningStrategy ? { mining_strategy: miningStrategy } : {}),
    ...(bacMode != null ? { bac_analysis: { ...bacSelection(bacMode), task_plan_contract: TASK_PLAN } } : {}),
    publication: { state: auditMode === "dynamic" ? "SEALED" : "OPEN", empty_reason: null }, api_sources: apiSources, tasks: [], attempts: [], validation: { status: "NOT_STARTED" } };
  await atomicJson(path, board);
  return board;
}

// Exactly one service owns mutations. HTTP clients never write this file.
export class TaskBoardStore {
  constructor({ path, reportsRoot, auditId, scopeDigest, onChange = async () => {} }) {
    this.path = path; this.reportsRoot = reportsRoot; this.auditId = auditId; this.scopeDigest = scopeDigest;
    this.onChange = onChange; this.queue = Promise.resolve(); this.owner = randomUUID();
  }
  async open({ reclaim = true } = {}) {
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
      if (reclaim) await this.mutate(board => {
        board.scope_digest = this.scopeDigest;
        for (const file of board.file_sweep?.files ?? []) if (!board.active_round && file.status === "READING") { file.status = "PENDING"; file.attempt_id = null; }
        for (const task of board.tasks) if (task.status === "RUNNING" && (!board.active_round || board.active_round.work_item_ids.includes(task.task_id))) {
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
  async initializeFiles(manifest) {
    return this.mutate(board => {
      check(hasMiningStrategy(board, "file_sweep"), "当前策略不需要文件浏览清单。");
      const sweep = createFileSweep(manifest, board);
      if (board.file_sweep) check(board.file_sweep.manifest_digest === sweep.manifest_digest, "冻结文件清单已变化，不能覆盖浏览进度。");
      else board.file_sweep = sweep;
    });
  }
  files(input) { return filePage(this.board, input); }
  claimFile(input) { return this.mutate(board => claimFile(board, input)); }
  async completeFile(input, sourceRoot) {
    if (input.outcome === "BROWSED" && this.board.file_sweep?.files.find(file => file.file_id === input.file_id)?.status === "READING") {
      check(sourceRoot, "提交浏览结果需要校验冻结源码。");
      await readFilePage(this.snapshot(), sourceRoot, { ...input, start_line: 1, limit: 1 });
    }
    return this.mutate(board => completeFile(board, input));
  }
  async readFile(sourceRoot, input) {
    let page;
    try { page = await readFilePage(this.snapshot(), sourceRoot, input); }
    catch (error) {
      if (error.code === "ENOENT" || /源码已变化|摘要已变化|有效 UTF-8|浏览上限|超长行|源码根|链接超出/.test(error.message)) await this.mutate(board => {
        const file = board.file_sweep?.files.find(row => row.file_id === input.file_id);
        if (file?.status === "READING" && file.attempt_id === input.attempt_id) file.read_error = String(error.message).slice(0, 1000);
      });
      throw error;
    }
    await this.mutate(board => recordFileRead(board, page));
    return page;
  }
  resetFileClaims() { return this.mutate(board => { for (const file of board.file_sweep?.files ?? []) if (!board.active_round && file.status === "READING") { file.status = "PENDING"; file.attempt_id = null; } }); }
  async publish({ tasks = [] }) {
    check(Array.isArray(tasks) && tasks.length > 0 && tasks.length <= 100, "每次发布 1 至 100 个任务。");
    return this.mutate(board => {
      const published = [], reused = [];
      for (const input of tasks) {
        const spec = normalizeTask(input, board);
        const existing = board.tasks.find(task => task.task_id === spec.task_id);
        if (existing) { check(existing.spec_digest === digest(spec), "已有任务内容不同；请使用新的任务 ID 发布补充任务。"); published.push(existing.task_id); continue; }
        check(!board.active_round, "增量审计只重试冻结的失败工作项，不发布新工作项。");
        check(board.publication.state === "OPEN" && (!board.strategy_runs || board.strategy_runs.find(run => run.strategy_id === spec.strategy_id)?.state === "OPEN"), "本轮任务发布已封存。");
        if (taskStrategy(spec, board) === "file_sweep") check(board.file_sweep.files.find(file => file.file_id === spec.source_ref)?.status === "READING", "新增 Focus Area 须来自当前正在浏览的文件。");
        const sameCause = spec.kind === "focus_area" && spec.root_cause && board.tasks.find(task => task.kind === spec.kind && task.domain === spec.domain && task.root_cause
          && (!board.mining_strategies || task.strategy_id === spec.strategy_id && task.source_ref === spec.source_ref)
          && digest(task.root_cause) === digest(spec.root_cause) && digest(task.bac_analysis ?? null) === digest(spec.bac_analysis ?? null)
          && digest(task.agent_mining ?? null) === digest(spec.agent_mining ?? null));
        const coveredLocations = sameCause && spec.code_refs.every(ref => sameCause.code_refs.some(known => known.path === ref.path && known.line === ref.line && known.symbol === ref.symbol));
        if (coveredLocations) { published.push(sameCause.task_id); reused.push({ requested_task_id: spec.task_id, task_id: sameCause.task_id }); continue; }
        if (spec.parent_task_id) check(board.tasks.some(task => task.task_id === spec.parent_task_id), "关联的原任务不存在。");
        check(board.tasks.length < 10_000, "本轮任务数量超过上限。");
        board.tasks.push({ ...spec, spec_digest: digest(spec), ...(sameCause ? { related_task_id: sameCause.task_id } : {}), status: "PENDING", attempt_id: null, attempt_count: 0, report: null, reason: null, created_at: timestamp() });
        published.push(spec.task_id);
      }
      return { published, ...(reused.length ? { reused } : {}) };
    });
  }
  async seal({ empty_reason: emptyReason = null, strategy_id: strategyId = null } = {}) {
    return this.mutate(board => {
      if (strategyId != null) check(miningStrategies(board).includes(strategyId), "挖掘方式未启用。");
      if (board.publication.state === "SEALED") return { sealed: true };
      check(!board.active_round, "增量审计不能修改原有发布范围。");
      const checkStrategy = strategy => {
        if (strategy === "file_sweep") assertSweepSealable(board);
        if (strategy === "api") {
          const missing = board.api_sources.filter(source => !board.tasks.some(task => task.kind === "api" && task.source_ref === source.source_id));
          check(!missing.length, `还有 ${missing.length} 项 API 未发布任务：${missing.slice(0, 8).map(row => row.source_id).join("、")}。`);
        }
        if (strategy === "creed") {
          check(board.creed_inventory, "CREED 函数清单尚未生成。");
          check(board.creed_inventory.functions.every(fn => board.tasks.some(task => taskStrategy(task, board) === "creed" && task.source_ref === fn.function_id)), "CREED 函数尚未全部发布为工作项。");
        }
      };
      if (board.strategy_runs) {
        if (strategyId) {
          const run = board.strategy_runs.find(row => row.strategy_id === strategyId);
          check(run, "挖掘方式未启用。");
          if (run.state !== "SEALED") {
            checkStrategy(strategyId);
            const hasTasks = board.tasks.some(task => task.strategy_id === strategyId);
            check(hasTasks || typeof emptyReason === "string" && emptyReason.trim(), "该方式未产生工作项，须说明原因。");
            Object.assign(run, { state: "SEALED", sealed_at: timestamp(), empty_reason: hasTasks ? null : emptyReason.trim() });
          }
        } else if (board.strategy_runs.length === 1) {
          const run = board.strategy_runs[0]; checkStrategy(run.strategy_id);
          check(board.tasks.length || typeof emptyReason === "string" && emptyReason.trim(), "空面板必须说明未产生审计任务的原因。");
          Object.assign(run, { state: "SEALED", sealed_at: timestamp(), empty_reason: board.tasks.length ? null : emptyReason.trim() });
        } else check(board.strategy_runs.every(run => run.state === "SEALED"), "请先分别封存所有启用的挖掘方式。");
        if (board.strategy_runs.some(run => run.state !== "SEALED")) return { sealed: false, strategy_id: strategyId, strategy_sealed: true };
      } else {
        assertSweepSealable(board);
        checkStrategy("api");
        check(board.tasks.length || typeof emptyReason === "string" && emptyReason.trim(), "空面板必须说明未产生审计任务的原因。");
      }
      board.publication = { state: "SEALED", sealed_at: board.publication.sealed_at ?? timestamp(), empty_reason: board.tasks.length ? null : emptyReason?.trim() || board.strategy_runs?.map(run => run.empty_reason).filter(Boolean).join("；") };
      return { sealed: true };
    });
  }
  async claim(domain, leaseMs) {
    return this.mutate(board => {
      if (board.tasks.some(task => task.domain === domain && task.status === "RUNNING")) return null;
      const candidates = board.tasks.filter(task => task.domain === domain && task.status === "PENDING"
        && (!board.active_round || board.active_round.work_item_ids.includes(task.task_id)));
      const last = board.dispatch_order?.[domain] ?? {};
      const task = candidates.sort((a, b) => (last[taskStrategy(a, board)] ?? 0) - (last[taskStrategy(b, board)] ?? 0) || (a.priority ?? 2) - (b.priority ?? 2))[0];
      if (!task) return null;
      if (board.mining_strategies) { board.dispatch_order ??= {}; board.dispatch_order[domain] ??= {}; board.dispatch_order[domain][taskStrategy(task, board)] = board.attempts.length + 1; }
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
        check(task.status === receipt.outcome && (receipt.outcome === "GAP" || (task.report?.sha256 ?? null) === reportDigest) && (task.reason ?? null) === (receipt.outcome === "GAP" ? receipt.reason.trim() : null), "重复回执与已接收结果不同。");
        return { received: true, duplicate: true };
      }
      check(task.status === "RUNNING", "任务当前未运行。");
      if (bytes) await checkReportIntegrity(bytes, { reportsRoot: this.reportsRoot, taskId });
      if (bytes) await verifyIncrementalReplacement(task, bytes, this.reportsRoot);
      if (bytes) {
        const extension = receipt.report_path.endsWith(".md") ? "md" : "json";
        const file = join(this.reportsRoot, "task-board", this.auditId, "reports", `${hash(taskId).slice(0, 24)}.${attemptId}.${extension}`);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, bytes, { mode: 0o600 });
        task.report = { path: relative(this.reportsRoot, file).split("\\").join("/"), sha256: reportDigest, byte_length: bytes.length };
      }
      check(canReceive(), "交付快照已失效。");
      delete task.execution_failure;
      task.status = receipt.outcome; task.reason = receipt.outcome === "GAP" ? receipt.reason.trim() : null; task.completed_at = timestamp();
      if (receipt.outcome === "GAP" && task.incremental?.previous_report) task.report = structuredClone(task.incremental.previous_report);
      Object.assign(board.attempts.find(row => row.attempt_id === attemptId), { status: receipt.outcome, completed_at: task.completed_at });
      if (receipt.outcome === 'REPORTED' && task.report) {
        board.outbox ??= [];
        board.outbox.push({ event_id: `accepted-${hash(`${this.auditId}:${taskId}:${attemptId}:${reportDigest}`).slice(0, 32)}`,
          type: 'static.report.accepted', audit_id: this.auditId, sequence: board.outbox.length + 1, task_id: taskId, attempt_id: attemptId,
          payload_ref: task.report.path, payload_sha256: reportDigest, scope_digest: board.scope_digest });
      }
      return { received: true, report: task.report };
    });
  }
  async fail(taskId, attemptId, reason, { interrupted = false, terminal = false, kind = "EXECUTION_FAILED" } = {}) {
    return this.mutate(board => {
      const task = board.tasks.find(row => row.task_id === taskId);
      if (!task || task.attempt_id !== attemptId || task.status !== "RUNNING") return;
      if (!interrupted) task.failure_count = (task.failure_count ?? 0) + 1;
      task.status = interrupted || !terminal && task.failure_count < 3 ? "PENDING" : "FAILED"; task.reason = String(reason).slice(0, 2000);
      if (interrupted) delete task.execution_failure;
      else task.execution_failure = { attempt_id: attemptId, kind, retryable: true, recorded_at: timestamp() };
      Object.assign(board.attempts.find(row => row.attempt_id === attemptId), { status: interrupted ? "INTERRUPTED" : "FAILED", reason: task.reason, completed_at: timestamp() });
    });
  }
  async skip({ task_id: taskId, reason }) {
    check(typeof reason === "string" && reason.trim() && reason.length <= 4000, "跳过任务必须提供具体原因。");
    return this.mutate(board => {
      const task = board.tasks.find(row => row.task_id === taskId);
      const failures = task?.failure_count ?? board.attempts.filter(attempt => attempt.task_id === taskId && attempt.status === "FAILED").length;
      check(task?.status === "FAILED" && (failures >= 3 || task.timeout_recovery?.state === "exhausted" || task.strategy_id === "creed" && task.execution_failure?.attempt_id === task.attempt_id), "只有实际执行失败达到三次、模型超时恢复耗尽或 CREED 单响应失败的工作项才能 skip；待处理任务须保留，预算不足请 defer 暂停。");
      task.status = "GAP"; task.reason = reason.trim(); task.completed_at = timestamp();
      if (task.incremental?.previous_report) task.report = structuredClone(task.incremental.previous_report);
    });
  }
  async close() {
    await this.queue.catch(() => {});
    if (!this.lockPath) return;
    try { const lock = JSON.parse(await readFile(this.lockPath, "utf8")); if (lock.owner === this.owner) await rm(this.lockPath); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
