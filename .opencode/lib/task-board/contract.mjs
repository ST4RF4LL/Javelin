import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { selection as agentMiningSelection } from "../agent-mining/profile.mjs";
import { sweepSummary, taskKindForStrategy } from "./file-sweep.mjs";

export const PROTOCOL = "task-board.v1";
export const MINING_CONTRACT = "mining-strategies.v1";
export const MINING_STRATEGIES = Object.freeze(["focus_area", "api", "file_sweep", "creed"]);
export const miningStrategies = board => board.mining_strategies ?? (board.mining_strategy ? [board.mining_strategy] : []);
export const hasMiningStrategy = (board, strategy) => miningStrategies(board).includes(strategy);
export const taskStrategy = (task, board) => task.strategy_id ?? board.mining_strategy ?? (task.kind === "function" ? "creed" : task.kind);
export const DOMAINS = Object.freeze({ web: "web-source-auditor", java: "java-source-auditor", python: "python-source-auditor", "c-cpp": "c-cpp-source-auditor", ai: "ai-security-auditor", platform: "platform-security-auditor" });
export const TERMINAL = new Set(["REPORTED", "GAP"]);
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const digest = value => hash(JSON.stringify(value));
export const check = (condition, message) => { if (!condition) throw Object.assign(new Error(message), { statusCode: 422 }); };
export const timestamp = () => new Date().toISOString();
export const validId = value => typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,159}$/i.test(value);

export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function controlledBytes(root, path, maximum = 8 * 1024 * 1024) {
  const base = await realpath(root), absolute = resolve(root, path);
  const rel = relative(resolve(root), absolute);
  check(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), "制品路径超出受控目录。");
  const info = await lstat(absolute);
  check(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximum, "制品必须是大小有效的普通文件。");
  const realRel = relative(base, await realpath(absolute));
  check(realRel && realRel !== ".." && !realRel.startsWith(`..${sep}`) && !isAbsolute(realRel), "制品链接超出受控目录。");
  const bytes = await readFile(absolute);
  check(bytes.length > 0 && bytes.length <= maximum, "制品大小无效。");
  return bytes;
}

export function normalizeApiList(value = "") {
  check(typeof value === "string" && value.length <= 120_000, "API 清单须为不超过 120000 字符的文本。");
  if (!value.trim()) return [];
  let entries;
  if (value.trim().startsWith("[")) {
    try { entries = JSON.parse(value); } catch { throw new Error("API JSON 清单无法解析；也可改为每行一个接口的文本。"); }
    check(Array.isArray(entries), "API JSON 清单必须是数组。");
    entries = entries.map(entry => typeof entry === "string" ? entry : JSON.stringify(entry));
  } else entries = value.split(/\r?\n/).filter(line => line.trim());
  check(entries.length <= 5000 && entries.every(entry => entry.trim() && entry.length <= 24_000), "API 清单最多 5000 项，每项最多 24000 字符。");
  return entries.map((text, index) => ({ source_id: `api-${index + 1}-${hash(text).slice(0, 12)}`, ordinal: index + 1, text }));
}

export function selectMiningStrategies(value, apiList = "", legacyValue = null) {
  const sources = normalizeApiList(apiList);
  const selected = value ?? [legacyValue ?? (sources.length ? "api" : "focus_area")];
  check(Array.isArray(selected) && selected.length >= 1 && selected.length <= MINING_STRATEGIES.length
    && selected.every(strategy => MINING_STRATEGIES.includes(strategy)) && new Set(selected).size === selected.length,
    "漏洞挖掘方式须为 focus_area、api、file_sweep、creed 的非空且不重复列表。");
  check(legacyValue == null || selected.length === 1 && selected[0] === legacyValue, "新旧漏洞挖掘方式字段不一致。");
  check(!selected.includes("api") || sources.length > 0, "逐接口 API 审查需要至少一项 API 清单。");
  check(selected.includes("api") || sources.length === 0, "未启用逐接口 API 审查时不接收 API 清单。");
  return MINING_STRATEGIES.filter(strategy => selected.includes(strategy));
}

export function selectMiningStrategy(value, apiList = "") {
  return selectMiningStrategies(null, apiList, value)[0];
}

