import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { selection as agentMiningSelection } from "../agent-mining/profile.mjs";

export const PROTOCOL = "task-board.v1";
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

export function selectMiningStrategy(value, apiList = "") {
  const sources = normalizeApiList(apiList);
  const strategy = value ?? (sources.length ? "api" : "focus_area");
  check(["focus_area", "api"].includes(strategy), "漏洞挖掘策略必须为 focus_area 或 api。");
  check(strategy !== "api" || sources.length > 0, "逐接口 API 审查需要至少一项 API 清单。");
  check(strategy !== "focus_area" || sources.length === 0, "高风险 Focus Area 策略不接收 API 清单；请切换为逐接口 API 审查。");
  return strategy;
}

export function normalizeTask(input, board) {
  check(input && ["focus_area", "api"].includes(input.kind), "任务类型必须为 focus_area 或 api。");
  check(!board.mining_strategy || input.kind === board.mining_strategy, "任务类型与本次选定的漏洞挖掘策略不一致。");
  check(validId(input.task_id), "任务必须提供稳定的 task_id。");
  check(typeof input.title === "string" && input.title.trim() && input.title.length <= 240, "任务名称不能为空且最多 240 字符。");
  check(Object.hasOwn(DOMAINS, input.domain), "任务领域不受支持；请根据实际代码选择专业 Agent。");
  check(input.agent_mining == null || input.domain === "ai", "Agent 边界挖掘配置仅用于 ai 领域任务。");
  check(typeof input.prompt === "string" && input.prompt.trim() && input.prompt.length <= 48_000, "任务描述不能为空且最多 48000 字符。");
  check(typeof input.source_ref === "string" && input.source_ref.trim() && input.source_ref.length <= 1000, "任务必须保留来源引用。");
  if (input.kind === "api") check(board.api_sources.some(row => row.source_id === input.source_ref), "API 任务必须引用已导入清单中的 source_id。");
  check(Array.isArray(input.code_refs ?? []) && (input.code_refs ?? []).length <= 100, "代码定位列表无效。");
  const codeRefs = (input.code_refs ?? []).map(ref => {
    check(ref && typeof ref.path === "string" && ref.path && !isAbsolute(ref.path) && !ref.path.split(/[\\/]/).includes(".."), "代码定位必须使用源码根内的相对路径。");
    check(ref.line == null || Number.isInteger(ref.line) && ref.line > 0, "代码行号无效。");
    return { path: ref.path, ...(ref.line ? { line: ref.line } : {}), ...(typeof ref.symbol === "string" ? { symbol: ref.symbol.slice(0, 500) } : {}) };
  });
  return { task_id: input.task_id, kind: input.kind, title: input.title.trim(), domain: input.domain,
    agent_name: DOMAINS[input.domain], prompt: input.prompt, source_ref: input.source_ref, code_refs: codeRefs,
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
  if (!summary.total) return "NO_TASKS";
  if (!summary.reported) return "NO_REPORTS";
  return summary.reported === summary.total ? "DELIVERED" : "PARTIAL";
}

export function summarize(board) {
  const counts = {}, apiDeliveries = new Map();
  const tracks = Object.fromEntries(["focus_area", "api"].map(kind => [kind, { total: 0, reported: 0, gap: 0 }]));
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
  const complete = board.publication.state === "SEALED" && reported + gap === total;
  const apiReported = board.api_sources.filter(source => apiDeliveries.get(source.source_id) === true).length;
  return { protocol: PROTOCOL, revision: board.revision, audit_id: board.audit_id, total, reported, done: reported, gap,
    ...(board.mining_strategy ? { mining_strategy: board.mining_strategy } : {}),
    pending: count("PENDING"), running: count("RUNNING"), failed: count("FAILED"), complete, mining_complete: complete,
    publication: board.publication.state, progress: total ? Math.round((reported + gap) * 100 / total) : 0,
    delivery_percentage: total ? Number((reported * 100 / total).toFixed(2)) : null, tracks,
    api_inventory: { submitted: board.api_sources.length, reported: apiReported, coverage_basis: "USER_SUPPLIED_LIST" },
    validation: { status: board.validation?.status ?? "NOT_STARTED", reviewed: board.validation?.assessments?.length ?? 0 },
    next_action: board.publication.state !== "SEALED" ? "PUBLISH" : count("FAILED") ? "RESOLVE_FAILURES"
      : complete ? board.final_report ? "DONE" : board.validation?.status === "REVIEWED" ? "FINALIZE" : "VALIDATE" : "WAIT" };
}
