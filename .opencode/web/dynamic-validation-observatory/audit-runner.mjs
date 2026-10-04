import { PROTOCOL as TASK_BOARD_PROTOCOL, normalizeApiList, selectMiningStrategy, summarize as summarizeBoard } from "../../lib/task-board/contract.mjs";
import { createBoard, readBoard } from "../../lib/task-board/store.mjs";
import { TaskBoardService } from "../../lib/task-board/service.mjs";
import { verifyBoardCompletion } from "../../lib/task-board/review.mjs";
import { EventLogReader } from "./event-log-reader.mjs";
import { selection as runtimeSelection, authorize as authorizeRuntime } from "../../lib/runtime-testing/contract.mjs";
import { RuntimeTestingService } from "../../lib/runtime-testing/service.mjs";
import { knowledgeEnvironment } from "../../lib/knowledge-workflow.mjs";
import { bacSelection } from "../../lib/bac/contract.mjs";
import { verifyBacFinalReport } from "../../lib/bac/final-verification.mjs";
import { verifyIntegratedFinalReport } from "../../lib/runtime-testing/final-verification.mjs";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenCodeEnvironment, proxyEnvironmentFrom } from "./opencode-runtime-config.mjs";
import { DEFAULT_MODEL_SELECTION, normalizeOpenCodeModel } from "./opencode-model-settings.mjs";
import { OpenCodeTmuxMonitor } from "./tmux-monitor.mjs";
import { openCodeEventView } from "./opencode-event-view.mjs";
import { auditsFromArtifacts, materializeFinalReportFromModel, scanReportArtifacts } from "./workspace-model.mjs";
import { verifyAuditStageDeliveries } from "../../skills/common-subagent/audit-artifact-management/scripts/stage-delivery-materialization.mjs";
import { auditTodoSummary, createEmptyAuditTodo } from "../../scripts/audit-todo-core.mjs";
import { inspectFocusAreaCoverage, formatFocusAreaReminder } from "../../scripts/focus-area-watchdog.mjs";
import { validateFinalReportModel } from "../../skills/common-subagent/audit-coverage-accounting/scripts/final-report-model-core.mjs";

const execFileAsync = promisify(execFile);
const AUDIT_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/i;
const REPOSITORY_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/i;
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled"]);
const ACTIVE = new Set(["queued", "preparing", "recovering", "running", "pausing", "paused", "cancelling"]);
const EXECUTING = new Set([...ACTIVE].filter(status => status !== "queued"));
const RECOVERABLE = new Set(["failed", "interrupted", "cancelled"]);
const NO_TASK_REPORTS_MESSAGE = "本轮已封存失败与缺口记录，但未收到任何源码审计报告，审计执行未完成。请修复执行问题后新建重试；不能据此判断目标是否存在漏洞。";
const hasNoTaskReports = audit => audit.task_protocol === TASK_BOARD_PROTOCOL
  && audit.todo_completion?.complete === true && audit.todo_completion?.delivery_outcome === "NO_REPORTS";
const MAX_LOG_LINE = 16 * 1024;
const MAX_LOG_READ_BYTES = 256 * 1024;
const MAX_DELIVERY_CANDIDATES = 8;
const MAX_ADDITIONAL_INSTRUCTIONS = 12_000;
const MAX_TEST_ENVIRONMENT_CONTEXT = 24_000;
const COMPLETION_WATCHDOG_INTERVAL_MS = 15_000;
const OPERATION_TIMEOUT_PATTERN = /\bthe operation timed out\b/i;
const OPERATION_TIMEOUT_RECOVERY_REASON = "operation-timed-out";
const MAX_OPERATION_TIMEOUT_RECOVERIES = 3;
const OPERATION_TIMEOUT_TERMINATION_GRACE_MS = 10_000;
const CONTEXT_WINDOW_PATTERN = /this model(?:'s|’s) maximum (?:input|context) length is\b/i;
const CONTEXT_WINDOW_RECOVERY_REASON = "context-window-exceeded";
const MAX_CONTEXT_WINDOW_RECOVERIES = 3;
const CONTEXT_COMPACTION_TIMEOUT_MS = 120_000;
const PRIVATE_CONTEXT_FILES = Object.freeze({
  api_inventory: "api-inventory.txt",
  additional_instructions: "additional-instructions.txt",
  test_environment: "test-environment.txt",
});
const PRIVATE_PROXY_ENVIRONMENT_FILE = "proxy-environment.json";
const TERMINAL_OUTPUT_RELAY = fileURLToPath(new URL("./terminal-output-relay.mjs", import.meta.url));
const STAGE_DELIVERY_REGISTRY = fileURLToPath(new URL("../../skills/common-subagent/audit-artifact-management/contracts/workbench-stage-deliveries.json", import.meta.url));
const STAGE_AGENT_REGISTRY = fileURLToPath(new URL("../../skills/common-subagent/audit-artifact-management/contracts/stage-agent-contracts.json", import.meta.url));
const SCOPE_MANIFEST_BUILDER = fileURLToPath(new URL("../../skills/common-subagent/audit-coverage-accounting/scripts/build-scope-manifest.mjs", import.meta.url));

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function digestObjectWithout(value, field) {
  const copy = structuredClone(value);
  delete copy[field];
  return createHash("sha256").update(JSON.stringify(canonicalize(copy))).digest("hex");
}

async function defaultStageDeliveryVerifier({ reportsRoot, auditId }) {
  const [registry, stageAgentRegistry] = await Promise.all([
    readFile(join(dirname(STAGE_DELIVERY_REGISTRY), "legacy-enforced-v1", "workbench-stage-deliveries.json"), "utf8").then(JSON.parse),
    readFile(join(dirname(STAGE_AGENT_REGISTRY), "legacy-enforced-v1", "stage-agent-contracts.json"), "utf8").then(JSON.parse),
  ]);
  const verification = await verifyAuditStageDeliveries({ reportsRoot, auditId, registry, stageAgentRegistry });
  return {
    ...verification,
    errors: [...new Set([...(verification.errors ?? []), ...deliveryVerificationGuidance(verification.errors, reportsRoot)])],
  };
}

function reportDeliveryPaths(reportsRoot, auditId) {
  const root = resolve(reportsRoot);
  const reportRelativePath = `reports/final/security-audit-report.${auditId}.md`;
  const modelRelativePath = `reports/final/security-audit-report-model.${auditId}.json`;
  return {
    root,
    finalDirectory: join(root, "final"),
    reportRelativePath,
    modelRelativePath,
    reportPath: join(root, "final", `security-audit-report.${auditId}.md`),
    modelPath: join(root, "final", `security-audit-report-model.${auditId}.json`),
  };
}

function reportsRelative(reportsRoot, candidate) {
  const path = relative(resolve(reportsRoot), resolve(candidate));
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return null;
  return `reports/${path.split(sep).join("/")}`;
}

async function finalDeliveryCandidates(reportsRoot, current, depth = 0, output = []) {
  if (depth > 2 || output.length >= MAX_DELIVERY_CANDIDATES) return output;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return output;
    throw error;
  }
  for (const entry of entries) {
    if (output.length >= MAX_DELIVERY_CANDIDATES) break;
    if (entry.name.startsWith(".")) continue;
    const candidate = join(current, entry.name);
    if (entry.isDirectory()) {
      await finalDeliveryCandidates(reportsRoot, candidate, depth + 1, output);
      continue;
    }
    if (entry.isFile() && /\.(?:md|json)$/i.test(entry.name)) {
      const display = reportsRelative(reportsRoot, candidate);
      if (display) output.push({ path: candidate, relative_path: display, name: entry.name });
    }
  }
  return output;
}

function finalModelValidationHints(model) {
  const labels = {
    "final-report-model-schema-version-invalid": "schema_version 不受支持",
    "final-report-model-audit-or-scope-invalid": "audit_id 或 scope_digest 无效",
    "final-report-model-kind-invalid": "report_kind 无效",
    "final-report-model-inputs-invalid": "输入制品绑定不完整",
    "final-report-model-coverage-invalid": "覆盖率摘要不符合最终报告要求",
    "final-report-model-truth-validation-invalid": "真实性验证摘要不符合要求",
    "final-report-model-digest-invalid": "manifest_digest 校验失败",
  };
  return [...new Set(validateFinalReportModel(model).slice(0, 6).map(error => labels[error] ?? `模型契约校验失败（${error}）`))];
}

async function finalReportDeliveryDiagnostics({ reportsRoot, auditId, repair }) {
  const paths = reportDeliveryPaths(reportsRoot, auditId);
  const hints = [
    `最终报告交付件缺失：应写入执行工作区相对路径 ${paths.reportRelativePath}（受控目录：${paths.root}）。`,
  ];
  if (repair?.error === "final-report-render-too-large") {
    hints.push("最终报告模型可渲染，但生成的 Markdown 超过工作台 8 MiB 制品上限；请拆分证据或压缩报告后按指定路径重新封存。");
  }
  let reportInfo = null;
  try { reportInfo = await stat(paths.reportPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (reportInfo) {
    if (!reportInfo.isFile()) hints.push(`目标 ${paths.reportRelativePath} 已存在但不是普通文件；请移除该占位并写入 UTF-8 Markdown 文件。`);
    else if (reportInfo.size > 8 * 1024 * 1024) hints.push(`目标 ${paths.reportRelativePath} 为 ${reportInfo.size} 字节，超过工作台 8 MiB 制品上限，无法索引。`);
    else hints.push(`目标 ${paths.reportRelativePath} 已存在但未被索引；请确认文件名、UTF-8 编码和 audit_id 完全一致。`);
  }
  const candidates = await finalDeliveryCandidates(paths.root, paths.finalDirectory);
  const relatedMarkdown = candidates.filter(item => item.name.toLowerCase().endsWith(".md") && item.relative_path !== paths.reportRelativePath && item.relative_path.includes(auditId));
  if (relatedMarkdown.length) {
    hints.push(`发现同一审计的 Markdown 候选：${relatedMarkdown.map(item => item.relative_path).join("、")}；请改名并移动为 ${paths.reportRelativePath}。`);
  }
  const relatedModels = candidates.filter(item => item.name.toLowerCase().endsWith(".json") && item.relative_path.includes(auditId));
  if (relatedModels.length && !relatedModels.some(item => item.relative_path === paths.modelRelativePath)) {
    hints.push(`发现同一审计的报告模型候选：${relatedModels.map(item => item.relative_path).join("、")}；标准模型路径应为 ${paths.modelRelativePath}。`);
  }
  try {
    const raw = await readFile(paths.modelPath, "utf8");
    let model;
    try { model = JSON.parse(raw); } catch { hints.push(`报告模型 ${paths.modelRelativePath} 不是有效 JSON。`); return [...new Set(hints)]; }
    if (model?.audit_id !== auditId) hints.push(`报告模型 ${paths.modelRelativePath} 的 audit_id 为 ${String(model?.audit_id ?? "<缺失>")}，应为 ${auditId}。`);
    else {
      const modelHints = [
        ...finalModelValidationHints(model),
        ...(!["FINAL", "POLICY_FINAL", "PARTIAL_FINAL"].includes(model?.report_kind) ? ["report_kind 必须为 FINAL、POLICY_FINAL 或 PARTIAL_FINAL"] : []),
      ];
      if (modelHints.length) hints.push(`报告模型 ${paths.modelRelativePath} 格式不合法：${modelHints.join("；")}。`);
    }
  } catch (error) {
    if (error?.code === "ENOENT" && relatedMarkdown.length === 0 && relatedModels.length === 0) {
      hints.push(`未发现同一审计的最终 Markdown 或报告模型；请按上述路径执行报告封存，不必重跑已完成的漏洞挖掘工作包。`);
    } else if (error?.code !== "ENOENT") {
      hints.push(`无法读取报告模型 ${paths.modelRelativePath}：${error.code ?? "unknown-error"}。`);
    }
  }
  return [...new Set(hints)];
}

function deliveryVerificationGuidance(errors, reportsRoot) {
  const root = resolve(reportsRoot);
  const hints = [];
  for (const error of errors ?? []) {
    const missing = String(error).match(/artifact-missing:(reports\/[^\s:]+)/);
    if (missing) hints.push(`交付件缺失：应在受控目录 ${root} 下提供 ${missing[1]}。`);
    const invalidJson = String(error).match(/artifact-json-invalid:([^:]+)/);
    if (invalidJson) hints.push(`交付件格式错误：${invalidJson[1]} 必须是有效 JSON，并满足其阶段契约。`);
    const digest = String(error).match(/artifact-sha256-mismatch:(reports\/[^\s:]+)/);
    if (digest) hints.push(`交付件摘要不匹配：${digest[1]} 已被修改或与 manifest 声明不一致；请重新物化该制品及所属 manifest。`);
    const location = String(error).match(/manifest-path-mismatch:(reports\/[^\s:]+)/);
    if (location) hints.push(`阶段 manifest 位置不合规：实际为 ${location[1]}；请使用阶段注册表规定的 reports/stage-deliveries/<audit_id>/<stage>.<round>.json 路径。`);
  }
  return [...new Set(hints)];
}

async function defaultTodoCompletionVerifier({ audit, reportsRoot }) {
  if (audit.task_protocol === TASK_BOARD_PROTOCOL) return verifyBoardCompletion({ audit, reportsRoot });
  const summary = await auditTodoSummary(audit.todo_path);
  const errors = [];
  if (!summary || summary.total === 0) errors.push("本地审计任务尚未由 Coverage Plan 初始化。");
  if (summary?.pending) errors.push(`仍有 ${summary.pending} 项 PENDING。`);
  if (summary?.running) errors.push(`仍有 ${summary.running} 项 RUNNING。`);
  if (summary?.failed) errors.push(`仍有 ${summary.failed} 项 FAILED，必须重试或人工处理。`);
  const focusCheck = await inspectFocusAreaCoverage({ todoPath: audit.todo_path, reportsRoot });
  if (focusCheck.initialized && !focusCheck.complete) errors.push(formatFocusAreaReminder(focusCheck));
  const repaired = await materializeFinalReportFromModel({ reportsRoot, auditId: audit.id });
  const finalReport = repaired.artifact;
  if (!finalReport) errors.push(...await finalReportDeliveryDiagnostics({ reportsRoot, auditId: audit.id, repair: repaired }));
  const skippedAreas = focusCheck.exceptions.filter(item => item.status === "SKIPPED").sort((a, b) => a.item_id.localeCompare(b.item_id));
  if (finalReport && skippedAreas.length) {
    try {
      const model = JSON.parse(await readFile(join(reportsRoot, "final", `security-audit-report-model.${audit.id}.json`), "utf8"));
      const reported = (model.focus_area_exceptions ?? []).filter(item => item.status === "SKIPPED").sort((a, b) => a.item_id.localeCompare(b.item_id));
      const values = rows => rows.map(item => [item.item_id, item.focus_area_id, item.assignment_id, item.domain, item.agent_name, item.status, item.reason]);
      if (JSON.stringify(values(reported)) !== JSON.stringify(values(skippedAreas))) throw new Error("skip-report-mismatch");
    } catch { errors.push("最终报告必须逐项保留本地清单中的 SKIPPED Focus Area、责任分派和跳过原因。"); }
  }
  if (audit.runtime_testing && finalReport) {
    try { await verifyIntegratedFinalReport({ audit, reportsRoot }); }
    catch (error) { errors.push(`贯穿式任务必须封存并校验 v3 报告、运行证据和独立三方结果：${error.code ?? "RUNTIME_FINAL_BINDING_INVALID"}。`); }
  }
  if (audit.bac_analysis?.mode === "auto" && finalReport) {
    try { await verifyBacFinalReport({ audit, reportsRoot }); }
    catch (error) { errors.push(`越权专项交付未通过：${error.message}`); }
  }
  return {
    complete: errors.length === 0,
    errors,
    summary,
    final_report_path: finalReport?.path ?? null,
    final_report_materialized: repaired.materialized === true,
  };
}

function sensitiveRedactionValues(text) {
  const source = String(text ?? "").trim();
  if (!source) return [];
  const values = new Set([source, JSON.stringify(source).slice(1, -1)]);
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length >= 4) values.add(trimmed);
    for (const token of trimmed.split(/[\s,;，；|:：=\/]+/u)) if (token.length >= 4) values.add(token);
  }
  return [...values].filter(value => value.length >= 4).sort((left, right) => right.length - left.length);
}