export function normalizeTask(input, board) {
  check(input && ["focus_area", "api", "function"].includes(input.kind), "工作项类型必须为 focus_area、api 或 function。");
  const multi = Array.isArray(board.mining_strategies);
  const strategy = multi ? input.strategy_id ?? (board.mining_strategies.length === 1 ? board.mining_strategies[0] : null) : board.mining_strategy;
  check(multi || input.kind !== "function", "CREED 函数工作项需要新版多策略契约。");
  check(multi || input.strategy_id == null || input.strategy_id === strategy, "历史工作项不能改变已选挖掘方式。");
  check(!multi || board.mining_strategies.includes(strategy), "工作项必须声明已启用的 strategy_id。");
  check(!strategy || input.kind === taskKindForStrategy(strategy), "工作项类型与本次选定的漏洞挖掘策略不一致。");
  check(validId(input.task_id), "任务必须提供稳定的 task_id。");
  check(typeof input.title === "string" && input.title.trim() && input.title.length <= 240, "任务名称不能为空且最多 240 字符。");
  check(Object.hasOwn(DOMAINS, input.domain), "任务领域不受支持；请根据实际代码选择专业 Agent。");
  check(input.agent_mining == null || input.domain === "ai", "Agent 边界挖掘配置仅用于 ai 领域任务。");
  check(typeof input.prompt === "string" && input.prompt.trim() && input.prompt.length <= 48_000, "任务描述不能为空且最多 48000 字符。");
  check(typeof input.source_ref === "string" && input.source_ref.trim() && input.source_ref.length <= 1000, "任务必须保留来源引用。");
  if (input.kind === "api") check(board.api_sources.some(row => row.source_id === input.source_ref), "API 任务必须引用已导入清单中的 source_id。");
  if (strategy === "file_sweep") check(board.file_sweep?.files.some(file => file.file_id === input.source_ref && file.status !== "EXCLUDED"), "逐文件产生的 Focus Area 必须引用冻结清单中的 file_id。");
  if (strategy === "creed") {
    const fn = board.creed_inventory?.functions.find(row => row.function_id === input.source_ref);
    check(fn && input.creed?.protocol === "creed.v1" && digest(input.creed.function) === digest(fn), "CREED 工作项须绑定冻结函数清单中的完整条目。");
  }
  const sourceRefs = input.source_refs ?? [{ strategy_id: strategy, source_ref: input.source_ref }];
  if (multi) check(Array.isArray(sourceRefs) && sourceRefs.length > 0 && sourceRefs.length <= 100
    && sourceRefs.every(ref => ref?.strategy_id === strategy && typeof ref.source_ref === "string" && ref.source_ref.trim() && ref.source_ref.length <= 1000)
    && sourceRefs.some(ref => ref.source_ref === input.source_ref)
    && new Set(sourceRefs.map(ref => `${ref.strategy_id}:${ref.source_ref}`)).size === sourceRefs.length, "工作项来源列表无效。");
  if (multi && strategy !== "focus_area") for (const ref of sourceRefs) {
    const allowed = strategy === "api" ? board.api_sources.some(row => row.source_id === ref.source_ref)
      : strategy === "file_sweep" ? board.file_sweep?.files.some(row => row.file_id === ref.source_ref && row.status !== "EXCLUDED")
        : board.creed_inventory?.functions.some(row => row.function_id === ref.source_ref);
    check(allowed, "工作项来源引用不属于本方式的冻结清单。");
  }
  check(Array.isArray(input.code_refs ?? []) && (input.code_refs ?? []).length <= 100, "代码定位列表无效。");
  const codeRefs = (input.code_refs ?? []).map(ref => {
    check(ref && typeof ref.path === "string" && ref.path && !isAbsolute(ref.path) && !ref.path.split(/[\\/]/).includes(".."), "代码定位必须使用源码根内的相对路径。");
    check(ref.line == null || Number.isInteger(ref.line) && ref.line > 0, "代码行号无效。");
    return { path: ref.path, ...(ref.line ? { line: ref.line } : {}), ...(typeof ref.symbol === "string" ? { symbol: ref.symbol.slice(0, 500) } : {}) };
  });
  let rootCause = null;
  if (input.root_cause != null) {
    check(input.root_cause && typeof input.root_cause === "object", "根因定位无效。");
    rootCause = {};
    for (const key of ["path", "symbol", "weakness", "trust_boundary", "preconditions"]) {
      check(typeof input.root_cause[key] === "string" && input.root_cause[key].trim() && input.root_cause[key].length <= 1000, "根因定位须包含文件、符号、弱点、信任边界与前提条件。");
      rootCause[key] = input.root_cause[key].trim();
    }
    check(codeRefs.some(ref => ref.path === rootCause.path), "根因文件必须出现在代码定位中。");
  }
  check(input.priority == null || [1, 2, 3].includes(input.priority), "任务优先级为 1（高风险）、2（一般疑点）、3（边界探索）。");
  return { task_id: input.task_id, kind: input.kind, ...(multi ? { strategy_id: strategy, source_refs: sourceRefs.map(({ strategy_id, source_ref }) => ({ strategy_id, source_ref })) } : {}), title: input.title.trim(), domain: input.domain,
    agent_name: DOMAINS[input.domain], prompt: input.prompt, source_ref: input.source_ref, code_refs: codeRefs,
    ...(strategy === "creed" ? { creed: structuredClone(input.creed) } : {}),
    ...(rootCause ? { root_cause: rootCause } : {}), ...(input.priority != null ? { priority: input.priority } : {}),
    ...(input.bac_analysis != null ? { bac_analysis: normalizeBacTask(input.bac_analysis) } : {}),
    ...(input.agent_mining != null ? { agent_mining: agentMiningSelection(input.agent_mining) } : {}),
    parent_task_id: input.parent_task_id ?? null, scope_digest: board.scope_digest };
}

function normalizeBacTask(value) {
  check(value && typeof value === "object" && !Array.isArray(value), "任务专项输入无效。");
  const ref = row => {
    check(row && typeof row.path === "string" && row.path && !isAbsolute(row.path) && !row.path.split(/[\\/]/).includes("..")
      && /^[a-f0-9]{64}$/.test(row.sha256 ?? ""), "专项制品须绑定报告根内相对路径及 SHA-256。");
    return { path: row.path, sha256: row.sha256 };
  };
  check(Array.isArray(value.policy_shards ?? []) && (value.policy_shards ?? []).length <= 100, "策略分片列表无效。");
  check(Array.isArray(value.entry_points ?? []) && (value.entry_points ?? []).length <= 5000, "专项入口列表无效。");
  const entries = (value.entry_points ?? []).map(row => {
    check(row && typeof row.api_id === "string" && row.api_id.trim() && row.api_id.length <= 1000 && typeof row.operation === "string" && row.operation.trim(), "专项入口须有稳定 API ID 及操作说明。");
    return { api_id: row.api_id, operation: row.operation };
  });
  check(new Set(entries.map(row => row.api_id)).size === entries.length, "专项入口 ID 重复。");
  return { policy_shards: (value.policy_shards ?? []).map(ref),
    ...(value.resource_role_catalog ? { resource_role_catalog: ref(value.resource_role_catalog) } : {}), entry_points: entries };
}

export function deliveryOutcome(summary) {
  if (summary.audit_mode === "dynamic") return "RUNTIME_ONLY";
  if (summary.reported && summary.complete === false) return "PARTIAL";
  if (summary.strategy_coverage?.creed?.inventory_gaps) return summary.reported ? "PARTIAL" : "NO_REPORTS";
  if (summary.file_sweep) {
    if (!summary.total) return summary.file_sweep.browsed_files ? "DISCOVERY_ONLY" : "NO_REPORTS";
    if (summary.reported && summary.file_sweep.gap_files) return "PARTIAL";
  }
  if (!summary.total) return "NO_TASKS";
  if (!summary.reported) return "NO_REPORTS";
  return summary.reported === summary.total ? "DELIVERED" : "PARTIAL";
}