function redact(value, sensitiveValues = []) {
  let output = String(value);
  for (const sensitive of sensitiveValues) output = output.replaceAll(sensitive, "[PRIVATE_CONTEXT_REDACTED]");
  return output
    .replace(/(["']?(?:password|passwd|secret|token|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,"']+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[JWT_REDACTED]")
    .slice(0, MAX_LOG_LINE);
}

function redactTerminalOutput(value, sensitiveValues = []) {
  return String(value ?? "").split("\n").map(line => redact(line, sensitiveValues)).join("\n");
}

async function configFacts(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return { configured: true, config_valid: Boolean(value && typeof value === "object" && !Array.isArray(value)), config_error: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { configured: false, config_valid: false, config_error: null };
    return { configured: true, config_valid: false, config_error: "OpenCode 配置不是有效 JSON。" };
  }
}

function normalizeRepository(repository, defaultConfigPath) {
  if (!REPOSITORY_ID.test(repository.id ?? "")) throw new Error(`仓库 ID 非法：${repository.id ?? ""}`);
  const path = resolve(repository.path);
  return {
    id: repository.id,
    name: repository.name ?? basename(path),
    path,
    config_path: resolve(repository.config_path ?? defaultConfigPath ?? join(path, ".opencode", "opencode.json")),
  };
}

function targetRepositoryFromAudit(audit, defaultConfigPath) {
  const snapshot = audit?.execution_spec;
  const scopes = snapshot?.source_scopes;
  if (!snapshot || !Array.isArray(scopes) || scopes.length !== 1) return null;
  const scope = scopes[0];
  if (!REPOSITORY_ID.test(audit.repository_id ?? "") || typeof scope?.path !== "string" || !isAbsolute(scope.path)) return null;
  return {
    id: audit.repository_id,
    name: audit.repository_name ?? snapshot.target_name ?? audit.repository_id,
    path: resolve(scope.path),
    config_path: resolve(defaultConfigPath ?? join(scope.path, ".opencode", "opencode.json")),
    storage_namespace: snapshot.storage_namespace ?? audit.repository_id,
    execution_spec: snapshot,
  };
}

function auditSourceReference(audit) {
  if (audit?.source_kind === "directory") {
    return `目录范围快照 SHA-256: ${audit.execution_spec_digest ?? audit.source_baseline?.scope_digest ?? "未生成"}`;
  }
  return `目标提交固定为 ${audit.commit}`;
}

function repositoryRegistryEntries(registry) {
  const value = Array.isArray(registry) ? registry : registry?.repositories;
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") {
    return Object.entries(value).map(([id, repository]) => (
      typeof repository === "string"
        ? { id, path: repository }
        : { ...(repository ?? {}), id: repository?.id ?? id }
    ));
  }
  throw new Error("repositories 必须是数组或以仓库 ID 为键的对象");
}

async function git(repositoryPath, args) {
  const result = await execFileAsync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

function publicRepository(repository, facts = {}, activity = {}) {
  const issues = [];
  if (!facts.git_repository) issues.push("不是可用的 Git 工作树");
  if (!facts.configured) issues.push("工作台缺少 OpenCode 审计引擎配置");
  else if (!facts.config_valid) issues.push(facts.config_error ?? "工作台 OpenCode 审计引擎配置无效");
  const ready = Boolean(facts.git_repository && facts.configured && facts.config_valid);
  return {
    id: repository.id,
    name: repository.name,
    directory: repository.path,
    configured: facts.configured ?? false,
    config_valid: facts.config_valid ?? false,
    git_repository: facts.git_repository ?? false,
    branch: facts.branch ?? null,
    commit: facts.commit ?? null,
    dirty: facts.dirty ?? null,
    ready,
    readiness: !ready ? "blocked" : facts.dirty ? "warning" : "ready",
    issues,
    audit_count: activity.audit_count ?? 0,
    active_audit_count: activity.active_audit_count ?? 0,
    last_audit_at: activity.last_audit_at ?? null,
    last_audit_status: activity.last_audit_status ?? null,
    removable: activity.removable ?? true,
  };
}

function normalizeContextInput(input, { enabledField, valueField, label, maxLength }) {
  const enabledValue = input?.[enabledField];
  if (enabledValue !== undefined && typeof enabledValue !== "boolean") {
    throw Object.assign(new Error(`${label}的 enable 值必须是布尔值。`), { statusCode: 422, code: "audit-context-enable-invalid" });
  }
  const value = input?.[valueField];
  if (value !== undefined && value !== null && typeof value !== "string") {
    if (valueField === "test_environment_context") return { enabled: false, text: "" };
    throw Object.assign(new Error(`${label}必须是文本。`), { statusCode: 422, code: "audit-context-value-invalid" });
  }
  if (enabledValue !== true) return { enabled: false, text: "" };
  const text = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text && valueField === "test_environment_context") return { enabled: false, text: "" };
  if (!text) throw Object.assign(new Error(`启用${label}后必须填写内容。`), { statusCode: 422, code: "audit-context-required" });
  if (text.includes("\0")) throw Object.assign(new Error(`${label}包含不允许的空字符。`), { statusCode: 422, code: "audit-context-value-invalid" });
  if (text.length > maxLength) throw Object.assign(new Error(`${label}不能超过 ${maxLength} 个字符。`), { statusCode: 422, code: "audit-context-too-large" });
  return { enabled: true, text };
}

function contextMetadata(enabled, fileName = null, text = "") {
  if (!enabled) return { enabled: false, file_name: null, sha256: null, byte_length: 0, character_length: 0 };
  const bytes = Buffer.from(`${text}\n`, "utf8");
  return {
    enabled: true,
    file_name: fileName,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byte_length: bytes.length,
    character_length: text.length,
  };
}

function proxyEnvironmentDocument(environment) {
  return `${JSON.stringify({ schema_version: 1, environment }, null, 2)}\n`;
}

function proxyEnvironmentMetadata(environment) {
  const names = Object.keys(environment).sort();
  if (!names.length) return { enabled: false, file_name: null, sha256: null, variable_names: [] };
  const document = proxyEnvironmentDocument(environment);
  return {
    enabled: true,
    file_name: PRIVATE_PROXY_ENVIRONMENT_FILE,
    sha256: createHash("sha256").update(document).digest("hex"),
    variable_names: names,
  };
}

function publicAudit(audit) {
  const { idempotency_digest, action_idempotency_digests, private_context: privateContext, private_runtime: privateRuntime, ...value } = audit;
  const additional = privateContext?.additional_instructions;
  const environment = privateContext?.test_environment;
  return {
    ...value,
    task_context: {
      api_inventory_length: Number(privateContext?.api_inventory?.character_length ?? 0),
      additional_instructions_enabled: additional?.enabled === true,
      additional_instructions_length: Number(additional?.character_length ?? 0),
      test_environment_enabled: environment?.enabled === true,
      test_environment_length: Number(environment?.character_length ?? 0),
      dynamic_validation_enabled: audit.runtime_testing ? Boolean(audit.runtime_testing_state && !["SKIPPED", "BLOCKED"].includes(audit.runtime_testing_state.status) && environment?.enabled) : audit.task_protocol !== TASK_BOARD_PROTOCOL && environment?.enabled === true,
    },
    task_board: audit.task_protocol === TASK_BOARD_PROTOCOL ? audit.todo_summary ?? null : null,
    todo: audit.todo_summary ?? {
      total: 0,
      pending: 0,
      running: 0,
      done: 0,
      gap: 0,
      failed: 0,
      progress: 0,
      complete: false,
    },
  };
}

function controlledChild(root, candidate) {
  const value = relative(resolve(root), resolve(candidate));
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function controlledPathInfo(root, candidate) {
  if (!controlledChild(root, candidate)) throw new Error(`拒绝删除受控根目录之外的路径：${candidate}`);
  const absoluteRoot = resolve(root);
  const parts = relative(absoluteRoot, resolve(candidate)).split(sep);
  let current = absoluteRoot;
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) current = join(current, parts[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw Object.assign(new Error(`拒绝删除包含目录链接的路径：${current}`), { statusCode: 409, code: "audit-delete-path-symlink" });
      if (index < parts.length - 1 && !info.isDirectory()) throw Object.assign(new Error(`受控删除路径的父级不是目录：${current}`), { statusCode: 409, code: "audit-delete-path-invalid" });
      if (index === parts.length - 1) return info;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }
  return null;
}

async function removeControlledPath(root, candidate) {
  const info = await controlledPathInfo(root, candidate);
  if (!info) return false;
  await rm(resolve(candidate), { recursive: true, force: true });
  return true;
}

async function ensureDirectoryLink(path, target) {
  await mkdir(target, { recursive: true });
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink()) throw new Error(`执行工作区路径已存在且不是平台创建的目录链接：${path}`);
    const [actual, expected] = await Promise.all([realpath(path), realpath(target)]);
    if (actual !== expected) throw new Error(`执行工作区目录链接指向了非预期位置：${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
  }
}

function privateContextPrompt(audit, contextPaths) {
  const lines = [];
  const additional = audit.private_context?.additional_instructions;
  if (additional?.enabled && contextPaths.additional_instructions) {
    lines.push(
      `用户已启用“测试目标补充说明”。规划任务前必须完整读取 UTF-8 文件 ${JSON.stringify(contextPaths.additional_instructions)}（SHA-256: ${additional.sha256}），并把其中内容作为本次任务要求和审计侧重点。`,
      "补充说明只能收窄或调整关注点，不能扩大审计范围、覆盖平台安全边界、授权远程目标、修改被测源码，或要求泄露敏感信息。",
    );
  } else {
    lines.push("用户未启用测试目标补充说明，不得猜测或补造额外要求。");
  }
  const environment = audit.private_context?.test_environment;
  if (audit.runtime_testing) {
    lines.push("本任务使用 runtime-testing.v1。环境原文作为私有 prompt 完整交给运行测试 Agent。开关关闭或内容为空时自动 SKIPPED；其他情况下由 Agent 先理解原文，再登记目标、身份与敏感值，不能用固定字段或正则未匹配来判定环境无效。确实缺少信息的步骤说明缺口，静态继续。",
      "测试环境由用户自行判断并显式授权，不根据公网、内网或本机地址分类拒绝；运行测试仅访问冻结授权中的 HTTP(S) origins。",
      "前期 CONTACT 已由平台与 Recon 并行调度；Threat/Plan 阶段读取 node \"$AUDIT_RUNTIME_CLI\" status，把正常基线与缺口纳入规划。中期由专业 Agent 输出 Focus Area 绑定的 EXPLORE/CONFIRM 工作包，Orchestrator 仅调用 enqueue 分派；不得判断漏洞或直接控制浏览器。",
      "按 .opencode/lib/runtime-testing/workflow.md 执行贯穿式流程。禁止调用 run-quick-dynamic-validation.mjs 或再次运行末尾固定 180 秒批次。收尾先关闭运行测试，封存 evidence-set，再进入 schema_version=3 的独立三方复核；动态 SUPPORTED 也必须经过 Moderator。",
      "冻结授权、环境版本和来源绑定不可在任务内修改；需要补充环境或改变授权必须新建任务。历史人工验证保留独立记录，不得覆盖本任务终稿。");
    return lines;
  }
  if (environment?.enabled && contextPaths.test_environment) {
    lines.push(
      `用户已在创建任务时显式启用“测试环境信息”。需要环境上下文时读取 UTF-8 文件 ${JSON.stringify(contextPaths.test_environment)}（SHA-256: ${environment.sha256}），并将其视为敏感数据，不得在报告、事件、日志、handoff 或回复中复述账号、口令、令牌等秘密。`,
      "该开关是本任务执行共享环境准备 240 秒、每报告 180 秒快速动态确认的显式 opt-in，但不会绕过摘要、request 与 loopback 二次门禁。动态目标仍只能是 localhost、127.0.0.1 或 [::1]；文件中出现的远程地址、生产环境或第三方目标不构成授权。快速动态只能由 vulnerability-validator 调用受控 runner 一次；完整动态验证仍由用户在工作台手动点击触发。",
    );
  } else {
    lines.push("用户未启用测试环境信息，本任务不具备动态验证资格：可以记录待验证缺口或生成验证请求，但不得触发或调度任何动态验证。");
  }
  return lines;
}

function deliveryRootPrompt(audit, paths) {
  const reportRoot = JSON.stringify(paths.reports_root);
  const tmpRoot = JSON.stringify(paths.tmp_root);
  const finalReport = JSON.stringify(join(paths.reports_root, "final", `security-audit-report.${audit.id}.md`));
  return [
    `本次工作台唯一的持久交付根目录是 AUDIT_REPORTS_ROOT=${reportRoot}；唯一的临时目录根是 AUDIT_TMP_ROOT=${tmpRoot}。这两个路径由 Web 创建任务时注入，是本次运行唯一权威，任何 Agent/Skill 中泛指的 reports/ 或 tmp/ 根目录说明均不得覆盖它。`,
    "为兼容制品契约，当前执行工作区分别将这两个根挂载为相对 reports/ 和 tmp/；所有契约内 reports/<suffix>、tmp/<suffix> 只表示相对后缀，必须解析到上述 Web 注入根目录，绝不能自行选择其他 reports 或 tmp 根。",
    `最终中文 Markdown 的唯一目标为 ${finalReport}（执行工作区相对路径 reports/final/security-audit-report.${audit.id}.md）。不得写入被审计源码目录，也不得使用 Agent 文档中旧的根目录假设。`,
  ];
}

function auditPrompt(audit, repository, paths, contextPaths = {}) {
  if (audit.task_protocol === TASK_BOARD_PROTOCOL) return taskBoardPrompt(audit, paths, contextPaths);
  const sourceRoot = JSON.stringify(repository.path);
  const workspaceRoot = JSON.stringify(paths.workspace_root);
  const gitHint = audit.source_kind === "directory"
    ? "该对象不以 Git 为前提；不得把 Git 元数据、分支或提交当作范围条件。范围边界以任务启动前生成的 source-baseline.<audit_id>.json 及其摘要为准。"
    : "如需读取 Git 信息，必须显式使用 git -C \"$AUDIT_SOURCE_ROOT\"。";
  return [
    `@security-audit-orchestrator 对指定源码根目录执行一次完整的源码级 Tri-Lens 安全审计。`,
    `本次 audit_id 固定为 ${audit.id}，${auditSourceReference(audit)}。`,
    `唯一被审计源码根目录是 ${sourceRoot}；当前 OpenCode 目录 ${workspaceRoot} 只是工作台执行工作区，不属于审计范围。`,
    `源码根目录必须只读：不得在其中创建或修改 reports、tmp、配置、缓存或任何其他文件。读取源码及调用扫描器时必须显式使用 AUDIT_SOURCE_ROOT 的绝对路径（例如 --root \"$AUDIT_SOURCE_ROOT\"），不得用当前执行目录替代冻结范围根。${gitHint}`,
    ...deliveryRootPrompt(audit, paths),
    knowledgeContextPrompt(),
    bacContextPrompt(audit),
    "每次专业 Agent 提交工作包后，先运行 audit-todo check --todo <本地清单> --packet <packet_id> --handoff <交付件> --reports-root <受控报告根>。watchdog 会核对分派集合并在工具结果中提醒遗漏/无效项；补齐后再 complete。特殊跳过必须逐项提交 status=GAP、gap_kind=SKIPPED 和非空 gap_reason，保留至最终中文报告，不计为 DONE。",
    `本次调度唯一真相是本机文件 ${JSON.stringify(paths.todo_path)}，只能由 Orchestrator 使用 node \"$AUDIT_TODO_CLI\" 管理；严禁使用 OpenCode todolist；子代理仅可通过 audit-todo check 只读核对自己的工作包，不得读取完整清单到上下文或修改该文件。Coverage Ledger MCP、哈希链、token、INSPECT/RECEIPT/DECISION 流程均已废弃。`,
    "完成 Scope、Recon 与 Threat 后，使用 build-coverage-plan.mjs --recon-dir \"$AUDIT_TMP_ROOT/recon\" 构建 Coverage Plan；不得调用 snapshot-coverage-inputs.mjs、复制输入或在命令行列举语言清单。随后调用 audit-todo init 创建本地审计项；每项为一个 Focus Area × domain，三个 lens 在同一工作包内完成。然后循环调用 audit-todo claim（最多 4 个工作包、每包最多 12 项），只把返回的有限工作包分派给对应专业 Agent。不得把完整 Focus Area 清单写入 OpenCode task 或上下文。",
    "专业 Agent 只写报告和一个工作包 handoff JSON 到 reports/audit-todo/<audit_id>/；handoff 必须逐项标明 DONE 或 GAP、三视角 reports 数组（lens/path/sha256）或 gap_reason。Orchestrator 通过 audit-todo check 校验三视角绑定、摘要及同一真实 session，再调用 audit-todo complete；子代理失败时调用 audit-todo fail，过期 RUNNING 项调用 audit-todo recover 后重新领取。Orchestrator 不得阅读源码、判断漏洞或改写 Finding。",
    "每次 claim/complete/recover 后立刻运行 audit-todo stats，并只以 stats.next_action 决定下一步：CLAIM 才继续领取；RECOVER_OR_WAIT 才处理运行租约；REPAIR_FAILURES 才处理失败。FINALIZE 或 FINALIZE_WITH_RESIDUAL_GAPS 表示所有本地审计项均已终态，必须停止所有领取、等待和 GAP 重试循环，转入关联、裁决、验证与报告收尾。DONE 数小于 total 并不表示还有任务：GAP 是已记录的终态；FINALIZE_WITH_RESIDUAL_GAPS 必须保留 GAP 并输出部分覆盖/残余缺口报告，不能等待用户或 operation timeout。",
    ...privateContextPrompt(audit, contextPaths),
    "完成可信结构、威胁建模、多视角漏洞挖掘、证据关联、发现裁决和最终中文报告封存；不能完成的分析必须作为残余 GAP 记录，不能无限续跑。",
    audit.runtime_testing
      ? "八个工作台环节的展示制品缺失、PARTIAL 或 GAP 只记残余缺口，不能重开终态任务或等待用户。完成门禁要求本地任务清单所有项为 DONE/GAP、最终中文 Markdown 存在，并且 schema_version=3 报告模型通过运行证据及独立三方复核绑定校验。动态 SKIPPED 不阻塞静态收尾，但仍须封存跳过原因。不得调用旧 Coverage Ledger 的 stage-delivery / coverage-finalize 门禁。"
      : "八个工作台环节的制品只供 Web 展示和报告引用，不是完成门禁：缺失、PARTIAL 或 GAP 只能写入残余缺口，绝不能新建嵌套工作、重开终态本地任务、等待用户或触发 operation timeout。唯一完成门禁是本地任务清单所有项为 DONE/GAP，且最终中文 Markdown 报告存在。不得调用或等待旧 Coverage Ledger 相关的 stage-delivery / coverage-finalize 门禁。",
    audit.runtime_testing ? "初步裁决后委派 vulnerability-validator，使用贯穿式运行证据和独立三方复核。最终报告只能消费完整 schema_version=3 validation-routing manifest。" : "初步裁决后必须委派 vulnerability-validator，执行旧版 quick 与静态三方协议；最终报告只能消费完整 validation-routing manifest。",
    audit.runtime_testing ? "贯穿式任务不启动旧版 quick runner，人工补充验证不得自动改写终稿。" : "Orchestrator 不得直接控制浏览器或绕过受控 quick runner。完整动态验证仍只允许用户在工作台手动点击触发，且不得自动改写 routing 或终稿。",
    "这是无人值守的工作台任务：不得调用 question 工具、打开交互式选项或等待用户输入。需授权或缺少环境的可选后续只能作为待办写入最终中文说明。每次收尾必须运行 audit-todo recover 和 stats；当 next_action 为 FINALIZE 或 FINALIZE_WITH_RESIDUAL_GAPS 时，生成/核验最终报告后立刻结束本次 OpenCode run，不得输出“继续”“等待”“下一步”或请求澄清，也不得创建新的嵌套步骤。",
  ].join("\n");
}

function knowledgeContextPrompt() {
  return "知识库只读入口为 node \"$AUDIT_KNOWLEDGE_CLI\"，使用方式见 .opencode/lib/knowledge-workflow.md。Orchestrator 只向 Threat/Coverage/Seeded Variant 专业 Agent 传递入口和轨道，不自行检索或判断漏洞。专业 Agent 先按当前信任边界检索根因，再按需读取关联案例与检测器，保留来源摘要、成立前提、反例和质量状态；blind 轨道不查询、不接收知识种子。知识库不可用、陈旧或无匹配只记检索缺口，继续源码审计，不替代当前项目证据或覆盖目录。";
}

function bacContextPrompt(audit) {
  return audit.bac_analysis?.mode === "auto"
    ? "本任务已启用 bac-analysis.v1 越权专项，读取 .opencode/lib/bac/workflow.md。Recon 复用冻结入口，Orchestrator 在专业包执行前调度独立 ACP 策略会话；源码 Agent 提取实际路径并调用 AUDIT_BAC_CLI。control-driven 报告必须有专项附件或显式 GAP/有据不适用；原始候选经 Finding v2 与原三方复核。此开关不授权任何动态请求。"
    : "本任务未启用越权专项差分；保留原有权限审计。历史任务不追加专项交付要求。";
}

function recoveryPrompt(audit, repository, paths, contextPaths = {}) {
  if (audit.task_protocol === TASK_BOARD_PROTOCOL) return taskBoardPrompt(audit, paths, contextPaths, true);
  const sourceRoot = JSON.stringify(repository.path);
  const workspaceRoot = JSON.stringify(paths.workspace_root);
  return [
    `@security-audit-orchestrator 继续执行此前中断的源码级 Tri-Lens 安全审计。`,
    `这是同一任务 ${audit.id} 的第 ${Number(audit.recovery_count ?? 0)} 次断点恢复，${auditSourceReference(audit)}；不得生成新的 audit_id。`,
    `唯一被审计源码根目录仍是 ${sourceRoot}；当前 OpenCode 目录 ${workspaceRoot} 只是工作台执行工作区，不属于审计范围。`,
    `先检查 Web 注入的交付目录、临时目录以及本机本地任务清单 ${JSON.stringify(paths.todo_path)}；运行 node \"$AUDIT_TODO_CLI\" recover 和 stats，复用已有 DONE/GAP 项，只领取 PENDING 项。不得删除有效制品，也不要无条件重跑已完成工作包。若 stats.next_action 为 FINALIZE 或 FINALIZE_WITH_RESIDUAL_GAPS，所有本地审计项都已经终态：不得再等待、重领或重跑 GAP，而是立即从后续交付制品继续收尾；后者须将 GAP 保留为残余缺口并输出部分覆盖报告。`,
    "优先复用已有阶段制品、最终报告和本地清单中的 DONE/GAP 状态；只恢复 PENDING 或过期 RUNNING 工作包。阶段制品的缺失、PARTIAL 或 GAP 仅作为 Web 展示和最终报告残余缺口，不能重开终态任务、生成嵌套任务或让运行保持等待。不得因缺失旧 Coverage Ledger 的 stage-delivery / coverage-finalize 制品而重跑已完成工作包。",
    "会话中的历史说明只能作为线索，阶段完成性必须以当前落盘制品及确定性校验结果为准；若发现半写入、摘要不匹配或前后不一致的制品，应重建对应制品后再继续。",
    "源码根目录必须只读：不得在其中创建或修改 reports、tmp、配置、缓存或任何其他文件。读取源码、Git 信息及调用扫描器时必须显式使用 AUDIT_SOURCE_ROOT 的绝对路径，不得用当前执行目录替代冻结范围根。",
    ...deliveryRootPrompt(audit, paths),
    knowledgeContextPrompt(),
    bacContextPrompt(audit),
    "本地任务清单只由 Orchestrator 调度：继续以最多 4 个工作包、每包最多 12 项的界限领取和分派；不得使用 OpenCode todolist、Coverage Ledger MCP、哈希链或逐漏洞记账。子代理生成工作包 handoff 并运行只读 audit-todo check；watchdog 提醒遗漏项。特殊跳过逐项记录 GAP / gap_kind=SKIPPED 和中文原因，Orchestrator 完成结构校验后更新本地任务状态。",
    ...privateContextPrompt(audit, contextPaths),
    audit.runtime_testing ? "复用已封存的运行证据，从最早缺失的三方复核继续。恢复时环境状态不明会被隔离，禁止重新接触目标；保留动态缺口并完成静态报告。" : "继续完成真实性 routing、CVSS、攻击链和最终报告。校验已存在的 quick/Affirmative/Negative/Moderator 制品，从最早缺失步骤恢复。完整动态验证仅人工触发。",
    "这是无人值守的断点恢复：不得调用 question 工具、打开交互式选项或等待用户输入。需授权或缺少环境的可选后续只能作为待办写入最终中文说明。每次收尾必须运行 audit-todo recover 和 stats；当 next_action 为 FINALIZE 或 FINALIZE_WITH_RESIDUAL_GAPS 时，生成/核验最终报告后立刻结束本次 OpenCode run，不得输出“继续”“等待”“下一步”或请求澄清，也不得创建新的嵌套步骤。",
  ].join("\n");
}

function selectTaskProtocol(input) {
  const protocol = input.task_protocol ?? TASK_BOARD_PROTOCOL;
  if (![TASK_BOARD_PROTOCOL, "local-todo.v1"].includes(protocol)) throw Object.assign(new Error("审计任务协议不受支持。"), { statusCode: 422 });
  if (protocol !== TASK_BOARD_PROTOCOL && input.api_inventory?.trim()) throw Object.assign(new Error("API 清单需要通用任务面板协议。"), { statusCode: 422 });
  if (protocol !== TASK_BOARD_PROTOCOL && input.mining_strategy != null) throw Object.assign(new Error("漏洞挖掘策略切换需要通用任务面板协议。"), { statusCode: 422 });
  return protocol;
}

function taskBoardPrompt(audit, paths, contextPaths, resume = false) {
  const strategyPrompt = audit.mining_strategy === "api"
    ? "本次漏洞挖掘策略为 api：仅对导入的 API 清单逐项初步分析、定位代码并发布 API 审查任务，不生成 Focus Area 任务。不得按风险高低省略 API；接口实现需要的下游代码仍须追踪。"
    : audit.mining_strategy === "focus_area"
      ? "本次漏洞挖掘策略为 focus_area：仅提炼并发布高风险 Focus Area 任务，不生成逐接口 API 审查任务。"
      : "本任务使用切换策略引入前的面板：保留高风险 Focus Area 与已导入 API 的并列规划，恢复时沿用既有范围。";
  return [
    `@security-audit-orchestrator ${resume ? "恢复" : "执行"}通用任务面板审计，audit_id=${audit.id}，协议 task-board.v1。`,
    `源码根 ${JSON.stringify(paths.source_root)} 只读；执行工作区 ${JSON.stringify(paths.workspace_root)} 不属于被审计范围。`,
    ...deliveryRootPrompt(audit, paths),
    "首先完整读取 .opencode/lib/task-board/workflow.md，按本协议执行；旧 Focus Area 全量分区、三视角分文件、audit-todo 和旧最终报告门禁均不适用。",
    strategyPrompt,
    "将本次策略传给威胁建模 Agent，要求使用 status 核对并按选定粒度规划。使用 AUDIT_TASK_BOARD_CLI 分批发布；monitor 自动按领域执行，每 worker 一次一个任务，收报告后继续下一项。不要自己再调用挖掘 Agent。",
    "发布完成后 seal；报告接收只检查任务绑定和完整写入。收齐后必须 review-input，委派后续报告质量复核及独立三方候选验证，执行 review/finalize 生成最终中文报告。",
    resume ? "先查询 status，复用已经接收的报告和复核。SEALED 不重复发布；旧 RUNNING 由 monitor 回收，不重跑已交付任务。" : "面板已经创建；先查询 status 与分页 API 清单，不要把全量任务放进一次模型上下文。",
    contextPaths.additional_instructions ? `完整读取用户补充说明 ${JSON.stringify(contextPaths.additional_instructions)}，仅在既定审计范围内应用。` : "用户未提供额外审计要求。",
    audit.bac_analysis?.mode === "auto" ? "越权专项已启用：任务分析与后续质量复核须保留预期策略、实际路径和差分证据；缺少条件时明确保留专项缺口。" : "越权专项未启用。",
    audit.runtime_testing ? "运行测试继续使用已冻结的 runtime-testing.v1 授权。CONTACT 已由平台控制器调度；静态 worker 仅提供运行假设，Orchestrator 按授权分派。开关关闭或环境为空时自动 SKIPPED。先封存运行证据再 review-input；本任务使用面板复核协议，所有源码/运行候选均经独立三方，不能使用旧 quick 或旧报告构建器。" : "未选择运行测试协议；动态验证为 SKIPPED，禁止自行启动浏览器或联系目标。",
    knowledgeContextPrompt(),
    "不要等待用户输入。失败原因逐项保留；执行失败达到重试上限后可使用 skip 显式登记缺口。若任务非空但收到报告数为 0，明确说明审计执行未完成；finalize 只封存执行失败记录，不能声称审计成功或未发现漏洞。返回中文报告路径并结束。",
  ].join("\n");
}

function providerSessionId(value) {
  return typeof value === "string" && value.length >= 3 && value.length <= 240 && /^[A-Za-z0-9._:-]+$/.test(value) ? value : null;
}

export class AuditRunner extends EventEmitter {
  constructor({ stateRoot, platformRoot = null, repositories = [], configPath = null, enabled = false, command = "opencode", environment = process.env, spawnProcess = spawn, compactSessionRunner = null, terminalMonitor = null, modelResolver = null, stageDeliveryVerifier = defaultStageDeliveryVerifier, todoCompletionVerifier = defaultTodoCompletionVerifier, completionWatchdogIntervalMs = COMPLETION_WATCHDOG_INTERVAL_MS, operationTimeoutTerminationGraceMs = OPERATION_TIMEOUT_TERMINATION_GRACE_MS } = {}) {
    super();
    this.stateRoot = resolve(stateRoot);
    this.runtimeTestingServices = new Map();
    this.taskBoardServices = new Map();
    this.configPath = configPath ? resolve(configPath) : null;
    this.platformRoot = resolve(platformRoot ?? (this.configPath ? resolve(dirname(this.configPath), "..") : process.cwd()));
    this.artifactsRoot = join(this.platformRoot, "reports", "repositories");
    this.temporaryRoot = join(this.platformRoot, "tmp", "repositories");
    this.executionRoot = join(this.platformRoot, "workspace", "audit-runs");
    this.repositoryRegistryPath = join(this.stateRoot, "repositories.json");
    this.repositoryFactsCache = new Map();
    this.startupRepositoryIds = new Set(repositories.map(repository => repository.id));
    this.repositories = new Map(repositories.map(repository => {
      const normalized = normalizeRepository(repository, this.configPath);
      return [normalized.id, normalized];
    }));
    this.enabled = enabled;
    this.command = command;
    this.environment = environment;
    this.spawnProcess = spawnProcess;
    this.compactSessionRunner = compactSessionRunner ?? ((command, args, options) => execFileAsync(command, args, options));
    this.stageDeliveryVerifier = stageDeliveryVerifier;
    this.todoCompletionVerifier = todoCompletionVerifier;
    this.terminalMonitor = terminalMonitor ?? new OpenCodeTmuxMonitor({ stateRoot: this.stateRoot, command: this.command, environment: this.environment });
    this.audits = new Map();
    this.processes = new Map();
    this.completions = new Map();
    this.subscribers = new Map();
    this.writeQueues = new Map();
    this.contextRedactions = new Map();
    this.queueScheduler = null;
    this.eventLogReader = new EventLogReader();
    this.modelResolver = null;
    this.targetOperationGuard = null;
    this.setModelResolver(modelResolver);
    this.dispatching = new Set();
    this.completionWatchdogIntervalMs = Number.isFinite(Number(completionWatchdogIntervalMs))
      ? Math.max(1_000, Number(completionWatchdogIntervalMs))
      : COMPLETION_WATCHDOG_INTERVAL_MS;
    this.completionWatchdogTimer = null;
    this.completionWatchdogRunning = false;
    this.timeoutRecoveryPending = new Set();
    this.timeoutRecoveryTimers = new Map();
    this.timeoutTerminationGraceMs = Number.isFinite(Number(operationTimeoutTerminationGraceMs))
      ? Math.max(100, Number(operationTimeoutTerminationGraceMs))
      : OPERATION_TIMEOUT_TERMINATION_GRACE_MS;
    this.timeoutTerminationTimers = new Map();
    this.contextRecoveryPending = new Set();
    this.contextRecoveryTimers = new Map();
    this.contextTerminationTimers = new Map();
    this.ready = this.initialize();
  }

  enqueue(id, operation) {
    const prior = this.writeQueues.get(id) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    this.writeQueues.set(id, next);
    next.finally(() => { if (this.writeQueues.get(id) === next) this.writeQueues.delete(id); }).catch(() => {});
    return next;
  }

  async initialize() {
    await mkdir(this.stateRoot, { recursive: true });
    if (this.configPath) {
      try { this.configPath = await realpath(this.configPath); } catch {}
    }
    for (const repository of this.repositories.values()) {
      try { repository.path = await realpath(repository.path); } catch {}
      if (this.configPath) repository.config_path = this.configPath;
    }
    try {
      const registry = JSON.parse(await readFile(this.repositoryRegistryPath, "utf8"));
      for (const repository of repositoryRegistryEntries(registry)) {
        const normalized = normalizeRepository(repository, this.configPath);
        try { normalized.path = await realpath(normalized.path); } catch {}
        if (!this.repositories.has(normalized.id) && ![...this.repositories.values()].some(existing => existing.path === normalized.path)) this.repositories.set(normalized.id, normalized);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`审计项目注册表无效：${error.message}`);
    }
    await this.persistRepositories();
    const entries = await readdir(this.stateRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const audit = JSON.parse(await readFile(join(this.stateRoot, entry.name, "run.json"), "utf8"));
        audit.todo_path ??= join(this.stateRoot, audit.id, "audit-todo.json");
        audit.todo_summary = await this.taskSummary(audit);
        this.audits.set(audit.id, audit);
        if (audit.status === "queued") {
          audit.queue ??= { mode: "start", enqueued_at: audit.updated_at ?? audit.created_at ?? new Date().toISOString() };
          await this.persist(audit);
        } else if (ACTIVE.has(audit.status)) {
          const previousStatus = audit.status;
          let terminalLive = false;
          if (audit.terminal?.supported && audit.terminal?.socket_name && audit.terminal?.target && typeof this.terminalMonitor.targetLive === "function") {
            terminalLive = await this.terminalMonitor.targetLive(audit.terminal.socket_name, audit.terminal.target).catch(() => false);
          }
          audit.status = "interrupted";
          audit.pid = null;
          audit.finished_at = new Date().toISOString();
          audit.interrupted_at = audit.finished_at;
          audit.interruption_reason = "workbench-restarted";
          audit.error = terminalLive
            ? "工作台服务已重启；原隔离 OpenCode 窗口仍可查看。请使用断点恢复重新接管任务。"
            : "工作台服务已重启，原 Runner 连接已中断。请使用断点恢复继续任务。";
          if (audit.terminal) {
            audit.terminal.live = terminalLive;
            audit.terminal.status = terminalLive ? "disconnected" : "closed";
            audit.terminal.message = audit.error;
          }
          await this.record(audit, "audit.interrupted", { reason: audit.interruption_reason, previous_status: previousStatus, terminal_live: terminalLive });
        }
      } catch {
        // Ignore incomplete state directories; they remain available for operator inspection.
      }
    }
    await this.reconcileFinalReportArtifacts("startup-watchdog");
    await this.reconcileTerminalCompletions("startup-watchdog");
    this.startCompletionWatchdog();
  }

  reportsRootForAudit(audit) {
    const repository = this.repositoryForAudit(audit);
    if (!repository) return null;
    return join(this.artifactsRoot, repository.storage_namespace ?? repository.id);
  }

  repositoryForAudit(audit) {
    return targetRepositoryFromAudit(audit, this.configPath) ?? this.repositories.get(audit?.repository_id) ?? null;
  }

  managedRepositories() {
    const repositories = new Map(this.repositories);
    for (const audit of this.audits.values()) {
      const repository = targetRepositoryFromAudit(audit, this.configPath);
      if (repository) repositories.set(repository.id, repository);
    }
    return [...repositories.values()];
  }

  async verifyTodoCompletion(audit) {
    const reportsRoot = this.reportsRootForAudit(audit);
    if (!reportsRoot) throw new Error("审计缺少受控报告目录绑定。");
    const verification = await this.todoCompletionVerifier({ audit, reportsRoot });
    audit.todo_summary = verification.summary ?? await this.taskSummary(audit);
    audit.todo_completion = {
      complete: verification.complete === true,
      ...(verification.delivery_outcome ? { delivery_outcome: verification.delivery_outcome } : {}),
      errors: (verification.errors ?? []).slice(0, 100),
      final_report_path: verification.final_report_path ?? null,
      final_report_materialized: verification.final_report_materialized === true,
      verified_at: new Date().toISOString(),
    };
    return verification;
  }

  async completeVerifiedAudit(audit, { reason, completionSource, data = {}, terminateRunner = false }) {
    await this.stopTaskBoard(audit);
    await this.stopRuntimeTesting(audit);
    const child = terminateRunner ? this.processes.get(audit.id) : null;
    audit.status = hasNoTaskReports(audit) ? "failed" : "completed";
    audit.pid = null;
    audit.exit_code ??= 0;
    audit.finished_at ??= new Date().toISOString();
    audit.interrupted_at = null;
    audit.interruption_reason = null;
    audit.error = hasNoTaskReports(audit) ? NO_TASK_REPORTS_MESSAGE : null;
    audit.completion_source = completionSource;
    await this.record(audit, `audit.${audit.status}`, {
      reason,
      completion_source: completionSource,
      runner_termination_requested: Boolean(child),
      ...data,
    });
    if (audit.terminal?.live) {
      await this.terminalMonitor.abort(audit.terminal, audit.paths?.workspace_root).catch(() => {});
      if (!child) {
        await this.finalizeTerminal(audit).catch(() => {
          audit.terminal = { ...(audit.terminal ?? {}), live: false, status: "closed", message: "审计已由完成性校验收敛，终端归档失败。" };
        });
      }
    }
    if (child && !child.kill("SIGTERM")) {
      await this.recordLog(audit, "stderr", "完成性 watchdog 已确认交付完成，但未能向 Runner 发送结束信号。");
    }
    return true;
  }

  async reconcileManagedCompletion(audit, reason = "watchdog", { allowRunning = false } = {}) {
    if (!audit || audit.status === "completed" || this.completions.has(audit.id)) return false;
    if (audit.status === "failed" && hasNoTaskReports(audit)) return false;
    const running = allowRunning && audit.status === "running" && this.processes.has(audit.id);
    if (this.processes.has(audit.id) && !running) return false;
    if (!RECOVERABLE.has(audit.status) && !running) return false;
    if (audit.stage_delivery_enforcement === "TODO_ENFORCED") {
      try {
        const verification = await this.verifyTodoCompletion(audit);
        if (!verification.complete) return false;
        return this.completeVerifiedAudit(audit, {
          reason,
          completionSource: running ? "todo-artifact-watchdog" : "todo-artifact-verification",
          terminateRunner: running,
          data: { final_report_path: audit.todo_completion.final_report_path, report_materialized: audit.todo_completion.final_report_materialized },
        });
      } catch {
        return false;
      }
    }
    if (audit.stage_delivery_enforcement === "ENFORCED") {
      const reportsRoot = this.reportsRootForAudit(audit);
      if (!reportsRoot) return false;
      try {
        const verification = await this.stageDeliveryVerifier({ reportsRoot, auditId: audit.id });
        audit.stage_delivery = {
          enforcement: verification.enforcement ?? "ENFORCED",
          complete: verification.complete === true,
          completed_count: Number(verification.completed_count ?? 0),
          stages: verification.stages ?? [],
          errors: (verification.errors ?? []).slice(0, 100),
          verified_at: new Date().toISOString(),
        };
        if (!verification.complete) return false;
        return this.completeVerifiedAudit(audit, {
          reason,
          completionSource: "stage-delivery-verification",
          data: { completed_count: audit.stage_delivery.completed_count },
        });
      } catch {
        return false;
      }
    }
    return false;
  }

  startCompletionWatchdog() {
    if (!this.enabled || this.completionWatchdogTimer) return;
    this.completionWatchdogTimer = setInterval(() => {
      this.runCompletionWatchdog().catch(() => {});
    }, this.completionWatchdogIntervalMs);
    this.completionWatchdogTimer.unref?.();
  }

  async runCompletionWatchdog(reason = "active-run-watchdog") {
    if (this.completionWatchdogRunning) return 0;
    this.completionWatchdogRunning = true;
    try {
      await this.reconcileFinalReportArtifacts(reason);
      let completed = 0;
      for (const audit of this.audits.values()) {
        if (audit.status !== "running" || !this.processes.has(audit.id)) continue;
        await this.remindIncompleteFocusAreas(audit);
        if (await this.reconcileManagedCompletion(audit, reason, { allowRunning: true })) completed += 1;
      }
      return completed;
    } finally {
      this.completionWatchdogRunning = false;
    }
  }

  async remindIncompleteFocusAreas(audit) {
    if (audit.task_protocol === TASK_BOARD_PROTOCOL) return;
    if (audit.stage_delivery_enforcement !== "TODO_ENFORCED") return;
    const reportsRoot = this.reportsRootForAudit(audit);
    if (!reportsRoot) return;
    let check;
    try { check = await inspectFocusAreaCoverage({ todoPath: audit.todo_path, reportsRoot }); }
    catch { check = { initialized: true, complete: false, outstanding: [], exceptions: [], issues: ["覆盖检查 UNAVAILABLE：任务清单无法读取或校验，不能声明全部覆盖。"], fingerprint: "UNAVAILABLE" }; }
    if (!check.initialized || audit.focus_area_watchdog?.fingerprint === check.fingerprint) return;
    const reminder = formatFocusAreaReminder(check);
    audit.focus_area_watchdog = { fingerprint: check.fingerprint, complete: check.complete, outstanding_count: check.outstanding.length,
      skipped_count: check.exceptions.filter(item => item.status === "SKIPPED").length, reminder, checked_at: new Date().toISOString() };
    const path = join(this.stateRoot, audit.id, "focus-area-coverage.json");
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(check, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    await this.record(audit, reminder ? "audit.focus-area.reminder" : "audit.focus-area.accounted", audit.focus_area_watchdog);
    if (reminder) await this.recordLog(audit, "stderr", reminder);
  }

  async reconcileLegacyCompletion(audit, reason = "watchdog") {
    if (!audit || ["ENFORCED", "TODO_ENFORCED"].includes(audit.stage_delivery_enforcement) || audit.status === "completed") return false;
    if (this.processes.has(audit.id) || this.completions.has(audit.id) || !audit.paths?.reports_root) return false;
    let inferred;
    try {
      const artifacts = (await scanReportArtifacts(audit.paths.reports_root)).filter(artifact => artifact.audit_id === audit.id);
      inferred = auditsFromArtifacts(artifacts, [], [audit], new Map()).find(item => item.id === audit.id);
    } catch {
      return false;
    }
    if (inferred?.progress !== 100 || inferred.progress_source !== "legacy-artifact-heuristic") return false;
    return this.completeVerifiedAudit(audit, {
      reason,
      completionSource: "legacy-artifact-heuristic",
      data: { progress: 100 },
    });
  }

  async reconcileFinalReportArtifacts(reason = "watchdog") {
    let repaired = 0;
    for (const audit of this.audits.values()) {
      const reportsRoot = this.reportsRootForAudit(audit);
      if (!reportsRoot) continue;
      try {
        const result = await materializeFinalReportFromModel({ reportsRoot, auditId: audit.id });
        if (!result.materialized) continue;
        audit.final_report = { path: result.artifact.path, repaired_at: new Date().toISOString(), model_path: result.model_path };
        await this.record(audit, "audit.report.materialized", { reason, path: result.artifact.path, model_path: result.model_path });
        repaired += 1;
      } catch {
        // Artifact repair is best effort; completion verification will expose a real missing report.
      }
    }
    return repaired;
  }

  async reconcileTerminalCompletion(audit, reason = "watchdog") {
    if (await this.reconcileManagedCompletion(audit, reason)) return true;
    return this.reconcileLegacyCompletion(audit, reason);
  }

  async reconcileTerminalCompletions(reason = "watchdog") {
    let completed = 0;
    for (const audit of this.audits.values()) {
      if (!ACTIVE.has(audit.status) && !RECOVERABLE.has(audit.status)) continue;
      if (await this.reconcileTerminalCompletion(audit, reason)) completed += 1;
    }
    return completed;
  }

  async reconcileLegacyCompletions(reason = "watchdog") {
    return this.reconcileTerminalCompletions(reason);
  }

  async persistRepositories() {
    const temporary = `${this.repositoryRegistryPath}.${process.pid}.${randomUUID()}.tmp`;
    const value = {
      schema_version: 1,
      updated_at: new Date().toISOString(),
      repositories: [...this.repositories.values()].map(repository => ({ id: repository.id, name: repository.name, path: repository.path })),
    };
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.repositoryRegistryPath);
  }

  async addRepository(input, idempotencyKey) {
    await this.ready;
    if (!idempotencyKey || idempotencyKey.length > 200) throw Object.assign(new Error("缺少有效的 Idempotency-Key。"), { statusCode: 400, code: "idempotency-key-required" });
    if (typeof input.path !== "string" || !input.path.trim() || input.path.length > 4096 || !isAbsolute(input.path)) {
      throw Object.assign(new Error("项目目录必须是工作台所在机器上的绝对路径。"), { statusCode: 422, code: "repository-path-invalid" });
    }
    let canonicalPath;
    try {
      canonicalPath = await realpath(input.path.trim());
      const info = await stat(canonicalPath);
      if (!info.isDirectory()) throw new Error("not-directory");
    } catch {
      throw Object.assign(new Error("项目目录不存在、不可读取或不是目录。"), { statusCode: 422, code: "repository-directory-unavailable" });
    }
    if (canonicalPath === parse(canonicalPath).root) {
      throw Object.assign(new Error("不能把文件系统根目录登记为审计项目。"), { statusCode: 422, code: "repository-path-too-broad" });
    }
    const existing = [...this.repositories.values()].find(repository => repository.path === canonicalPath);
    if (existing) return publicRepository(existing, await this.repositoryFacts(existing));
    const repository = normalizeRepository({
      id: `project-${createHash("sha256").update(canonicalPath).digest("hex").slice(0, 12)}`,
      name: typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 120) : basename(canonicalPath),
      path: canonicalPath,
    }, this.configPath);
    this.repositories.set(repository.id, repository);
    await this.persistRepositories();
    return publicRepository(repository, await this.repositoryFacts(repository));
  }

  async removeRepository(repositoryId) {
    await this.ready;
    const repository = this.repositories.get(repositoryId);
    if (!repository) throw Object.assign(new Error("审计项目不存在。"), { statusCode: 404, code: "repository-not-found" });
    if (this.startupRepositoryIds.has(repositoryId)) {
      throw Object.assign(new Error("该项目由工作台启动参数配置，不能在网页中删除。"), { statusCode: 409, code: "repository-startup-managed" });
    }
    const audits = [...this.audits.values()].filter(audit => audit.repository_id === repositoryId);
    if (audits.length) {
      throw Object.assign(new Error("该项目仍有关联审计；请先删除这些审计任务。"), { statusCode: 409, code: "repository-has-audits" });
    }
    this.repositories.delete(repositoryId);
    this.repositoryFactsCache.delete(repositoryId);
    await this.persistRepositories();
    return {
      repository_id: repositoryId,
      deleted: true,
      source_directory_deleted: false,
      artifacts_deleted: false,
    };
  }

  async repositoryFacts(repository) {
    const config = await configFacts(repository.config_path);
    try {
      const [commit, branch, dirty] = await Promise.all([
        git(repository.path, ["rev-parse", "HEAD"]),
        git(repository.path, ["branch", "--show-current"]),
        git(repository.path, ["status", "--porcelain", "--untracked-files=normal"]),
      ]);
      return { ...config, git_repository: true, commit, branch: branch || "DETACHED", dirty: Boolean(dirty) };
    } catch {
      return { ...config, git_repository: false, commit: null, branch: null, dirty: null };
    }
  }

  async listRepositories({ cached = false } = {}) {
    await this.ready;
    const values = [];
    for (const repository of this.repositories.values()) {
      const audits = [...this.audits.values()].filter(audit => audit.repository_id === repository.id).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      let entry = this.repositoryFactsCache.get(repository.id);
      if (!cached || !entry || Date.now() - entry.at >= 10000) {
        entry = { facts: await this.repositoryFacts(repository), at: Date.now() };
        this.repositoryFactsCache.set(repository.id, entry);
      }
      values.push(publicRepository(repository, entry.facts, {
        audit_count: audits.length,
        active_audit_count: audits.filter(audit => ACTIVE.has(audit.status)).length,
        last_audit_at: audits[0]?.updated_at ?? null,
        last_audit_status: audits[0]?.status ?? null,
        removable: !this.startupRepositoryIds.has(repository.id),
      }));
    }
    return values;
  }

  artifactSources() {
    return this.managedRepositories().map(repository => ({
      repository_id: repository.id,
      repository_name: repository.name,
      reports_root: join(this.artifactsRoot, repository.storage_namespace ?? repository.id),
    }));
  }

  async ensureSourceBinding(audit, repository, paths) {
    const directory = join(paths.reports_root, "platform", "audit-runs", audit.id);
    const path = join(directory, "source-binding.json");
    const value = {
      schema_version: 1,
      audit_id: audit.id,
      repository_id: repository.id,
      source_root: repository.path,
      commit: audit.commit,
      branch: audit.branch,
      source_kind: audit.source_kind ?? "git",
      execution_spec_digest: audit.execution_spec_digest ?? null,
      source_baseline: audit.source_baseline ?? null,
      created_at: audit.created_at,
      task_context: {
        ...(audit.task_protocol === TASK_BOARD_PROTOCOL ? {
          task_protocol: audit.task_protocol,
          api_inventory_sha256: audit.private_context?.api_inventory?.sha256 ?? null,
          ...(audit.mining_strategy ? { mining_strategy: audit.mining_strategy } : {}),
        } : {}),
        additional_instructions_enabled: audit.private_context?.additional_instructions?.enabled === true,
        additional_instructions_sha256: audit.private_context?.additional_instructions?.sha256 ?? null,
        quick_dynamic_opt_in: audit.task_protocol !== TASK_BOARD_PROTOCOL && !audit.runtime_testing && audit.private_context?.test_environment?.enabled === true,
        ...(audit.runtime_testing ? { runtime_testing: audit.runtime_testing } : {}),
        ...(audit.bac_analysis ? { bac_analysis: audit.bac_analysis } : {}),
        test_environment_context_sha256: audit.private_context?.test_environment?.sha256 ?? null,
        full_dynamic_trigger: "MANUAL_ONLY",
      },
    };
    value.binding_digest = digestObjectWithout(value, "binding_digest");
    await mkdir(directory, { recursive: true });
    try {
      const existing = JSON.parse(await readFile(path, "utf8"));
      if (existing.binding_digest !== digestObjectWithout(existing, "binding_digest")
        || existing.binding_digest !== value.binding_digest) {
        throw Object.assign(new Error("审计源码绑定已漂移，拒绝在同一 audit_id 下继续。"), { statusCode: 409, code: "audit-source-binding-drift" });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    return path;
  }

  async prepareExecutionWorkspace(audit, repository) {
    const workspaceRoot = join(this.executionRoot, audit.id);
    const storageNamespace = repository.storage_namespace ?? repository.id;
    const reportsRoot = join(this.artifactsRoot, storageNamespace);
    const tmpRoot = join(this.temporaryRoot, storageNamespace);
    await mkdir(workspaceRoot, { recursive: true });
    await Promise.all([
      ensureDirectoryLink(join(workspaceRoot, ".opencode"), dirname(repository.config_path)),
      ensureDirectoryLink(join(workspaceRoot, "reports"), reportsRoot),
      ensureDirectoryLink(join(workspaceRoot, "tmp"), tmpRoot),
    ]);
    const paths = {
      source_root: repository.path,
      workspace_root: workspaceRoot,
      reports_root: reportsRoot,
      tmp_root: tmpRoot,
      todo_path: audit.todo_path ?? join(this.stateRoot, audit.id, "audit-todo.json"),
      todo_handoff_root: join(reportsRoot, "audit-todo", audit.id),
    };
    await this.ensureSourceBaseline(audit, repository, paths);
    paths.source_binding = await this.ensureSourceBinding(audit, repository, paths);
    await writeFile(join(workspaceRoot, "audit-workspace.json"), `${JSON.stringify({ audit_id: audit.id, repository_id: repository.id, storage_namespace: storageNamespace, ...paths }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return paths;
  }

  async ensureSourceBaseline(audit, repository, paths) {
    const directory = join(paths.reports_root, "coverage");
    const path = join(directory, `source-baseline.${audit.id}.json`);
    const temporaryPath = join(directory, `source-baseline.${audit.id}.${process.pid}.${randomUUID()}.next.json`);
    await mkdir(directory, { recursive: true });
    try {
      await execFileAsync(process.execPath, [
        SCOPE_MANIFEST_BUILDER,
        "--root", repository.path,
        "--audit-id", audit.id,
        "--output", temporaryPath,
        "--mode", audit.source_kind === "directory" ? "filesystem" : "auto",
      ], { encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 1024 * 1024 });
      const manifest = JSON.parse(await readFile(temporaryPath, "utf8"));
      if (!/^[a-f0-9]{64}$/i.test(manifest?.scope_digest ?? "")) throw new Error("任务启动时生成的源码范围清单摘要无效。");
      const current = {
        path,
        scope_digest: manifest.scope_digest,
        file_count: Number(manifest.summary?.files ?? 0),
        mode: manifest.policy?.requested_mode ?? null,
        generated_at: new Date().toISOString(),
      };
      if (audit.source_baseline && (audit.source_baseline.scope_digest !== current.scope_digest || audit.source_baseline.path !== current.path)) {
        throw Object.assign(new Error("源码范围相较任务既有基线发生变化，拒绝在同一审计任务中继续。"), { statusCode: 409, code: "audit-source-baseline-drift" });
      }
      await rename(temporaryPath, path);
      audit.source_baseline ??= current;
      return audit.source_baseline;
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async ensureExecutionWorkspace(auditId, repositoryId) {
    if (!AUDIT_ID.test(auditId ?? "")) throw Object.assign(new Error("audit_id 格式非法，无法创建执行工作区。"), { statusCode: 422, code: "audit-id-invalid" });
    const audit = this.audits.get(auditId);
    if (!audit) throw Object.assign(new Error("动态验证只能复用工作台受管审计的冻结执行上下文。"), { statusCode: 409, code: "audit-not-managed" });
    if (audit.repository_id !== repositoryId) {
      throw Object.assign(new Error("审计与仓库绑定不一致。"), { statusCode: 409, code: "audit-repository-mismatch" });
    }
    const repository = this.repositoryForAudit(audit);
    if (!repository) throw Object.assign(new Error("审计所属源码对象不可用。"), { statusCode: 422, code: "repository-not-allowed" });
    return this.prepareExecutionWorkspace(audit, repository);
  }

  runtimeRepositories() {
    return this.managedRepositories().map(repository => ({ ...repository }));
  }

  listAudits() {
    return [...this.audits.values()].map(publicAudit).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async listAuditsWithTodo() {
    await Promise.all([...this.audits.values()].map(async audit => {
      audit.todo_path ??= join(this.stateRoot, audit.id, "audit-todo.json");
      audit.todo_summary = await this.taskSummary(audit);
    }));
    return this.listAudits();
  }

  getAudit(id) {
    const audit = this.audits.get(id);
    return audit ? publicAudit(audit) : null;
  }

  async taskSummary(audit) {
    if (audit.task_protocol !== TASK_BOARD_PROTOCOL) return auditTodoSummary(audit.todo_path);
    return summarizeBoard(await readBoard(audit.task_board_path));
  }

  async taskBoardPage(id, { offset = 0, limit = 50, kind = null, status = null } = {}) {
    const audit = this.audits.get(id);
    if (!audit || audit.task_protocol !== TASK_BOARD_PROTOCOL) throw Object.assign(new Error("该审计未使用通用任务面板。"), { statusCode: 404 });
    const board = await readBoard(audit.task_board_path);
    const rows = board.tasks.filter(task => (!kind || task.kind === kind) && (!status || task.status === status));
    const start = Math.max(0, Math.floor(Number(offset) || 0)), size = Math.min(100, Math.max(1, Math.floor(Number(limit) || 50)));
    return { summary: summarizeBoard(board), total: rows.length, items: rows.slice(start, start + size).map(task => ({ ...task,
      validation: board.validation.assessments?.find(row => row.task_id === task.task_id) ?? null })),
      next_offset: start + size < rows.length ? start + size : null };
  }

  async stopTaskBoard(audit) {
    const service = this.taskBoardServices.get(audit.id);
    if (!service) return;
    try { await service.shutdown(); } finally { this.taskBoardServices.delete(audit.id); }
  }

  async stopRuntimeTesting(audit) {
    const service = this.runtimeTestingServices.get(audit.id);
    if (!service) return;
    try { await service.shutdown(); } finally { this.runtimeTestingServices.delete(audit.id); }
  }

  setQueueScheduler(queueScheduler) {
    this.queueScheduler = queueScheduler;
  }

  setModelResolver(modelResolver) {
    if (modelResolver !== null && typeof modelResolver !== "function") throw new TypeError("模型解析器必须是函数或 null。");
    this.modelResolver = modelResolver;
  }

  setTargetOperationGuard(targetOperationGuard) {
    if (targetOperationGuard !== null && typeof targetOperationGuard !== "function") throw new TypeError("对象操作锁必须是函数或 null。");
    this.targetOperationGuard = targetOperationGuard;
  }

  async modelForLaunch(audit) {
    const configured = Object.hasOwn(audit, "model") ? audit.model : this.modelResolver ? await this.modelResolver(audit) : null;
    return normalizeOpenCodeModel(configured);
  }

  queueSnapshot() {
    const audits = [...this.audits.values()];
    return {
      queued: audits
        .filter(audit => audit.status === "queued")
        .sort((left, right) => String(left.created_at ?? "").localeCompare(String(right.created_at ?? "")) || left.id.localeCompare(right.id))
        .map(audit => ({ id: audit.id, mode: audit.queue?.mode ?? "start", created_at: audit.created_at, enqueued_at: audit.queue?.enqueued_at ?? audit.updated_at })),
      active_count: audits.filter(audit => EXECUTING.has(audit.status)).length,
    };
  }

  async dispatchQueuedAudit(id) {
    await this.ready;
    const audit = this.audits.get(id);
    if (!audit || audit.status !== "queued" || this.dispatching.has(id)) return null;
    if (audit.product_campaign_id && this.productCampaignGuard && !this.productCampaignGuard(audit.product_campaign_id)) return null;
    const repository = this.repositoryForAudit(audit);
    if (!repository) {
      audit.status = "failed";
      audit.error = "审计所属仓库不再可用。";
      audit.finished_at = new Date().toISOString();
      await this.record(audit, "audit.failed", { message: audit.error, reason: "queue-repository-unavailable" });
      return publicAudit(audit);
    }
    const queue = audit.queue ?? { mode: "start", enqueued_at: audit.updated_at ?? new Date().toISOString() };
    const resume = queue.mode === "recover";
    this.dispatching.add(id);
    try {
      audit.queue = { ...queue, dispatched_at: new Date().toISOString() };
      const start = () => this.start(audit, repository, { resume, existingSessionId: resume ? providerSessionId(queue.provider_session_id) : null });
      if (this.targetOperationGuard) await this.targetOperationGuard(audit, start);
      else await start();
      return publicAudit(audit);
    } catch (error) {
      await this.stopTaskBoard(audit).catch(() => {});
      await this.stopRuntimeTesting(audit).catch(() => {});
      if (error.code === "product-campaign-not-running") {
        const cancelled = audit.status === "cancelled" || ["CANCELLING", "CANCELLED"].includes(this.productCampaignState?.(audit.product_campaign_id));
        audit.status = cancelled ? "cancelled" : "queued";
        audit.error = null; audit.finished_at = cancelled ? new Date().toISOString() : null;
        await this.record(audit, cancelled ? "audit.cancelled" : "audit.queue_held", { reason: "product-campaign-not-running" });
        return publicAudit(audit);
      }
      audit.status = resume ? "interrupted" : "failed";
      audit.error = redact(error.message);
      audit.finished_at = new Date().toISOString();
      if (resume) {
        audit.interrupted_at = audit.finished_at;
        audit.interruption_reason = "recovery-launch-failed";
      }
      await this.record(audit, `audit.${audit.status}`, {
        reason: resume ? "recovery-launch-failed" : "queue-launch-failed",
        message: audit.error,
      });
      throw error;
    } finally {
      this.dispatching.delete(id);
    }
  }

  async writePrivateProxyEnvironment(auditId, sourceEnvironment = this.environment) {
    const directory = join(this.stateRoot, auditId);
    const environment = proxyEnvironmentFrom(sourceEnvironment);
    const metadata = proxyEnvironmentMetadata(environment);
    if (!metadata.enabled) return metadata;
    await mkdir(directory, { recursive: true });
    const document = proxyEnvironmentDocument(environment);
    const temporary = join(directory, `${PRIVATE_PROXY_ENVIRONMENT_FILE}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, document, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, join(directory, PRIVATE_PROXY_ENVIRONMENT_FILE));
    return metadata;
  }

  async verifiedPrivateProxyEnvironment(audit) {
    const metadata = audit.private_runtime?.proxy_environment;
    // Audits created before proxy snapshots were introduced keep using the
    // workbench environment. New audits persist an allowlisted snapshot.
    if (!metadata) return proxyEnvironmentFrom(this.environment);
    if (metadata.enabled === false) return {};
    if (metadata.enabled !== true
      || metadata.file_name !== PRIVATE_PROXY_ENVIRONMENT_FILE
      || !/^[a-f0-9]{64}$/.test(metadata.sha256 ?? "")
      || !Array.isArray(metadata.variable_names)) {
      throw Object.assign(new Error("任务代理环境元数据无效，拒绝继续。"), { statusCode: 409, code: "audit-proxy-environment-integrity-failed" });
    }
    const path = join(this.stateRoot, audit.id, PRIVATE_PROXY_ENVIRONMENT_FILE);
    let document;
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error("not-file");
      document = await readFile(path, "utf8");
    } catch {
      throw Object.assign(new Error("任务代理环境文件缺失或不可读取，拒绝继续。"), { statusCode: 409, code: "audit-proxy-environment-integrity-failed" });
    }
    if (createHash("sha256").update(document).digest("hex") !== metadata.sha256) {
      throw Object.assign(new Error("任务代理环境摘要不匹配，拒绝继续。"), { statusCode: 409, code: "audit-proxy-environment-integrity-failed" });
    }
    let parsed;
    try {
      parsed = JSON.parse(document);
    } catch {
      throw Object.assign(new Error("任务代理环境文件格式无效，拒绝继续。"), { statusCode: 409, code: "audit-proxy-environment-integrity-failed" });
    }
    const environment = proxyEnvironmentFrom(parsed?.environment);
    const actualNames = Object.keys(environment).sort();
    const expectedNames = [...new Set(metadata.variable_names)].sort();
    if (parsed?.schema_version !== 1
      || !parsed?.environment || typeof parsed.environment !== "object" || Array.isArray(parsed.environment)
      || actualNames.length !== Object.keys(parsed.environment).length
      || JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      throw Object.assign(new Error("任务代理环境包含不受支持的变量，拒绝继续。"), { statusCode: 409, code: "audit-proxy-environment-integrity-failed" });
    }
    return environment;
  }

  async writePrivateContexts(auditId, contexts) {
    const directory = join(this.stateRoot, auditId);
    await mkdir(directory, { recursive: true });
    const metadata = {};
    for (const [key, context] of Object.entries(contexts)) {
      const fileName = PRIVATE_CONTEXT_FILES[key];
      if (!context.enabled) {
        metadata[key] = contextMetadata(false);
        continue;
      }
      const bytes = `${context.text}\n`;
      const temporary = join(directory, `${fileName}.${process.pid}.${randomUUID()}.tmp`);
      await writeFile(temporary, bytes, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, join(directory, fileName));
      metadata[key] = contextMetadata(true, fileName, context.text);
    }
    return metadata;
  }

  async verifiedPrivateContextPaths(audit, { keys = Object.keys(PRIVATE_CONTEXT_FILES) } = {}) {
    const paths = {};
    for (const key of keys) {
      const metadata = audit.private_context?.[key];
      if (!metadata?.enabled) continue;
      const expectedFileName = PRIVATE_CONTEXT_FILES[key];
      if (metadata.file_name !== expectedFileName || !/^[a-f0-9]{64}$/.test(metadata.sha256 ?? "")) {
        throw Object.assign(new Error("任务私有上下文元数据无效，拒绝继续。"), { statusCode: 409, code: "audit-context-integrity-failed" });
      }
      const path = join(this.stateRoot, audit.id, expectedFileName);
      let bytes;
      try {
        const info = await stat(path);
        if (!info.isFile()) throw new Error("not-file");
        bytes = await readFile(path);
      } catch {
        throw Object.assign(new Error("任务私有上下文文件缺失或不可读取，拒绝继续。"), { statusCode: 409, code: "audit-context-integrity-failed" });
      }
      if (createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) {
        throw Object.assign(new Error("任务私有上下文摘要不匹配，拒绝继续。"), { statusCode: 409, code: "audit-context-integrity-failed" });
      }
      paths[key] = path;
    }
    return paths;
  }

  async redactionsForAudit(audit) {
    const cached = this.contextRedactions.get(audit.id);
    if (cached) return cached;
    const values = new Set();
    for (const [key, fileName] of Object.entries(PRIVATE_CONTEXT_FILES)) {
      if (audit.private_context?.[key]?.enabled !== true) continue;
      try {
        const text = await readFile(join(this.stateRoot, audit.id, fileName), "utf8");
        for (const value of sensitiveRedactionValues(text)) values.add(value);
      } catch {
        // Integrity checks at launch provide the behavior gate; missing files add no log redactions.
      }
    }
    try {
      const environment = await this.verifiedPrivateProxyEnvironment(audit);
      for (const value of Object.values(environment)) {
        for (const sensitive of sensitiveRedactionValues(value)) values.add(sensitive);
      }
    } catch {
      // A missing or tampered proxy snapshot is handled by the launch gate.
    }
    const result = [...values].sort((left, right) => right.length - left.length);
    this.contextRedactions.set(audit.id, result);
    return result;
  }

  async retryDraft(auditId) {
    await this.ready;
    const audit = this.audits.get(auditId);
    if (!audit) throw Object.assign(new Error("原审计任务不存在，无法恢复重试内容。"), { statusCode: 404, code: "audit-not-found" });
    const paths = await this.verifiedPrivateContextPaths(audit);
    const draft = {};
    if (audit.memory_mode) draft.memory_mode = audit.memory_mode;
    if (audit.mining_strategy) draft.mining_strategy = audit.mining_strategy;
    for (const [key, enabledField, valueField] of [
      ["api_inventory", "api_inventory_enabled", "api_inventory"],
      ["additional_instructions", "additional_instructions_enabled", "additional_instructions"],
      ["test_environment", "test_environment_enabled", "test_environment_context"],
    ]) {
      if (key === "api_inventory" && audit.task_protocol !== TASK_BOARD_PROTOCOL) continue;
      draft[enabledField] = audit.private_context?.[key]?.enabled === true;
      draft[valueField] = "";
      if (!draft[enabledField]) continue;
      let bytes;
      try { bytes = await readFile(paths[key]); }
      catch { throw Object.assign(new Error("原任务的私有上下文读取失败，无法恢复重试内容。"), { statusCode: 409, code: "audit-context-integrity-failed" }); }
      if (createHash("sha256").update(bytes).digest("hex") !== audit.private_context[key].sha256) {
        throw Object.assign(new Error("原任务的私有上下文已变化，无法恢复重试内容。"), { statusCode: 409, code: "audit-context-integrity-failed" });
      }
      // The storage writer appends one newline; preserve all user text inside it.
      const text = bytes.toString("utf8");
      draft[valueField] = text.endsWith("\n") ? text.slice(0, -1) : text;
    }
    return draft;
  }

  async dynamicValidationPolicy(auditId, repositoryId = null) {
    await this.ready;
    const audit = this.audits.get(auditId);
    if (!audit || (repositoryId && audit.repository_id !== repositoryId)) {
      return { enabled: false, reason: "audit-not-managed" };
    }
    if (audit.private_context?.test_environment?.enabled !== true) {
      return { enabled: false, reason: "test-environment-disabled" };
    }
    try {
      const paths = await this.verifiedPrivateContextPaths(audit, { keys: ["test_environment"] });
      return {
        enabled: true,
        reason: null,
        audit_id: audit.id,
        repository_id: audit.repository_id,
        context_path: paths.test_environment,
        context_sha256: audit.private_context.test_environment.sha256,
      };
    } catch {
      return { enabled: false, reason: "test-environment-context-invalid" };
    }
  }

  async deleteAudit(id, { repositoryId, expectedVersion, artifactPaths = [] } = {}) {
    await this.ready;
    if (!AUDIT_ID.test(id ?? "")) throw Object.assign(new Error("audit_id 格式非法。"), { statusCode: 422, code: "audit-id-invalid" });
    if (!REPOSITORY_ID.test(repositoryId ?? "") || !this.repositories.has(repositoryId)) {
      throw Object.assign(new Error("审计所属仓库不在服务端白名单中。"), { statusCode: 422, code: "repository-not-allowed" });
    }
    const audit = this.audits.get(id);
    if (audit && audit.repository_id !== repositoryId) throw Object.assign(new Error("审计与仓库绑定不一致。"), { statusCode: 409, code: "audit-repository-mismatch" });
    if (audit && Number(expectedVersion) !== audit.version) throw Object.assign(new Error("审计版本已变化，请刷新后重试。"), { statusCode: 412, code: "version-mismatch" });
    if (audit && (EXECUTING.has(audit.status) || this.processes.has(id) || this.completions.has(id) || this.dispatching.has(id))) {
      throw Object.assign(new Error("运行中的审计不能删除；请先取消并等待任务结束。"), { statusCode: 409, code: "audit-delete-active" });
    }
    const queuedWrite = this.writeQueues.get(id);
    if (queuedWrite) await queuedWrite;
    if (audit && (EXECUTING.has(audit.status) || this.processes.has(id) || this.completions.has(id) || this.dispatching.has(id))) {
      throw Object.assign(new Error("审计仍有未完成的运行状态，暂不能删除。"), { statusCode: 409, code: "audit-delete-active" });
    }

    const reportsRoot = join(this.artifactsRoot, repositoryId);
    let removedArtifacts = 0;
    for (const artifactPath of [...new Set(artifactPaths)]) {
      if (typeof artifactPath !== "string" || !artifactPath || isAbsolute(artifactPath)) {
        throw Object.assign(new Error("审计制品路径不受工作台控制。"), { statusCode: 409, code: "audit-artifact-path-invalid" });
      }
      const candidate = resolve(reportsRoot, artifactPath);
      if (!controlledChild(reportsRoot, candidate)) throw Object.assign(new Error("审计制品路径越出仓库制品目录。"), { statusCode: 409, code: "audit-artifact-path-invalid" });
      try {
        const info = await controlledPathInfo(reportsRoot, candidate);
        if (!info) continue;
        if (!info.isFile()) throw Object.assign(new Error("审计制品不是可安全删除的普通文件。"), { statusCode: 409, code: "audit-artifact-path-invalid" });
        await rm(candidate);
        removedArtifacts += 1;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }

    for (const directory of [
      join(reportsRoot, "handoffs", id),
      join(reportsRoot, "validation-handoff", "runtime", id),
      join(reportsRoot, "runtime-testing", id),
      join(reportsRoot, "task-board", id),
    ]) await removeControlledPath(reportsRoot, directory);
    await removeControlledPath(this.temporaryRoot, join(this.temporaryRoot, repositoryId, id));
    await removeControlledPath(this.executionRoot, join(this.executionRoot, id));
    if (audit) await removeControlledPath(this.stateRoot, join(this.stateRoot, id));

    this.audits.delete(id);
    this.subscribers.delete(id);
    this.writeQueues.delete(id);
    this.contextRedactions.delete(id);
    return {
      deleted: true,
      audit_id: id,
      repository_id: repositoryId,
      removed_artifact_files: removedArtifacts,
      removed_runner_state: Boolean(audit),
    };
  }

  async persist(audit) {
    const directory = join(this.stateRoot, audit.id);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `run.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(audit, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, join(directory, "run.json"));
  }

  async record(audit, type, data = {}, { bumpVersion = true } = {}) {
    return this.enqueue(audit.id, async () => {
      if (bumpVersion) audit.version += 1;
      audit.updated_at = new Date().toISOString();
      const event = {
        event_id: `evt_${randomUUID()}`,
        audit_id: audit.id,
        sequence: audit.event_sequence + 1,
        occurred_at: audit.updated_at,
        type,
        data,
      };
      audit.event_sequence = event.sequence;
      await this.persist(audit);
      await appendFile(join(this.stateRoot, audit.id, "events.jsonl"), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      this.emit("event", event);
      for (const subscriber of this.subscribers.get(audit.id) ?? []) subscriber(event);
      return event;
    });
  }

  async eventsSince(id, sequence = 0, lastEventId = null) {
    return this.eventLogReader.eventsSince(join(this.stateRoot, id, "events.jsonl"), sequence, lastEventId);
  }

  async recentLogs(id, limit = 100) {
    const path = join(this.stateRoot, id, "runner.log.jsonl");
    try {
      const info = await stat(path);
      const start = Math.max(0, info.size - MAX_LOG_READ_BYTES);
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(info.size - start);
        await handle.read(buffer, 0, buffer.length, start);
        const lines = buffer.toString("utf8").split("\n");
        if (start > 0) lines.shift();
        return lines.filter(Boolean).flatMap(line => {
          try { return [JSON.parse(line)]; } catch { return []; }
        }).slice(-Math.min(Math.max(Number(limit) || 100, 1), 200)).map(openCodeEventView);
      } finally { await handle.close(); }
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  subscribe(id, listener) {
    const listeners = this.subscribers.get(id) ?? new Set();
    listeners.add(listener);
    this.subscribers.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.subscribers.delete(id);
    };
  }

  async createAudit(input, idempotencyKey) {
    await this.ready;
    if (!this.enabled) throw Object.assign(new Error("运行驱动未启用；请用 --enable-runner 启动平台。"), { statusCode: 503, code: "runner-disabled" });
    if (!idempotencyKey || idempotencyKey.length > 200) throw Object.assign(new Error("缺少有效的 Idempotency-Key。"), { statusCode: 400, code: "idempotency-key-required" });
    const repository = this.repositories.get(input.repository_id);
    if (!repository) throw Object.assign(new Error("仓库不在服务端白名单中。"), { statusCode: 422, code: "repository-not-allowed" });
    const id = input.audit_id || `audit-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    if (!AUDIT_ID.test(id)) throw Object.assign(new Error("audit_id 格式非法。"), { statusCode: 422, code: "audit-id-invalid" });
    for (const existing of this.audits.values()) {
      if (existing.idempotency_digest === createHash("sha256").update(idempotencyKey).digest("hex")) return publicAudit(existing);
    }
    if (this.audits.has(id)) throw Object.assign(new Error("audit_id 已存在。"), { statusCode: 409, code: "audit-exists" });
    const facts = await this.repositoryFacts(repository);
    if (!facts.git_repository || !facts.config_valid) throw Object.assign(new Error("项目目录缺少 Git 元数据，或工作台 OpenCode 配置无效。"), { statusCode: 422, code: "repository-not-ready" });
    if (facts.dirty && input.allow_dirty !== true) throw Object.assign(new Error("仓库存在未提交修改；为保证目标提交可复现，默认拒绝启动。"), { statusCode: 409, code: "repository-dirty" });
    const requestedRef = typeof input.ref === "string" && input.ref ? input.ref : "HEAD";
    if (!/^[a-z0-9][a-z0-9._\/-]{0,199}$/i.test(requestedRef) || requestedRef.includes("..") || requestedRef.includes("@{")) {
      throw Object.assign(new Error("ref 格式非法。"), { statusCode: 422, code: "ref-invalid" });
    }
    const commit = await git(repository.path, ["rev-parse", "--verify", `${requestedRef}^{commit}`]);
    if (commit !== facts.commit) throw Object.assign(new Error("当前工作树不在请求的提交上；平台不会自动 checkout。"), { statusCode: 409, code: "ref-not-checked-out" });
    normalizeApiList(input.api_inventory ?? "");
    const taskProtocol = selectTaskProtocol(input);
    const miningStrategy = taskProtocol === TASK_BOARD_PROTOCOL ? selectMiningStrategy(input.mining_strategy, input.api_inventory ?? "") : null;
    const contexts = {
      api_inventory: { enabled: Boolean(input.api_inventory?.trim()), text: input.api_inventory ?? "" },
      additional_instructions: normalizeContextInput(input, {
        enabledField: "additional_instructions_enabled",
        valueField: "additional_instructions",
        label: "测试目标补充说明",
        maxLength: MAX_ADDITIONAL_INSTRUCTIONS,
      }),
      test_environment: normalizeContextInput(input, {
        enabledField: "test_environment_enabled",
        valueField: "test_environment_context",
        label: "测试环境信息",
        maxLength: MAX_TEST_ENVIRONMENT_CONTEXT,
      }),
    };
    const now = new Date().toISOString();
    const audit = {
      id,
      name: typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 160) : `仓库级安全审计 · ${repository.name}`,
      memory_mode: ["full", "facts_only", "off", "blind"].includes(input.memory_mode) ? input.memory_mode : "full",
      repository_id: repository.id,
      repository_name: repository.name,
      commit,
      branch: facts.branch,
      status: "queued",
      version: 1,
      event_sequence: 0,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null,
      exit_code: null,
      error: null,
      allow_dirty: input.allow_dirty === true,
      // Persist the task selection, including null for OpenCode defaults.
      // Queue dispatch and recovery must preserve this binding.
      model: normalizeOpenCodeModel(input.model),
      task_protocol: taskProtocol,
      ...(taskProtocol === TASK_BOARD_PROTOCOL ? { task_board_path: join(this.stateRoot, id, "task-board.json"), mining_strategy: miningStrategy } : {}),
      runtime_testing: runtimeSelection(input),
      bac_analysis: bacSelection(input.bac_analysis ?? "auto"),
      provider_session_id: null,
      recovery_count: 0,
      stage_delivery_enforcement: "TODO_ENFORCED",
      stage_delivery: null,
      last_recovered_at: null,
      interrupted_at: null,
      interruption_reason: null,
      queue: { mode: "start", enqueued_at: now },
      idempotency_digest: createHash("sha256").update(idempotencyKey).digest("hex"),
      todo_path: join(this.stateRoot, id, "audit-todo.json"),
    };
    audit.private_context = await this.writePrivateContexts(id, contexts);
    audit.private_runtime = {
      proxy_environment: await this.writePrivateProxyEnvironment(id),
    };
    audit.todo_summary = taskProtocol === TASK_BOARD_PROTOCOL
      ? summarizeBoard(await createBoard({ path: audit.task_board_path, auditId: id, apiList: contexts.api_inventory.text, miningStrategy, bacMode: audit.bac_analysis?.mode ?? "off" }))
      : (await createEmptyAuditTodo({ todoPath: audit.todo_path, auditId: id })).summary;
    this.audits.set(id, audit);
    await this.persist(audit);
    await this.record(audit, "audit.queued", {
      repository_id: repository.id,
      commit,
      model: audit.model ?? DEFAULT_MODEL_SELECTION,
      additional_instructions_enabled: audit.private_context.additional_instructions.enabled,
      test_environment_enabled: audit.private_context.test_environment.enabled,
    });
    if (this.queueScheduler && await this.queueScheduler.enqueueNewAudit()) return publicAudit(audit);
    this.dispatchQueuedAudit(audit.id).catch(() => {});
    return publicAudit(audit);
  }

  async createAuditFromTarget(input, idempotencyKey) {
    await this.ready;
    if (!this.enabled) throw Object.assign(new Error("运行驱动未启用；请用 --enable-runner 启动平台。"), { statusCode: 503, code: "runner-disabled" });
    if (!idempotencyKey || idempotencyKey.length > 200) throw Object.assign(new Error("缺少有效的 Idempotency-Key。"), { statusCode: 400, code: "idempotency-key-required" });
    const snapshot = structuredClone(input?.execution_spec);
    const snapshotDigest = input?.execution_spec_digest;
    if (!snapshot || !/^[a-f0-9]{64}$/i.test(snapshotDigest ?? "") || createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") !== snapshotDigest || snapshot.target_id !== input.target_id || !Array.isArray(snapshot.source_scopes)) {
      throw Object.assign(new Error("审计对象快照不完整或摘要无效。"), { statusCode: 422, code: "target-snapshot-invalid" });
    }
    if (snapshot.source_scopes.length !== 1) {
      throw Object.assign(new Error("多范围对象已保存，但跨范围关联流水线尚未启用，不能只扫描其中一个范围。"), { statusCode: 409, code: "cross-scope-analysis-not-enabled" });
    }
    const sourceScope = snapshot.source_scopes[0];
    if ((sourceScope.include_patterns?.length ?? 0) || (sourceScope.exclude_patterns?.length ?? 0)) {
      throw Object.assign(new Error("范围包含/排除规则已保存，但受限范围枚举器尚未接入执行流水线；请先选择组件根目录作为单一范围。"), { statusCode: 409, code: "scope-pattern-execution-not-enabled" });
    }
    const repository = targetRepositoryFromAudit({
      repository_id: snapshot.target_id,
      repository_name: snapshot.target_name,
      execution_spec: snapshot,
    }, this.configPath);
    if (!repository) throw Object.assign(new Error("审计对象的单目录范围无效。"), { statusCode: 422, code: "target-source-invalid" });
    try {
      const [canonical, info] = await Promise.all([realpath(repository.path), stat(repository.path)]);
      if (!info.isDirectory() || canonical !== repository.path) throw new Error("source-path-drift");
    } catch {
      throw Object.assign(new Error("审计对象的源码范围不存在、不可读取或目录链接已变化。"), { statusCode: 422, code: "target-source-unavailable" });
    }
    const config = await configFacts(repository.config_path);
    if (!config.config_valid) throw Object.assign(new Error("工作台 OpenCode 配置无效，不能启动审计。"), { statusCode: 422, code: "repository-not-ready" });
    const id = input.audit_id || `audit-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    if (!AUDIT_ID.test(id)) throw Object.assign(new Error("audit_id 格式非法。"), { statusCode: 422, code: "audit-id-invalid" });
    const idempotencyDigest = createHash("sha256").update(idempotencyKey).digest("hex");
    for (const existing of this.audits.values()) if (existing.idempotency_digest === idempotencyDigest) return publicAudit(existing);
    if (this.audits.has(id)) throw Object.assign(new Error("audit_id 已存在。"), { statusCode: 409, code: "audit-exists" });
    normalizeApiList(input.api_inventory ?? "");
    const taskProtocol = selectTaskProtocol(input);
    const miningStrategy = taskProtocol === TASK_BOARD_PROTOCOL ? selectMiningStrategy(input.mining_strategy, input.api_inventory ?? "") : null;
    const contexts = {
      api_inventory: { enabled: Boolean(input.api_inventory?.trim()), text: input.api_inventory ?? "" },
      additional_instructions: normalizeContextInput(input, {
        enabledField: "additional_instructions_enabled", valueField: "additional_instructions", label: "测试目标补充说明", maxLength: MAX_ADDITIONAL_INSTRUCTIONS,
      }),
      test_environment: normalizeContextInput(input, {
        enabledField: "test_environment_enabled", valueField: "test_environment_context", label: "测试环境信息", maxLength: MAX_TEST_ENVIRONMENT_CONTEXT,
      }),
    };
    const created = new Date().toISOString();
    const audit = {
      id,
      name: typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 160) : `目录级安全审计 · ${repository.name}`,
      repository_id: repository.id,
      repository_name: repository.name,
      source_kind: "directory",
      memory_mode: ["full", "facts_only", "off", "blind"].includes(input.memory_mode) ? input.memory_mode : "full",
      product_campaign_id: input.product_campaign_id ?? null,
      execution_spec: snapshot,
      execution_spec_digest: snapshotDigest,
      commit: null,
      branch: null,
      status: "queued",
      version: 1,
      event_sequence: 0,
      created_at: created,
      updated_at: created,
      started_at: null,
      finished_at: null,
      exit_code: null,
      error: null,
      allow_dirty: true,
      model: normalizeOpenCodeModel(input.model),
      task_protocol: taskProtocol,
      ...(taskProtocol === TASK_BOARD_PROTOCOL ? { task_board_path: join(this.stateRoot, id, "task-board.json"), mining_strategy: miningStrategy } : {}),
      runtime_testing: runtimeSelection(input),
      bac_analysis: bacSelection(input.bac_analysis ?? "auto"),
      provider_session_id: null,
      recovery_count: 0,
      stage_delivery_enforcement: "TODO_ENFORCED",
      stage_delivery: null,
      last_recovered_at: null,
      interrupted_at: null,
      interruption_reason: null,
      queue: { mode: "start", enqueued_at: created },
      idempotency_digest: idempotencyDigest,
      todo_path: join(this.stateRoot, id, "audit-todo.json"),
    };
    audit.private_context = await this.writePrivateContexts(id, contexts);
    audit.private_runtime = { proxy_environment: await this.writePrivateProxyEnvironment(id) };
    audit.todo_summary = taskProtocol === TASK_BOARD_PROTOCOL
      ? summarizeBoard(await createBoard({ path: audit.task_board_path, auditId: id, apiList: contexts.api_inventory.text, miningStrategy, bacMode: audit.bac_analysis?.mode ?? "off" }))
      : (await createEmptyAuditTodo({ todoPath: audit.todo_path, auditId: id })).summary;
    this.audits.set(id, audit);
    await this.persist(audit);
    await this.record(audit, "audit.queued", {
      repository_id: repository.id,
      source_kind: audit.source_kind,
      execution_spec_digest: snapshotDigest,
      source_scope_id: sourceScope.id,
      model: audit.model ?? DEFAULT_MODEL_SELECTION,
      additional_instructions_enabled: audit.private_context.additional_instructions.enabled,
      test_environment_enabled: audit.private_context.test_environment.enabled,
    });
    if (this.queueScheduler && await this.queueScheduler.enqueueNewAudit()) return publicAudit(audit);
    this.dispatchQueuedAudit(audit.id).catch(() => {});
    return publicAudit(audit);
  }

  async start(audit, repository, { resume = false, existingSessionId = null } = {}) {
    audit.status = resume ? "recovering" : "preparing";
    audit.started_at ??= new Date().toISOString();
    audit.finished_at = null;
    audit.exit_code = null;
    audit.pid = null;
    audit.error = null;
    audit.interruption_reason = null;
    await this.record(audit, resume ? "audit.recovering" : "audit.preparing", resume ? { recovery_count: audit.recovery_count, queue_mode: audit.queue?.mode ?? "recover" } : { queue_mode: audit.queue?.mode ?? "start" });
    const paths = await this.prepareExecutionWorkspace(audit, repository);
    audit.paths = paths;
    await this.record(audit, "audit.workspace.ready", paths);
    let memoryAdapter = null;
    if (this.memoryProvider) {
      try { memoryAdapter = await this.memoryProvider(audit, repository, paths); }
      catch (error) {
        if (error.code === "memory-source-drift" || audit.product_campaign_id) throw error;
        audit.memory_gap = error.message; await this.recordLog(audit, "stderr", `长期记忆未就绪，静态审计继续：${error.message}`);
      }
    }
    const contextPaths = await this.verifiedPrivateContextPaths(audit);
    const quickDynamicEnabled = audit.task_protocol !== TASK_BOARD_PROTOCOL && !audit.runtime_testing && audit.private_context?.test_environment?.enabled === true && Boolean(contextPaths.test_environment);
    const proxyEnvironment = await this.verifiedPrivateProxyEnvironment(audit);
    const environment = {
      ...(await buildOpenCodeEnvironment(repository.config_path, { ...this.environment, ...proxyEnvironment })),
      AUDIT_SOURCE_ROOT: paths.source_root,
      AUDIT_SOURCE_BINDING_PATH: paths.source_binding,
      AUDIT_ENGINE_ROOT: resolve(dirname(repository.config_path), ".."),
      AUDIT_WORKSPACE_ROOT: paths.workspace_root,
      AUDIT_REPORTS_ROOT: paths.reports_root,
      AUDIT_TMP_ROOT: paths.tmp_root,
      AUDIT_TASK_PROTOCOL: audit.task_protocol ?? "",
      AUDIT_MINING_STRATEGY: audit.mining_strategy ?? "",
      AUDIT_MEMORY_MODE: audit.memory_mode ?? "full",
      AUDIT_MEMORY_CONNECTION_PATH: "",
      AUDIT_MEMORY_CLI: "",
      AUDIT_TASK_BOARD_CLI: join(paths.workspace_root, ".opencode", "scripts", "task-board.mjs"),
      AUDIT_TASK_BOARD_CONNECTION_PATH: audit.task_protocol === TASK_BOARD_PROTOCOL ? join(this.stateRoot, audit.id, "task-board-service", "endpoint.json") : "",
      AUDIT_TODO_PATH: audit.task_protocol === TASK_BOARD_PROTOCOL ? "" : paths.todo_path,
      AUDIT_AI_ROUTING_POLICY: "surface-dependency-v1",
      AUDIT_TODO_HANDOFF_ROOT: paths.todo_handoff_root,
      AUDIT_TODO_CLI: join(paths.workspace_root, ".opencode", "scripts", "audit-todo.mjs"),
      ...knowledgeEnvironment(this.platformRoot, this.environment),
      AUDIT_KNOWLEDGE_CLI: join(paths.workspace_root, ".opencode", "scripts", "knowledge-query.mjs"),
      AUDIT_BAC_MODE: audit.bac_analysis?.mode ?? "off",
      AUDIT_BAC_CLI: join(paths.workspace_root, ".opencode", "scripts", "bac-analysis.mjs"),
      AUDIT_QUICK_DYNAMIC_ENABLED: quickDynamicEnabled ? "true" : "false",
      AUDIT_QUICK_DYNAMIC_DEADLINE_SECONDS: "180",
      AUDIT_QUICK_DYNAMIC_SETUP_SECONDS: "240",
      AUDIT_FULL_DYNAMIC_TRIGGER: "MANUAL_ONLY",
      AUDIT_RUNTIME_PROTOCOL: "",
      AUDIT_RUNTIME_CLI: "",
      AUDIT_RUNTIME_STATE_ROOT: "",
      AUDIT_RUNTIME_CONNECTION_PATH: "",
      ...(quickDynamicEnabled && audit.task_protocol !== TASK_BOARD_PROTOCOL ? {
        AUDIT_TEST_ENVIRONMENT_CONTEXT_PATH: contextPaths.test_environment,
        AUDIT_TEST_ENVIRONMENT_CONTEXT_SHA256: audit.private_context.test_environment.sha256,
      } : {}),
    };
    const sessionId = providerSessionId(existingSessionId ?? audit.provider_session_id ?? audit.terminal?.provider_session_id);
    const focusConfig = JSON.parse(environment.OPENCODE_CONFIG_CONTENT);
    // Explicit loading also covers OPENCODE_DISABLE_PROJECT_CONFIG=true.
    const configuredPlugins = JSON.parse(await readFile(repository.config_path, "utf8")).plugin ?? [];
    focusConfig.plugin = [...configuredPlugins, new URL("../../lib/focus-area-watchdog-plugin.mjs", import.meta.url).href];
    environment.OPENCODE_CONFIG_CONTENT = JSON.stringify(focusConfig);
    await this.redactionsForAudit(audit);
    const prompt = resume ? recoveryPrompt(audit, repository, paths, contextPaths) : auditPrompt(audit, repository, paths, contextPaths);
    const model = await this.modelForLaunch(audit);
    if (audit.runtime_testing) {
      environment.AUDIT_RUNTIME_PROTOCOL = "runtime-testing.v1";
      environment.AUDIT_RUNTIME_CLI = join(paths.workspace_root, ".opencode", "scripts", "runtime-testing.mjs");
      environment.AUDIT_RUNTIME_STATE_ROOT = join(paths.reports_root, "runtime-testing", audit.id);
      environment.AUDIT_RUNTIME_CONNECTION_PATH = join(this.stateRoot, audit.id, "runtime-testing", "endpoint.json");
      const config = JSON.parse(environment.OPENCODE_CONFIG_CONTENT);
      config.mcp["chrome-devtools"] = { enabled: false };
      environment.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
      const authorization = authorizeRuntime({ auditId: audit.id, selected: audit.runtime_testing,
        enabled: audit.private_context?.test_environment?.enabled === true,
        context: contextPaths.test_environment ? await readFile(contextPaths.test_environment, "utf8") : "",
        sourceBinding: audit.commit ?? audit.execution_spec_digest, scopeDigest: audit.source_baseline.scope_digest });
      const service = new RuntimeTestingService({ root: environment.AUDIT_RUNTIME_STATE_ROOT, privateRoot: dirname(environment.AUDIT_RUNTIME_CONNECTION_PATH),
        authorization: authorization.public, privateContext: authorization.private, command: this.command, environment, workspaceRoot: paths.workspace_root, model,
        onChange: async snapshot => { audit.runtime_testing_state = snapshot; await this.record(audit, "audit.runtime-testing.updated", { status: snapshot.status, active_packet: snapshot.active_packet, reason: snapshot.reason }); } });
      this.runtimeTestingServices.set(audit.id, service);
      await service.start();
    }
    if (audit.task_protocol === TASK_BOARD_PROTOCOL) {
      const board = await readBoard(audit.task_board_path);
      if ((board.mining_strategy ?? null) !== (audit.mining_strategy ?? null)) {
        throw Object.assign(new Error("任务面板的漏洞挖掘策略与创建时不一致，拒绝继续执行。"), { statusCode: 409, code: "audit-mining-strategy-drift" });
      }
      const importedApis = normalizeApiList(contextPaths.api_inventory ? await readFile(contextPaths.api_inventory, "utf8") : "");
      if (JSON.stringify(board.api_sources) !== JSON.stringify(importedApis)) {
        throw Object.assign(new Error("任务面板的 API 清单与创建时原文不一致，拒绝继续执行。"), { statusCode: 409, code: "audit-api-inventory-drift" });
      }
      const service = new TaskBoardService({ path: audit.task_board_path, reportsRoot: paths.reports_root,
        privateRoot: dirname(environment.AUDIT_TASK_BOARD_CONNECTION_PATH), workspaceRoot: paths.workspace_root, sourceRoot: paths.source_root,
        auditId: audit.id, scopeDigest: audit.source_baseline.scope_digest, environment, command: this.command, model,
        runtimeRequired: Boolean(audit.runtime_testing), bacMode: audit.bac_analysis?.mode ?? "off", memory: memoryAdapter,
        onChange: async summary => { audit.todo_summary = summary; await this.record(audit, "audit.task-board.updated", summary); },
        onLog: (source, line) => this.recordLog(audit, source, line) });
      service.paused = true;
      this.taskBoardServices.set(audit.id, service);
      await service.start();
      if (memoryAdapter) { environment.AUDIT_MEMORY_CONNECTION_PATH = service.connectionPath; environment.AUDIT_MEMORY_CLI = join(paths.workspace_root, ".opencode", "scripts", "audit-memory.mjs"); }
    }
    if (audit.model !== model) {
      audit.model = model;
      await this.record(audit, "audit.model.applied", {
        model: model ?? DEFAULT_MODEL_SELECTION,
        reason: resume ? "recovery-launch" : "launch",
      });
    }
    let command = this.command;
    let args = [
      "run", "--format", "json",
      ...(sessionId ? ["--session", sessionId] : []),
      ...(model ? ["--model", model] : []),
      "--agent", "security-audit-orchestrator",
      "--dir", paths.workspace_root,
      "--title", audit.name,
      prompt,
    ];
    audit.execution_transport = "opencode-run";
    try {
      const probe = await this.terminalMonitor.probe();
      if (typeof probe.opencode_command === "string" && probe.opencode_command) {
        this.command = probe.opencode_command;
        command = probe.opencode_command;
      }
      if (!probe.available) {
        audit.terminal = { backend: probe.backend ?? "terminal-multiplexer", supported: false, status: "unavailable", live: false, message: probe.message };
        await this.record(audit, "audit.terminal.unavailable", { message: redact(probe.message) });
      } else {
        audit.terminal = { backend: probe.backend ?? "tmux", supported: true, status: "starting", live: false, message: `正在通过 ${probe.backend ?? "tmux"} 启动隔离 OpenCode run。` };
        await this.record(audit, "audit.terminal.starting", {});
        audit.terminal = await this.terminalMonitor.start({
          audit,
          repository,
          environment,
          executionDirectory: paths.workspace_root,
          providerSessionId: sessionId,
          args,
        });
        audit.execution_transport = audit.terminal.transport;
        audit.provider_session_id = providerSessionId(audit.terminal.provider_session_id);
        if (!isAbsolute(audit.terminal.relay_spec_path ?? "")) throw new Error("终端输出中继配置缺失。");
        command = process.execPath;
        args = [TERMINAL_OUTPUT_RELAY, audit.terminal.relay_spec_path];
        await this.record(audit, "audit.terminal.ready", {
          backend: audit.terminal.backend,
          target: audit.terminal.target,
          provider_session_id: audit.terminal.provider_session_id,
          resumed: resume,
        });
      }
    } catch (error) {
      await this.terminalMonitor.stop(audit.terminal).catch(() => {});
      audit.terminal = { backend: audit.terminal?.backend ?? "terminal-multiplexer", supported: false, status: "error", live: false, message: `终端监控启动失败，已回退普通 Runner：${redact(error.message)}` };
      audit.execution_transport = "opencode-run";
      await this.record(audit, "audit.terminal.failed", { message: audit.terminal.message });
    }
    const taskBoardService = this.taskBoardServices.get(audit.id);
    if (taskBoardService) { taskBoardService.command = this.command; taskBoardService.resume(); }
    const runtimeService = this.runtimeTestingServices.get(audit.id);
    if (runtimeService) {
      runtimeService.command = this.command;
      await runtimeService.contact();
    }
    if (audit.status === "cancelled" || audit.product_campaign_id && this.productCampaignGuard && !this.productCampaignGuard(audit.product_campaign_id)) throw Object.assign(new Error("产品批次已暂停或取消，未启动审计 Agent。"), { code: "product-campaign-not-running" });
    const child = this.spawnProcess(command, args, {
      cwd: paths.workspace_root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    this.processes.set(audit.id, child);
    audit.status = "running";
    audit.pid = child.pid ?? null;
    const startedEvent = this.record(audit, "audit.started", { pid: audit.pid });
    const capture = (stream, source) => {
      let buffer = "";
      stream?.setEncoding?.("utf8");
      stream?.on("data", chunk => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          this.captureProviderSession(audit, line).catch(() => {});
          this.observeOperationTimeout(audit, source, line);
          this.observeContextWindowOverflow(audit, source, line);
          this.recordLog(audit, source, line).catch(() => {});
        }
      });
      stream?.on("end", () => {
        if (!buffer) return;
        this.captureProviderSession(audit, buffer).catch(() => {});
        this.observeOperationTimeout(audit, source, buffer);
        this.observeContextWindowOverflow(audit, source, buffer);
        this.recordLog(audit, source, buffer).catch(() => {});
      });
    };
    capture(child.stdout, "stdout");
    capture(child.stderr, "stderr");
    child.once("error", error => {
      if (this.processes.get(audit.id) !== child) return;
      audit.error = redact(error.message);
    });
    child.once("close", (code, signal) => {
      this.clearOperationTimeoutTerminationGuard(audit.id, child);
      this.clearContextTerminationGuard(audit.id, child);
      if (this.processes.get(audit.id) !== child) return;
      const completion = startedEvent.then(async () => {
        await this.stopTaskBoard(audit);
        await this.stopRuntimeTesting(audit);
        this.processes.delete(audit.id);
        audit.pid = null;
        if ((audit.status === "completed" || audit.status === "failed" && hasNoTaskReports(audit)) && audit.completion_source === "todo-artifact-watchdog") {
          audit.exit_code ??= code ?? 0;
          audit.finished_at ??= new Date().toISOString();
          await this.finalizeTerminal(audit).catch(error => {
            audit.terminal = { ...(audit.terminal ?? {}), live: false, status: "error", message: `终端归档失败：${redact(error.message)}` };
          });
          return this.record(audit, "audit.runner.stopped", { exit_code: code, signal: signal ?? null, reason: "todo-artifact-watchdog" });
        }
        audit.exit_code = code;
        audit.finished_at = new Date().toISOString();
        const timeoutState = audit.timeout_recovery?.state;
        const timedOut = (audit.status === "cancelling" && audit.interruption_reason === OPERATION_TIMEOUT_RECOVERY_REASON)
          || ["observed", "interrupting", "waiting-for-runner-exit", "waiting-for-runner-close"].includes(timeoutState);
        const contextState = audit.context_window_recovery?.state;
        const contextExceeded = (audit.status === "cancelling" && audit.interruption_reason === CONTEXT_WINDOW_RECOVERY_REASON)
          || ["observed", "interrupting", "waiting-for-runner-exit", "waiting-for-runner-close"].includes(contextState);
        if (timedOut && audit.status === "running") {
          audit.status = "interrupted";
          audit.interruption_reason = OPERATION_TIMEOUT_RECOVERY_REASON;
        }
        if (contextExceeded && audit.status === "running") {
          audit.status = "interrupted";
          audit.interruption_reason = CONTEXT_WINDOW_RECOVERY_REASON;
        }
        if (audit.status === "cancelling" && (audit.interruption_reason === "workbench-shutdown" || timedOut || contextExceeded)) audit.status = "interrupted";
        else if (audit.status === "cancelling") audit.status = "cancelled";
        else if (code === 0 && audit.stage_delivery_enforcement === "ENFORCED") {
          try {
            const verification = await this.stageDeliveryVerifier({ reportsRoot: audit.paths.reports_root, auditId: audit.id });
            audit.stage_delivery = {
              enforcement: verification.enforcement ?? "ENFORCED",
              complete: verification.complete === true,
              completed_count: Number(verification.completed_count ?? 0),
              stages: verification.stages ?? [],
              errors: (verification.errors ?? []).slice(0, 100),
              verified_at: new Date().toISOString(),
            };
            if (verification.complete) {
              audit.status = "completed";
            } else {
              audit.status = "interrupted";
              audit.interruption_reason = "stage-delivery-incomplete";
              audit.error = `OpenCode 已正常退出，但八环节物化交付门禁仅完成 ${audit.stage_delivery.completed_count}/8；请从最早未完成环节恢复。`;
            }
          } catch (error) {
            audit.status = "interrupted";
            audit.interruption_reason = "stage-delivery-verification-failed";
            audit.error = `OpenCode 已正常退出，但八环节交付校验器失败：${redact(error.message)}`;
          }
        }
        else if (code === 0 && audit.stage_delivery_enforcement === "TODO_ENFORCED") {
          try {
            const verification = await this.verifyTodoCompletion(audit);
            if (verification.complete) {
              audit.status = hasNoTaskReports(audit) ? "failed" : "completed";
              audit.error = hasNoTaskReports(audit) ? NO_TASK_REPORTS_MESSAGE : null;
              audit.interruption_reason = null;
            } else {
              audit.status = "interrupted";
              audit.interruption_reason = "local-audit-todo-incomplete";
              audit.error = `OpenCode 已正常退出，但本地调度任务尚未完成：${audit.todo_completion.errors.join("；")}`;
            }
          } catch (error) {
            audit.status = "interrupted";
            audit.interruption_reason = "local-audit-todo-verification-failed";
            audit.error = `OpenCode 已正常退出，但本地调度任务校验失败：${redact(error.message)}`;
          }
        }
        else if (code === 0) audit.status = "completed";
        else audit.status = "interrupted";
        if (signal && !audit.error) audit.error = `进程由信号 ${signal} 结束。`;
        if (audit.status === "interrupted") {
          audit.interrupted_at = audit.finished_at;
          audit.interruption_reason ||= signal ? "runner-signalled" : "runner-exited";
          audit.error ||= `Runner 异常退出（exit code ${code ?? "null"}），可从当前检查点恢复。`;
          if (timedOut) audit.timeout_recovery = { ...(audit.timeout_recovery ?? {}), state: "waiting-to-recover", interrupted_at: audit.interrupted_at };
          if (contextExceeded) audit.context_window_recovery = { ...(audit.context_window_recovery ?? {}), state: "waiting-to-compact", interrupted_at: audit.interrupted_at };
        }
        await this.finalizeTerminal(audit).catch(error => {
          audit.terminal = { ...(audit.terminal ?? {}), live: false, status: "error", message: `终端归档失败：${redact(error.message)}` };
        });
        await this.record(audit, `audit.${audit.status}`, { exit_code: code, signal: signal ?? null });
        if (timedOut) this.scheduleOperationTimeoutRecovery(audit, audit.timeout_recovery?.attempts);
        if (contextExceeded) this.scheduleContextWindowRecovery(audit, audit.context_window_recovery?.attempts);
      });
      this.completions.set(audit.id, completion);
      completion.finally(() => { if (this.completions.get(audit.id) === completion) this.completions.delete(audit.id); }).catch(() => {});
    });
    await startedEvent;
  }

  async captureProviderSession(audit, line) {
    if (audit.provider_session_id) return;
    let value;
    try { value = JSON.parse(line); } catch { return; }
    const sessionId = providerSessionId(value?.sessionID ?? value?.session_id ?? value?.session?.id);
    if (!sessionId || audit.provider_session_id) return;
    audit.provider_session_id = sessionId;
    if (audit.terminal) {
      audit.terminal.provider_session_id = sessionId;
      audit.terminal.opencode_command = `opencode -s ${sessionId}`;
    }
    await this.record(audit, "audit.session.bound", { provider_session_id: sessionId });
  }

  async recordLog(audit, source, line) {
    const message = redact(line, await this.redactionsForAudit(audit));
    if (!message) return;
    const entry = { occurred_at: new Date().toISOString(), source, message };
    await appendFile(join(this.stateRoot, audit.id, "runner.log.jsonl"), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    await this.record(audit, "agent.output", entry, { bumpVersion: false });
    this.observeOperationTimeout(audit, source, message, entry);
    this.observeContextWindowOverflow(audit, source, message, entry);
  }

  markContextWindowOverflowObserved(audit, source, line) {
    if (!audit || !CONTEXT_WINDOW_PATTERN.test(String(line ?? ""))) return null;
    const prior = audit.context_window_recovery ?? {};
    if (["interrupting", "waiting-for-runner-exit", "waiting-to-compact", "compacting", "recovering"].includes(prior.state)) return null;
    let eventSessionId = null;
    try {
      const event = JSON.parse(String(line));
      eventSessionId = providerSessionId(event?.sessionID ?? event?.session_id ?? event?.part?.sessionID);
    } catch {}
    const entry = { occurred_at: new Date().toISOString(), source, message: "This model's maximum input length is exceeded", session_id: eventSessionId };
    audit.context_window_recovery = {
      ...prior,
      state: "observed",
      last_observed_at: entry.occurred_at,
      last_message: entry.message,
      last_source: source,
      session_id: eventSessionId ?? prior.session_id ?? null,
    };
    return entry;
  }

  observeContextWindowOverflow(audit, source, line, recordedEntry = null) {
    const entry = this.markContextWindowOverflowObserved(audit, source, line);
    if (!entry) return false;
    this.handleContextWindowOverflow(audit, recordedEntry ?? entry).catch(() => {});
    return true;
  }

  async handleContextWindowOverflow(audit, entry) {
    if (!this.enabled || !audit || this.contextRecoveryPending.has(audit.id)) return false;
    const prior = audit.context_window_recovery ?? {};
    const attempts = Number(prior.attempts ?? 0);
    if (attempts >= MAX_CONTEXT_WINDOW_RECOVERIES) {
      audit.context_window_recovery = { ...prior, state: "exhausted", last_detected_at: entry.occurred_at };
      await this.record(audit, "audit.context-window.recovery.exhausted", { attempts, limit: MAX_CONTEXT_WINDOW_RECOVERIES });
      return false;
    }
    const sessionId = providerSessionId(prior.session_id ?? audit.provider_session_id ?? audit.terminal?.provider_session_id);
    if (!sessionId) {
      audit.context_window_recovery = { ...prior, state: "blocked", last_detected_at: entry.occurred_at, last_error: "provider-session-id-missing" };
      await this.record(audit, "audit.context-window.recovery.blocked", { reason: "provider-session-id-missing" });
      return false;
    }
    if (audit.status !== "running") return false;
    const attempt = attempts + 1;
    this.contextRecoveryPending.add(audit.id);
    audit.context_window_recovery = {
      ...prior,
      attempts: attempt,
      state: "interrupting",
      last_detected_at: entry.occurred_at,
      last_source: entry.source,
      last_error: null,
    };
    audit.interruption_reason = CONTEXT_WINDOW_RECOVERY_REASON;
    audit.status = "cancelling";
    await this.record(audit, "audit.context-window.detected", { attempt, source: entry.source, provider_session_id: sessionId });
    const child = this.processes.get(audit.id);
    if (audit.terminal?.live) {
      await this.terminalMonitor.abort(audit.terminal, audit.paths?.workspace_root).catch(error => this.recordLog(audit, "stderr", `上下文 watchdog 无法中止隔离 OpenCode session：${error.message}`));
    }
    if (child) {
      const signalled = child.kill?.("SIGTERM") === true;
      this.scheduleContextTerminationGuard(audit, child, attempt);
      if (signalled) return true;
      audit.context_window_recovery = { ...audit.context_window_recovery, state: "waiting-for-runner-exit" };
      await this.record(audit, "audit.context-window.recovery.waiting", { attempt, message: "等待 Runner 退出后执行 /compact。" });
      return false;
    }
    audit.status = "interrupted";
    audit.finished_at = new Date().toISOString();
    audit.interrupted_at = audit.finished_at;
    audit.context_window_recovery = { ...audit.context_window_recovery, state: "waiting-to-compact" };
    await this.record(audit, "audit.context-window.recovery.waiting", { attempt, message: "Runner 已退出，准备执行 /compact。" });
    this.scheduleContextWindowRecovery(audit, attempt);
    return true;
  }

  markOperationTimeoutObserved(audit, source, line) {
    if (!audit || !OPERATION_TIMEOUT_PATTERN.test(String(line ?? ""))) return null;
    const prior = audit.timeout_recovery ?? {};
    if (["interrupting", "waiting-for-runner-exit", "waiting-to-recover", "recovering"].includes(prior.state)) return null;
    const entry = {
      occurred_at: new Date().toISOString(),
      source,
      message: "The operation timed out",
    };
    audit.timeout_recovery = {
      ...prior,
      state: "observed",
      last_observed_at: entry.occurred_at,
      last_message: "The operation timed out",
      last_source: source,
    };
    return entry;
  }

  observeOperationTimeout(audit, source, line, recordedEntry = null) {
    const entry = this.markOperationTimeoutObserved(audit, source, line);
    if (!entry) return false;
    this.handleOperationTimeout(audit, recordedEntry ?? entry).catch(() => {});
    return true;
  }

  async handleOperationTimeout(audit, entry) {
    if (!this.enabled || !audit) return false;
    if (this.timeoutRecoveryPending.has(audit.id)) return false;
    const prior = audit.timeout_recovery ?? {};
    const attempts = Number(prior.attempts ?? 0);
    if (attempts >= MAX_OPERATION_TIMEOUT_RECOVERIES) {
      audit.timeout_recovery = {
        ...prior,
        state: "exhausted",
        last_detected_at: entry.occurred_at,
        last_message: "The operation timed out",
      };
      await this.record(audit, "audit.timeout.recovery.exhausted", { attempts, limit: MAX_OPERATION_TIMEOUT_RECOVERIES });
      return false;
    }

    const attempt = attempts + 1;
    this.timeoutRecoveryPending.add(audit.id);
    if (audit.status === "interrupted" && !this.processes.has(audit.id)) {
      audit.timeout_recovery = {
        ...prior,
        attempts: attempt,
        state: "waiting-to-recover",
        last_detected_at: entry.occurred_at,
        last_message: "The operation timed out",
        last_source: entry.source,
        last_error: null,
      };
      await this.record(audit, "audit.timeout.detected", { attempt, source: entry.source, message: "The operation timed out" });
      this.scheduleOperationTimeoutRecovery(audit, attempt);
      return true;
    }
    if (audit.status !== "running") {
      this.timeoutRecoveryPending.delete(audit.id);
      return false;
    }
    audit.timeout_recovery = {
      ...prior,
      attempts: attempt,
      state: "interrupting",
      last_detected_at: entry.occurred_at,
      last_message: "The operation timed out",
      last_source: entry.source,
      last_error: null,
    };
    audit.interruption_reason = OPERATION_TIMEOUT_RECOVERY_REASON;
    audit.status = "cancelling";
    await this.record(audit, "audit.timeout.detected", { attempt, source: entry.source, message: "The operation timed out" });
    const child = this.processes.get(audit.id);
    if (audit.terminal?.live) {
      await this.terminalMonitor.abort(audit.terminal, audit.paths?.workspace_root).catch(error => this.recordLog(audit, "stderr", `超时 watchdog 无法中止隔离 OpenCode session：${error.message}`));
    }
    if (child) {
      const signalled = child.kill?.("SIGTERM") === true;
      this.scheduleOperationTimeoutTerminationGuard(audit, child, attempt);
      if (signalled) return true;
      audit.timeout_recovery = { ...audit.timeout_recovery, state: "waiting-for-runner-exit" };
      await this.record(audit, "audit.timeout.recovery.waiting", { attempt, message: "结束信号未被 Runner 接受，等待其自行退出后恢复。" });
      return false;
    }

    if (this.completions.has(audit.id)) {
      audit.timeout_recovery = { ...audit.timeout_recovery, state: "waiting-for-runner-exit" };
      await this.record(audit, "audit.timeout.recovery.waiting", { attempt, message: "Runner 正在结束，待进程退出后自动恢复。" });
      return false;
    }

    audit.status = "interrupted";
    audit.finished_at = new Date().toISOString();
    audit.interrupted_at = audit.finished_at;
    audit.interruption_reason = OPERATION_TIMEOUT_RECOVERY_REASON;
    audit.error = "检测到 The operation timed out，Runner 已结束；watchdog 将从当前检查点自动恢复。";
    audit.timeout_recovery = { ...audit.timeout_recovery, state: "waiting-to-recover", last_error: null };
    await this.record(audit, "audit.timeout.recovery.waiting", { attempt, message: audit.error });
    this.scheduleOperationTimeoutRecovery(audit, attempt);
    return true;
  }

  clearOperationTimeoutTerminationGuard(auditId, child = null) {
    const current = this.timeoutTerminationTimers.get(auditId);
    if (!current || (child && current.child !== child)) return;
    clearTimeout(current.timer);
    this.timeoutTerminationTimers.delete(auditId);
  }

  scheduleOperationTimeoutTerminationGuard(audit, child, attempt) {
    if (!audit || !child || this.timeoutTerminationTimers.has(audit.id)) return;
    const timer = setTimeout(() => {
      this.timeoutTerminationTimers.delete(audit.id);
      this.forceOperationTimeoutInterruption(audit.id, child, attempt).catch(() => {});
    }, this.timeoutTerminationGraceMs);
    timer.unref?.();
    this.timeoutTerminationTimers.set(audit.id, { timer, child });
  }

  async forceOperationTimeoutInterruption(auditId, child, attempt) {
    const audit = this.audits.get(auditId);
    if (!audit || this.processes.get(auditId) !== child
      || audit.interruption_reason !== OPERATION_TIMEOUT_RECOVERY_REASON
      || audit.timeout_recovery?.attempts !== attempt
      || !["interrupting", "waiting-for-runner-exit", "waiting-for-runner-close"].includes(audit.timeout_recovery?.state)) {
      return false;
    }
    try { child.kill?.("SIGKILL"); } catch {}
    this.processes.delete(auditId);
    audit.pid = null;
    audit.status = "interrupted";
    audit.finished_at = new Date().toISOString();
    audit.interrupted_at = audit.finished_at;
    audit.error = "检测到 The operation timed out；Runner 中继在宽限期内未退出，已强制收敛并将从当前检查点恢复。";
    audit.timeout_recovery = {
      ...audit.timeout_recovery,
      state: "waiting-to-recover",
      forced_at: audit.finished_at,
      last_error: null,
    };
    if (audit.terminal?.supported && audit.terminal?.socket_name) {
      await this.terminalMonitor.stop(audit.terminal).catch(() => {});
      audit.terminal.live = false;
      audit.terminal.status = "closed";
      audit.terminal.message = "超时 Runner 未自行结束，隔离终端已由 watchdog 收敛。";
      audit.terminal.closed_at = audit.finished_at;
    }
    await this.record(audit, "audit.timeout.recovery.waiting", { attempt, forced: true, message: audit.error });
    this.scheduleOperationTimeoutRecovery(audit, attempt);
    return true;
  }

  scheduleOperationTimeoutRecovery(audit, attempt) {
    if (!this.timeoutRecoveryPending.has(audit.id) || this.timeoutRecoveryTimers.has(audit.id)) return;
    const timer = setTimeout(() => {
      this.timeoutRecoveryTimers.delete(audit.id);
      this.runOperationTimeoutRecovery(audit.id, attempt).catch(() => {});
    }, 0);
    timer.unref?.();
    this.timeoutRecoveryTimers.set(audit.id, timer);
  }

  async runOperationTimeoutRecovery(auditId, attempt) {
    let audit = this.audits.get(auditId);
    if (!audit || audit.status !== "interrupted" || audit.timeout_recovery?.attempts !== attempt) {
      this.timeoutRecoveryPending.delete(auditId);
      return false;
    }
    // The close handler schedules recovery before its completion promise's
    // finally handler removes this entry.  Waiting here prevents recovery from
    // rejecting itself as a residual Runner/completion and makes the timeout
    // path deterministic instead of timing dependent.
    const closing = this.completions.get(auditId);
    if (closing) {
      await closing.catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
      audit = this.audits.get(auditId);
      if (!audit || audit.status !== "interrupted" || audit.timeout_recovery?.attempts !== attempt) {
        this.timeoutRecoveryPending.delete(auditId);
        return false;
      }
    }
    audit.timeout_recovery = { ...audit.timeout_recovery, state: "recovering", last_recovery_requested_at: new Date().toISOString() };
    await this.record(audit, "audit.timeout.recovery.requested", { attempt });
    try {
      await this.action(audit.id, "recover", audit.version, `watchdog-timeout-recover:${audit.id}:${attempt}`);
      audit.timeout_recovery = { ...audit.timeout_recovery, state: "restarted", last_recovered_at: new Date().toISOString(), last_error: null };
      await this.record(audit, "audit.timeout.recovery.started", { attempt, recovery_count: audit.recovery_count });
      return true;
    } catch (error) {
      const message = redact(error.message);
      audit.timeout_recovery = { ...audit.timeout_recovery, state: "failed", last_error: message, last_failed_at: new Date().toISOString() };
      await this.record(audit, "audit.timeout.recovery.failed", { attempt, message });
      return false;
    } finally {
      this.timeoutRecoveryPending.delete(auditId);
    }
  }

  clearContextTerminationGuard(auditId, child = null) {
    const current = this.contextTerminationTimers.get(auditId);
    if (!current || (child && current.child !== child)) return;
    clearTimeout(current.timer);
    this.contextTerminationTimers.delete(auditId);
  }

  scheduleContextTerminationGuard(audit, child, attempt) {
    if (!audit || !child || this.contextTerminationTimers.has(audit.id)) return;
    const timer = setTimeout(() => {
      this.contextTerminationTimers.delete(audit.id);
      this.forceContextWindowInterruption(audit.id, child, attempt).catch(() => {});
    }, this.timeoutTerminationGraceMs);
    timer.unref?.();
    this.contextTerminationTimers.set(audit.id, { timer, child });
  }

  async forceContextWindowInterruption(auditId, child, attempt) {
    const audit = this.audits.get(auditId);
    if (!audit || this.processes.get(auditId) !== child
      || audit.interruption_reason !== CONTEXT_WINDOW_RECOVERY_REASON
      || audit.context_window_recovery?.attempts !== attempt
      || !["interrupting", "waiting-for-runner-exit", "waiting-for-runner-close"].includes(audit.context_window_recovery?.state)) {
      return false;
    }
    try { child.kill?.("SIGKILL"); } catch {}
    this.processes.delete(auditId);
    audit.pid = null;
    audit.status = "interrupted";
    audit.finished_at = new Date().toISOString();
    audit.interrupted_at = audit.finished_at;
    audit.error = "检测到模型上下文达到上限；Runner 在宽限期内未退出，已强制收敛并准备执行 /compact。";
    audit.context_window_recovery = { ...audit.context_window_recovery, state: "waiting-to-compact", forced_at: audit.finished_at, last_error: null };
    if (audit.terminal?.supported && audit.terminal?.socket_name) {
      await this.terminalMonitor.stop(audit.terminal).catch(() => {});
      audit.terminal.live = false;
      audit.terminal.status = "closed";
      audit.terminal.message = "上下文溢出 Runner 未自行结束，隔离终端已由 watchdog 收敛。";
      audit.terminal.closed_at = audit.finished_at;
    }
    await this.record(audit, "audit.context-window.recovery.waiting", { attempt, forced: true, message: audit.error });
    this.scheduleContextWindowRecovery(audit, attempt);
    return true;
  }

  scheduleContextWindowRecovery(audit, attempt) {
    if (!this.contextRecoveryPending.has(audit.id) || this.contextRecoveryTimers.has(audit.id)) return;
    const timer = setTimeout(() => {
      this.contextRecoveryTimers.delete(audit.id);
      this.runContextWindowRecovery(audit.id, attempt).catch(() => {});
    }, 0);
    timer.unref?.();
    this.contextRecoveryTimers.set(audit.id, timer);
  }

  async compactOpenCodeSession(audit) {
    const sessionId = providerSessionId(audit.context_window_recovery?.session_id ?? audit.provider_session_id ?? audit.terminal?.provider_session_id);
    if (!sessionId) throw new Error("provider-session-id-missing");
    const repository = this.repositoryForAudit(audit);
    if (!repository) throw new Error("audit-repository-not-found");
    const workspaceRoot = audit.paths?.workspace_root;
    if (!isAbsolute(workspaceRoot ?? "")) throw new Error("audit-workspace-root-missing");
    const proxyEnvironment = await this.verifiedPrivateProxyEnvironment(audit);
    const environment = await buildOpenCodeEnvironment(repository.config_path, { ...this.environment, ...proxyEnvironment });
    await this.compactSessionRunner(this.command, [
      "run", "--format", "json",
      "--session", sessionId,
      "--command", "compact",
      "--dir", workspaceRoot,
    ], {
      cwd: workspaceRoot,
      env: environment,
      encoding: "utf8",
      timeout: CONTEXT_COMPACTION_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return sessionId;
  }

  async runContextWindowRecovery(auditId, attempt) {
    let audit = this.audits.get(auditId);
    if (!audit || audit.status !== "interrupted" || audit.context_window_recovery?.attempts !== attempt) {
      this.contextRecoveryPending.delete(auditId);
      return false;
    }
    const closing = this.completions.get(auditId);
    if (closing) {
      await closing.catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
      audit = this.audits.get(auditId);
      if (!audit || audit.status !== "interrupted" || audit.context_window_recovery?.attempts !== attempt) {
        this.contextRecoveryPending.delete(auditId);
        return false;
      }
    }
    audit.context_window_recovery = { ...audit.context_window_recovery, state: "compacting", compaction_started_at: new Date().toISOString() };
    await this.record(audit, "audit.context-window.compaction.started", { attempt, command: "/compact" });
    try {
      const sessionId = await this.compactOpenCodeSession(audit);
      audit.context_window_recovery = { ...audit.context_window_recovery, state: "compacted", compacted_at: new Date().toISOString(), last_error: null };
      await this.record(audit, "audit.context-window.compaction.completed", { attempt, provider_session_id: sessionId });
      audit.context_window_recovery = { ...audit.context_window_recovery, state: "recovering", last_recovery_requested_at: new Date().toISOString() };
      await this.action(audit.id, "recover", audit.version, `watchdog-context-window-recover:${audit.id}:${attempt}`);
      audit.context_window_recovery = { ...audit.context_window_recovery, state: "restarted", last_recovered_at: new Date().toISOString(), last_error: null };
      await this.record(audit, "audit.context-window.recovery.started", { attempt, recovery_count: audit.recovery_count });
      return true;
    } catch (error) {
      const message = redact(error.message);
      audit.context_window_recovery = { ...audit.context_window_recovery, state: "failed", last_error: message, last_failed_at: new Date().toISOString() };
      audit.error = `上下文压缩或断点恢复失败：${message}`;
      await this.record(audit, "audit.context-window.recovery.failed", { attempt, message });
      return false;
    } finally {
      this.contextRecoveryPending.delete(auditId);
    }
  }

  async finalizeTerminal(audit) {
    if (!audit.terminal?.supported || !audit.terminal?.socket_name) return;
    let captured = "";
    try {
      captured = redactTerminalOutput(await this.terminalMonitor.capture(audit.terminal, 1000), await this.redactionsForAudit(audit));
      if (captured) await writeFile(join(this.stateRoot, audit.id, "terminal.txt"), `${captured}\n`, { encoding: "utf8", mode: 0o600 });
    } finally {
      try {
        await this.terminalMonitor.stop(audit.terminal);
      } finally {
        audit.terminal.live = false;
        audit.terminal.status = captured ? "archived" : "closed";
        audit.terminal.message = captured ? "OpenCode run 已结束，当前显示最终只读快照。" : "OpenCode run 已结束且没有可归档画面。";
        audit.terminal.closed_at = new Date().toISOString();
      }
    }
  }

  async terminalSnapshot(id) {
    await this.ready;
    const audit = this.audits.get(id);
    if (!audit) throw Object.assign(new Error("审计不存在。"), { statusCode: 404, code: "audit-not-found" });
    const terminal = audit.terminal;
    const sessionId = providerSessionId(audit.provider_session_id ?? terminal?.provider_session_id);
    const sessionConnection = {
      provider_session_id: sessionId,
      opencode_command: sessionId ? `opencode -s ${sessionId}` : null,
    };
    if (!terminal?.supported) {
      return { available: false, live: false, status: terminal?.status ?? "unavailable", target: null, attach_command: null, ...sessionConnection, output: "", message: terminal?.message ?? "该任务未启用 OpenCode 终端监控。" };
    }
    if (terminal.live) {
      try {
        const output = redactTerminalOutput(await this.terminalMonitor.capture(terminal), await this.redactionsForAudit(audit));
        return { available: true, live: true, status: terminal.status, target: terminal.target, attach_command: terminal.attach_command, ...sessionConnection, output, message: terminal.message, columns: terminal.columns ?? null, rows: terminal.rows ?? null };
      } catch (error) {
        return { available: false, live: false, status: "disconnected", target: terminal.target, attach_command: terminal.attach_command, ...sessionConnection, output: "", message: `终端窗口暂时不可读：${redact(error.message)}` };
      }
    }
    try {
      const output = redactTerminalOutput(await readFile(join(this.stateRoot, id, "terminal.txt"), "utf8"), await this.redactionsForAudit(audit));
      return { available: true, live: false, status: terminal.status, target: terminal.target, attach_command: null, ...sessionConnection, output, message: terminal.message };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return { available: false, live: false, status: terminal.status, target: terminal.target, attach_command: null, ...sessionConnection, output: "", message: terminal.message };
    }
  }

  async resizeTerminal(id, columns, rows) {
    await this.ready;
    const audit = this.audits.get(id);
    if (!audit) throw Object.assign(new Error("审计不存在。"), { statusCode: 404, code: "audit-not-found" });
    if (!audit.terminal?.supported || !audit.terminal?.live || typeof this.terminalMonitor.resize !== "function") {
      throw Object.assign(new Error("该审计当前没有可调整的实时终端窗口。"), { statusCode: 409, code: "terminal-not-live" });
    }
    if (!Number.isInteger(columns) || columns < 40 || columns > 320 || !Number.isInteger(rows) || rows < 12 || rows > 120) {
      throw Object.assign(new Error("终端尺寸必须是 40-320 列、12-120 行范围内的整数。"), { statusCode: 422, code: "terminal-size-invalid" });
    }
    await this.enqueue(id, async () => {
      const size = await this.terminalMonitor.resize(audit.terminal, columns, rows);
      audit.terminal.columns = size.columns;
      audit.terminal.rows = size.rows;
      audit.terminal.resized_at = new Date().toISOString();
      await this.persist(audit);
    });
    return this.terminalSnapshot(id);
  }

  async action(id, action, expectedVersion, idempotencyKey) {
    await this.ready;
    if (!idempotencyKey || idempotencyKey.length > 200) throw Object.assign(new Error("缺少有效的 Idempotency-Key。"), { statusCode: 400, code: "idempotency-key-required" });
    const audit = this.audits.get(id);
    if (!audit) throw Object.assign(new Error("审计不存在。"), { statusCode: 404, code: "audit-not-found" });
    const actionDigest = createHash("sha256").update(idempotencyKey).digest("hex");
    if ((audit.action_idempotency_digests ?? []).includes(actionDigest)) return publicAudit(audit);
    if (Number(expectedVersion) !== audit.version) throw Object.assign(new Error("审计版本已变化，请刷新后重试。"), { statusCode: 412, code: "version-mismatch" });
    if (action === "recover") {
      if (hasNoTaskReports(audit)) {
        throw Object.assign(new Error(NO_TASK_REPORTS_MESSAGE), { statusCode: 409, code: "task-board-no-reports" });
      }
      if (await this.reconcileTerminalCompletion(audit, "recovery-preflight")) return publicAudit(audit);
      if (!this.enabled) throw Object.assign(new Error("运行驱动未启用，不能恢复审计。"), { statusCode: 503, code: "runner-disabled" });
      if (!RECOVERABLE.has(audit.status) || this.processes.has(id) || this.completions.has(id)) {
        throw Object.assign(new Error("只有已中断、失败或已取消且没有残留 Runner 的审计可以断点恢复。"), { statusCode: 409, code: "audit-not-recoverable" });
      }
      const repository = this.repositoryForAudit(audit);
      if (!repository) throw Object.assign(new Error("审计所属源码对象不可用。"), { statusCode: 422, code: "repository-not-allowed" });
      const facts = await this.repositoryFacts(repository);
      if (!facts.config_valid) {
        throw Object.assign(new Error("项目目录或工作台 OpenCode 配置已不可用，不能恢复。"), { statusCode: 422, code: "repository-not-ready" });
      }
      if (audit.source_kind === "directory") {
        try {
          const [canonical, info] = await Promise.all([realpath(repository.path), stat(repository.path)]);
          if (!info.isDirectory() || canonical !== repository.path) throw new Error("source-path-drift");
        } catch {
          throw Object.assign(new Error("源码范围不存在、不可读取或目录链接已变化，不能恢复。"), { statusCode: 422, code: "target-source-unavailable" });
        }
      } else {
        if (!facts.git_repository) throw Object.assign(new Error("项目目录缺少 Git 元数据，不能恢复。"), { statusCode: 422, code: "repository-not-ready" });
        if (facts.commit !== audit.commit) {
          throw Object.assign(new Error(`源码目录已不在原提交 ${audit.commit}，工作台不会自动 checkout。`), { statusCode: 409, code: "recovery-source-commit-changed" });
        }
        if (facts.dirty && audit.allow_dirty === false) {
          throw Object.assign(new Error("源码目录在任务中断后出现未提交修改；为避免恢复到不同代码，已拒绝继续。"), { statusCode: 409, code: "recovery-source-dirty" });
        }
      }

      const existingSessionId = providerSessionId(audit.provider_session_id ?? audit.terminal?.provider_session_id);
      if (audit.terminal?.live) {
        await this.terminalMonitor.abort(audit.terminal, audit.paths?.workspace_root).catch(error => this.recordLog(audit, "stderr", `旧 OpenCode session 中止确认失败，将继续关闭该任务的隔离 tmux：${error.message}`));
      }
      if (audit.terminal?.supported && audit.terminal?.socket_name) {
        await this.terminalMonitor.stop(audit.terminal);
        audit.terminal.live = false;
        audit.terminal.status = "closed";
      }

      audit.recovery_count = Number(audit.recovery_count ?? 0) + 1;
      audit.last_recovered_at = new Date().toISOString();
      audit.action_idempotency_digests = [...(audit.action_idempotency_digests ?? []), actionDigest].slice(-100);
      await this.record(audit, "audit.recovery.requested", {
        recovery_count: audit.recovery_count,
        recovery_mode: existingSessionId ? "session-and-artifacts" : "artifacts",
        provider_session_id: existingSessionId,
      });
      audit.status = "queued";
      audit.queue = {
        mode: "recover",
        enqueued_at: new Date().toISOString(),
        provider_session_id: existingSessionId,
      };
      await this.record(audit, "audit.recovery.queued", { recovery_count: audit.recovery_count });
      if (this.queueScheduler) {
        const queued = typeof this.queueScheduler.enqueueRecoveryAudit === "function"
          ? await this.queueScheduler.enqueueRecoveryAudit(audit.id)
          : await this.queueScheduler.enqueueNewAudit();
        if (queued) return publicAudit(audit);
      }
      try {
        await this.dispatchQueuedAudit(audit.id);
      } catch (error) {
        throw Object.assign(new Error(`断点恢复启动失败：${audit.error ?? redact(error.message)}`), { statusCode: 502, code: "audit-recovery-launch-failed" });
      }
      return publicAudit(audit);
    }
    if (action === "cancel" && audit.product_campaign_id && ["queued", "preparing", "recovering"].includes(audit.status) && !this.processes.has(id)) {
      audit.status = "cancelled"; audit.finished_at = new Date().toISOString(); audit.error = null;
      audit.action_idempotency_digests = [...(audit.action_idempotency_digests ?? []), actionDigest].slice(-100);
      await this.record(audit, "audit.cancelled", { reason: "cancelled-before-agent-start" });
      return publicAudit(audit);
    }
    const child = this.processes.get(id);
    if (!child || TERMINAL.has(audit.status)) throw Object.assign(new Error("审计当前不可执行该操作。"), { statusCode: 409, code: "action-not-allowed" });
    if (action === "pause" && audit.status === "running") {
      await this.taskBoardServices.get(id)?.pause();
      await this.stopRuntimeTesting(audit);
      audit.status = "pausing";
      await this.record(audit, "audit.pausing", {});
      if (!child.kill("SIGSTOP")) { this.taskBoardServices.get(id)?.resume(); throw new Error("暂停信号发送失败。"); }
      try {
        if (audit.terminal?.live) await this.terminalMonitor.signalRun(audit.terminal, "SIGSTOP");
      } catch (error) {
        child.kill("SIGCONT");
        audit.status = "running";
        this.taskBoardServices.get(id)?.resume();
        await this.record(audit, "audit.pause_failed", { message: redact(error.message) });
        throw new Error(`OpenCode run 暂停失败：${error.message}`);
      }
      audit.status = "paused";
      await this.record(audit, "audit.paused", {});
    } else if (action === "resume" && audit.status === "paused") {
      if (audit.terminal?.live) await this.terminalMonitor.signalRun(audit.terminal, "SIGCONT");
      if (!child.kill("SIGCONT")) throw new Error("恢复信号发送失败。");
      audit.status = "running";
      this.taskBoardServices.get(id)?.resume();
      await this.record(audit, "audit.resumed", {});
    } else if (action === "cancel" && ACTIVE.has(audit.status)) {
      await this.stopTaskBoard(audit);
      await this.stopRuntimeTesting(audit);
      if (audit.status === "paused") {
        if (audit.terminal?.live) await this.terminalMonitor.signalRun(audit.terminal, "SIGCONT");
        if (!child.kill("SIGCONT")) throw new Error("取消前恢复审计进程失败。");
      }
      audit.interruption_reason = null;
      audit.status = "cancelling";
      await this.record(audit, "audit.cancelling", {});
      if (audit.terminal?.live) {
        await this.terminalMonitor.abort(audit.terminal, audit.paths?.workspace_root).catch(error => this.recordLog(audit, "stderr", `OpenCode session 中止确认失败：${error.message}`));
      }
      if (!child.kill("SIGTERM")) throw new Error("取消信号发送失败。");
    } else {
      throw Object.assign(new Error("操作与当前状态不匹配。"), { statusCode: 409, code: "action-not-allowed" });
    }
    audit.action_idempotency_digests = [...(audit.action_idempotency_digests ?? []), actionDigest].slice(-100);
    await this.persist(audit);
    return publicAudit(audit);
  }

  health() {
    return {
      enabled: this.enabled,
      command: this.command,
      active_processes: this.processes.size,
      active_tmux_monitors: [...this.audits.values()].filter(audit => audit.terminal?.live).length,
      registered_repositories: this.repositories.size,
      state_root: "server-managed",
    };
  }

  async shutdown() {
    await this.ready;
    for (const id of this.taskBoardServices.keys()) await this.stopTaskBoard(this.audits.get(id));
    for (const id of this.runtimeTestingServices.keys()) await this.stopRuntimeTesting(this.audits.get(id));
    if (this.completionWatchdogTimer) clearInterval(this.completionWatchdogTimer);
    this.completionWatchdogTimer = null;
    for (const timer of this.timeoutRecoveryTimers.values()) clearTimeout(timer);
    this.timeoutRecoveryTimers.clear();
    for (const { timer } of this.timeoutTerminationTimers.values()) clearTimeout(timer);
    this.timeoutTerminationTimers.clear();
    this.timeoutRecoveryPending.clear();
    for (const timer of this.contextRecoveryTimers.values()) clearTimeout(timer);
    this.contextRecoveryTimers.clear();
    for (const { timer } of this.contextTerminationTimers.values()) clearTimeout(timer);
    this.contextTerminationTimers.clear();
    this.contextRecoveryPending.clear();
    for (const [id, child] of this.processes) {
      const audit = this.audits.get(id);
      if (!audit || audit.status === "cancelling") continue;
      if (audit.status === "paused") {
        if (audit.terminal?.live) await this.terminalMonitor.signalRun(audit.terminal, "SIGCONT").catch(() => {});
        child.kill("SIGCONT");
      }
      audit.interruption_reason = "workbench-shutdown";
      audit.status = "cancelling";
      await this.record(audit, "audit.cancelling", { reason: "workbench-shutdown" });
      if (audit.terminal?.live) await this.terminalMonitor.abort(audit.terminal, audit.paths?.workspace_root).catch(() => {});
      child.kill("SIGTERM");
    }
    while (this.completions.size) await Promise.allSettled([...this.completions.values()]);
    while (this.writeQueues.size) await Promise.allSettled([...this.writeQueues.values()]);
  }
}