export function summarize(board) {
  const counts = {}, apiDeliveries = new Map();
  const tracks = Object.fromEntries(["focus_area", "api", ...(board.mining_strategies ? ["function"] : [])].map(kind => [kind, { total: 0, reported: 0, gap: 0 }]));
  for (const task of board.tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    const track = tracks[task.kind];
    track.total++;
    if (task.status === "REPORTED") track.reported++;
    if (task.status === "GAP") track.gap++;
    if (task.kind === "api") apiDeliveries.set(task.source_ref, (apiDeliveries.get(task.source_ref) ?? true) && task.status === "REPORTED");
  }
  const count = status => counts[status] ?? 0;
  const total = board.tasks.length, reported = count("REPORTED"), gap = count("GAP");
  const sweep = sweepSummary(board);
  const complete = board.publication.state === "SEALED" && reported + gap === total && (!hasMiningStrategy(board, "file_sweep") || sweep?.complete === true);
  const roundComplete = board.active_round && board.active_round.work_item_ids.length > 0 && board.active_round.work_item_ids.every(id => board.tasks.some(task => task.task_id === id && TERMINAL.has(task.status)));
  const miningComplete = board.active_round ? roundComplete : complete;
  const apiReported = board.api_sources.filter(source => apiDeliveries.get(source.source_id) === true).length;
  const strategyCoverage = board.mining_strategies && Object.fromEntries(board.mining_strategies.map(strategy => {
    const tasks = board.tasks.filter(task => taskStrategy(task, board) === strategy);
    const states = Object.fromEntries(["REPORTED", "GAP", "PENDING", "RUNNING", "FAILED"].map(status => [status.toLowerCase(), tasks.filter(task => task.status === status).length]));
    return [strategy, { total: tasks.length, ...states,
      ...(strategy === "api" ? { submitted_apis: board.api_sources.length, reported_apis: apiReported } : {}),
      ...(strategy === "file_sweep" && sweep ? { eligible_files: sweep.eligible_files, browsed_files: sweep.browsed_files, gap_files: sweep.gap_files } : {}),
      ...(strategy === "creed" ? { eligible_functions: board.creed_inventory?.functions.length ?? 0, inventory_gaps: board.creed_inventory?.gaps?.length ?? 0, omitted_functions: board.creed_inventory?.summary?.omitted_functions ?? 0, inventory_complete: board.creed_inventory?.complete === true } : {}) }];
  }));
  return { protocol: PROTOCOL, ...(board.audit_mode ? { audit_mode: board.audit_mode } : {}), revision: board.revision, audit_id: board.audit_id, total, reported, done: reported, gap,
    ...(board.mining_strategy ? { mining_strategy: board.mining_strategy } : {}),
    ...(board.mining_strategies ? { mining_contract: board.mining_contract, mining_strategies: board.mining_strategies, strategy_runs: board.strategy_runs, strategy_coverage: strategyCoverage } : {}),
    ...(sweep ? { file_sweep: sweep } : {}),
    pending: count("PENDING"), running: count("RUNNING"), failed: count("FAILED"), complete, mining_complete: miningComplete,
    ...(board.active_round ? { round_complete: roundComplete, active_round: board.active_round } : {}),
    publication: board.publication.state, progress: total ? Math.round((reported + gap) * 100 / total) : 0,
    delivery_percentage: total ? Number((reported * 100 / total).toFixed(2)) : null, tracks,
    api_inventory: { submitted: board.api_sources.length, reported: apiReported, coverage_basis: "USER_SUPPLIED_LIST" },
    validation: { status: board.validation?.status ?? "NOT_STARTED", reviewed: board.validation?.assessments?.length ?? 0,
      ...(board.validation?.batch_plan ? { total_batches: board.validation.batch_count, completed_batches: (board.validation.batch_results ?? []).filter(row => row.moderator).length, ...(board.validation.reused_batch_count ? { reused_batches: board.validation.reused_batch_count } : {}) } : {}) },
    ...(board.suspension ? { suspension: board.suspension } : {}),
    next_action: board.suspension ? "PAUSED" : !board.active_round && board.publication.state !== "SEALED" ? "PUBLISH" : count("FAILED") ? "RESOLVE_FAILURES"
      : miningComplete ? board.final_report ? "DONE" : board.validation?.status === "REVIEWED" ? "FINALIZE" : "VALIDATE" : "WAIT" };
}
