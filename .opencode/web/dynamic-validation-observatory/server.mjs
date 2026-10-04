#!/usr/bin/env node

import { createServer as createHttpServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import { AuditQueueScheduler, QueueSettingsStore } from "./audit-queue-scheduler.mjs";
import { AuditRunner } from "./audit-runner.mjs";
import { EnvironmentHealthService } from "./environment-health.mjs";
import { FindingWorkflowStore } from "./finding-workflow.mjs";
import { createProvenanceIndex, matchesProvenance } from "./provenance.mjs";
import { listValidationRequests, listValidationRunDetails, listValidationRuns } from "./model.mjs";
import { DEFAULT_MODEL_SELECTION, normalizeOpenCodeModel, OpenCodeModelCatalog, OpenCodeModelSettingsStore } from "./opencode-model-settings.mjs";
import { auditsFromArtifacts, buildWorkspaceSnapshot } from "./workspace-model.mjs";
import { applyAuditProgress, mergeAuditPresentation } from "./audit-progress.mjs";
import { paginateAudits, compactWorkspaceAudits } from "./audit-list.mjs";
import { createSnapshotCache } from "./snapshot-cache.mjs";
import { DynamicValidationRunner } from "./validation-runner.mjs";
import { RequestHistoryStore } from "./request-history-store.mjs";
import { buildOpenCollectionArchive, buildBrunoCollection } from "./bruno-exporter.mjs";
import { readRuntimeTestingActivity } from "./runtime-testing-activity.mjs";
import { buildValidationActivity, filterValidationActivity } from "./validation-activity.mjs";
import { buildHar } from "./har-exporter.mjs";
import { materializeManualValidationRequests } from "./manual-validation-request-materializer.mjs";
import { ProductMemoryService } from "../../lib/product-memory/service.mjs";
import { ProductAuditService } from "../../lib/product-memory/campaign.mjs";
import { productMemoryRoute } from "../../lib/product-memory/routes.mjs";
import { ProductStore, UNDEFINED_PRODUCT_ID } from "./product-store.mjs";
import { controlledBytes } from "../../lib/task-board/contract.mjs";
import { renderBoardReport } from "../../lib/task-board/review.mjs";
import { renderStructuredBoardReport } from "../../lib/task-board/report.mjs";
import { createWorkbenchUiHandler, normalizeModernOrigin } from "./workbench-ui.mjs";
import { runtimeBuild } from "./runtime-build.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "../../..");
const PUBLIC_ROOT = join(HERE, "public");
const DEFAULT_RUNTIME_ROOT = join(PROJECT_ROOT, "reports", "validation-handoff", "runtime");
const DEFAULT_STATE_ROOT = join(PROJECT_ROOT, "reports", "platform", "audit-runs");
const DEFAULT_OPENCODE_CONFIG = join(PROJECT_ROOT, ".opencode", "opencode.json");
const DEFAULT_STAGE_REGISTRY = join(PROJECT_ROOT, ".opencode", "skills", "common-subagent", "audit-artifact-management", "contracts", "stage-agent-contracts.json");
const DEFAULT_ROLES = join(PROJECT_ROOT, ".opencode", "agent-manifest", "roles.json");
const BIND_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
const MAX_REQUEST_BODY = 1024 * 1024;
const MAX_REPORT_BODY = 8 * 1024 * 1024;
const FINDINGS_PAGE_SIZE = 50;
const AUDIT_ACTIVE_WORK_STATES = new Set(["queued", "preparing", "recovering", "running", "pausing", "paused", "cancelling"]);
const AUDIT_RUNNING_TAB_STATES = new Set(["preparing", "recovering", "running", "pausing", "cancelling"]);
const VALIDATION_RUNNING_STATES = new Set(["preparing", "running", "cancelling"]);
const markdownRenderer = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });
const defaultLinkOpen = markdownRenderer.renderer.rules.link_open
  ?? ((tokens, index, options, _environment, self) => self.renderToken(tokens, index, options));
markdownRenderer.renderer.rules.link_open = (tokens, index, options, environment, self) => {
  tokens[index].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, index, options, environment, self);
};
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/product-memory-ui.js", ["product-memory-ui.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/logo_DJ.png", ["logo_DJ.png", "image/png"]],
]);

function json(response, status, value, headers = {}) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(body);
}

function binary(response, status, body, contentType, filename) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Content-Disposition": `attachment; filename="${filename.replaceAll('"', '')}"`,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function securityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

async function staticResponse(response, pathname) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) return false;
  const [fileName, contentType] = entry;
  const body = await readFile(join(PUBLIC_ROOT, fileName));
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
  });
  response.end(body);
  return true;
}

async function requestJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY) throw Object.assign(new Error("请求体过大。"), { statusCode: 413, code: "request-too-large" });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("请求体不是有效 JSON。"), { statusCode: 400, code: "invalid-json" });
  }
}

function assertSafeMutation(request) {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("写接口只接受 application/json。"), { statusCode: 415, code: "content-type-required" });
  }
  const origin = request.headers.origin;
  if (origin && origin !== `http://${request.headers.host}`) {
    throw Object.assign(new Error("拒绝跨站写请求。"), { statusCode: 403, code: "cross-origin-mutation-rejected" });
  }
}

function matchAuditPath(pathname, suffix = "") {
  const pattern = suffix
    ? new RegExp(`^/api/v1/audits/([^/]+)/${suffix}$`)
    : /^\/api\/v1\/audits\/([^/]+)$/;
  const match = pathname.match(pattern);
  return match ? decodeURIComponent(match[1]) : null;
}

function matchReportPath(pathname, suffix = "") {
  const pattern = suffix
    ? new RegExp(`^/api/v1/reports/([^/]+)/${suffix}$`)
    : /^\/api\/v1\/reports\/([^/]+)$/;
  const match = pathname.match(pattern);
  return match ? decodeURIComponent(match[1]) : null;
}

function matchFindingWorkflowPath(pathname) {
  const match = pathname.match(/^\/api\/v1\/findings\/([^/]+)\/workflow$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function matchProductPath(pathname, suffix = "") {
  const pattern = suffix
    ? new RegExp(`^/api/v2/products/([^/]+)/${suffix}$`)
    : /^\/api\/v2\/products\/([^/]+)$/;
  const match = pathname.match(pattern);
  return match ? decodeURIComponent(match[1]) : null;
}

function matchTargetPath(pathname, suffix = "") {
  const pattern = suffix
    ? new RegExp(`^/api/v2/products/([^/]+)/targets/([^/]+)/${suffix}$`)
    : /^\/api\/v2\/products\/([^/]+)\/targets\/([^/]+)$/;
  const match = pathname.match(pattern);
  return match ? { productId: decodeURIComponent(match[1]), targetId: decodeURIComponent(match[2]) } : null;
}

function matchProductAuditPath(pathname, suffix = "") {
  const pattern = suffix
    ? new RegExp(`^/api/v2/products/([^/]+)/audits/([^/]+)/${suffix}$`)
    : /^\/api\/v2\/products\/([^/]+)\/audits\/([^/]+)$/;
  const match = pathname.match(pattern);
  return match ? { productId: decodeURIComponent(match[1]), auditId: decodeURIComponent(match[2]) } : null;
}

function expectedVersion(request) {
  return String(request.headers["if-match"] ?? "").replaceAll('"', "");
}

function targetAuditPage(audits, searchParams) {
  const tab = searchParams.get("tab") ?? "all";
  if (!['running', 'completed', 'all'].includes(tab)) throw Object.assign(new Error("任务页签无效。"), { statusCode: 422, code: "audit-tab-invalid" });
  const query = searchParams.get("q")?.trim().toLowerCase() ?? "";
  const items = audits.filter(audit => {
    if (tab === "running" && !AUDIT_RUNNING_TAB_STATES.has(audit.status)) return false;
    if (tab === "completed" && AUDIT_RUNNING_TAB_STATES.has(audit.status)) return false;
    if (query && !`${audit.id} ${audit.name} ${audit.status} ${audit.repository_name ?? ""}`.toLowerCase().includes(query)) return false;
    return true;
  }).sort((left, right) => String(right.updated_at ?? right.created_at ?? "").localeCompare(String(left.updated_at ?? left.created_at ?? "")));
  if (tab === "running") return { items, count: items.length, returned_count: items.length, page: 1, page_size: items.length, total_pages: 1, pagination: false, tab };
  const requestedPage = Number(searchParams.get("page") ?? 1);
  const requestedSize = Number(searchParams.get("page_size") ?? 20);
  if (!Number.isInteger(requestedPage) || requestedPage < 1 || ![20, 30, 50, 100].includes(requestedSize)) {
    throw Object.assign(new Error("任务分页参数无效。"), { statusCode: 422, code: "audit-pagination-invalid" });
  }
  const totalPages = Math.max(1, Math.ceil(items.length / requestedSize));
  const page = Math.min(requestedPage, totalPages);
  return { items: items.slice((page - 1) * requestedSize, page * requestedSize), count: items.length, returned_count: Math.min(requestedSize, Math.max(items.length - (page - 1) * requestedSize, 0)), page, page_size: requestedSize, total_pages: totalPages, pagination: true, tab };
}

function scopedResourceId(repositoryId, localId) {
  return createHash("sha256").update(`${repositoryId}\0${localId}`).digest("hex").slice(0, 24);
}

function isWithin(root, candidate) {
  const value = relative(root, candidate);
  return value !== "" && !value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value);
}

function filterFindings(findings, url) {
  const auditId = url.searchParams.get("audit_id");
  const severity = url.searchParams.get("severity")?.toUpperCase();
  const query = url.searchParams.get("q")?.trim().toLowerCase();
  return findings.filter(finding => {
    if (!matchesProvenance(finding, url.searchParams)) return false;
    if (auditId && finding.audit_id !== auditId) return false;
    if (severity && finding.severity !== severity) return false;
    if (query && !`${finding.id} ${finding.title} ${finding.description ?? ""} ${finding.repository_name ?? ""} ${finding.repository_id ?? ""} ${finding.audit_id ?? ""} ${finding.provenance?.product_name ?? ""} ${finding.provenance?.audit_name ?? ""} ${finding.provenance?.reports.map(report => report.name).join(" ") ?? ""} ${finding.location?.path ?? ""} ${(finding.evidence ?? []).map(item => item.text ?? "").join(" ")}`.toLowerCase().includes(query)) return false;
    return true;
  });
}

export function paginateFindings(findings, url) {
  const filtered = filterFindings(findings, url);
  const totalPages = Math.max(1, Math.ceil(filtered.length / FINDINGS_PAGE_SIZE));
  const requestedPage = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const page = Math.min(Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1, totalPages);
  const start = (page - 1) * FINDINGS_PAGE_SIZE;
  return {
    items: filtered.slice(start, start + FINDINGS_PAGE_SIZE),
    count: filtered.length,
    returned_count: Math.min(FINDINGS_PAGE_SIZE, Math.max(0, filtered.length - start)),
    page,
    page_size: FINDINGS_PAGE_SIZE,
    total_pages: totalPages,
  };
}

function mergeSnapshots(snapshots) {
  const merged = {
    generated_at: new Date().toISOString(),
    summary: { audit_count: 0, active_audits: 0, completed_audits: 0, finding_count: 0, report_count: 0, validation_run_count: 0, severity: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 } },
    audits: [], findings: [], reports: [], artifacts: [],
  };
  for (const snapshot of snapshots) {
    merged.audits.push(...snapshot.audits);
    merged.findings.push(...snapshot.findings);
    merged.reports.push(...snapshot.reports);
    merged.artifacts.push(...snapshot.artifacts);
    for (const key of Object.keys(merged.summary.severity)) merged.summary.severity[key] += snapshot.summary.severity[key] ?? 0;
  }
  merged.audits.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  merged.summary.audit_count = merged.audits.length;
  merged.summary.active_audits = merged.audits.filter(audit => ["queued", "preparing", "recovering", "running", "pausing", "paused", "cancelling"].includes(audit.status)).length;
  merged.summary.completed_audits = merged.audits.filter(audit => audit.status === "completed").length;
  merged.summary.finding_count = merged.findings.length;
  merged.summary.report_count = merged.reports.length;
  merged.summary.validation_run_count = snapshots.reduce((total, snapshot) => total + snapshot.summary.validation_run_count, 0);
  return merged;
}

export async function streamAuditEvents(request, response, runner, auditId) {
  if (!runner.getAudit(auditId)) {
    json(response, 404, { error: "audit-not-found" });
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const streamUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const requestedSequence = Number(streamUrl.searchParams.get("after") ?? 0);
  const afterSequence = Number.isSafeInteger(requestedSequence) && requestedSequence >= 0 ? requestedSequence : 0;
  const pending = [];
  let replaying = true, sentSequence = 0;
  const send = event => {
    if (event.sequence <= sentSequence || response.destroyed) return;
    response.write(`id: ${event.event_id}\ndata: ${JSON.stringify(event)}\n\n`);
    sentSequence = event.sequence;
  };
  const unsubscribe = runner.subscribe(auditId, event => replaying ? pending.push(event) : send(event));
  request.once("close", unsubscribe);
  try {
    const replay = await runner.eventsSince(auditId, afterSequence, request.headers["last-event-id"]);
    for (const event of replay) send(event);
    for (const event of pending) send(event);
    replaying = false;
  } catch (error) { unsubscribe(); throw error; }
  if (response.destroyed) { unsubscribe(); return; }
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref();
  request.once("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function streamValidationEvents(request, response, runner, validationId) {
  if (!runner.getRun(validationId)) {
    json(response, 404, { error: "validation-not-found" });
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const streamUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const afterSequence = Number(streamUrl.searchParams.get("after") ?? 0);
  for (const event of await runner.eventsSince(validationId, afterSequence)) response.write(`id: ${event.event_id}\ndata: ${JSON.stringify(event)}\n\n`);
  const unsubscribe = runner.subscribe(validationId, event => response.write(`id: ${event.event_id}\ndata: ${JSON.stringify(event)}\n\n`));
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref();
  request.once("close", () => { clearInterval(heartbeat); unsubscribe(); });
}

export function createAuditWorkbenchServer({
  runtimeRoot = DEFAULT_RUNTIME_ROOT,
  stateRoot = DEFAULT_STATE_ROOT,
  repositories = [],
  platformConfigPath = DEFAULT_OPENCODE_CONFIG,
  legacyRuntimeRoot = false,
  runnerEnabled = false,
  runner: suppliedRunner = null,
  dynamicRunnerEnabled = false,
  dynamicStateRoot = null,
  dynamicRunner: suppliedDynamicRunner = null,
  environmentService: suppliedEnvironmentService = null,
  findingStateRoot = null,
  findingWorkflow: suppliedFindingWorkflow = null,
  queueSettingsPath = null,
  queueSettingsStore: suppliedQueueSettingsStore = null,
  queueScheduler: suppliedQueueScheduler = null,
  modelSettingsPath = null,
  modelSettingsStore: suppliedModelSettingsStore = null,
  modelCatalog: suppliedModelCatalog = null,
  modelConfigPaths = null,
  requestStateRoot = null,
  requestHistoryStore: suppliedRequestHistoryStore = null,
  productCatalogPath = null,
  productStore: suppliedProductStore = null,
  modernWorkbenchOrigin = null,
} = {}) {
  const workbenchUi = createWorkbenchUiHandler(modernWorkbenchOrigin);
  const resolvedRuntimeRoot = resolve(runtimeRoot);
  const runner = suppliedRunner ?? new AuditRunner({ stateRoot, platformRoot: PROJECT_ROOT, repositories, configPath: platformConfigPath, enabled: runnerEnabled });
  const queueSettingsStore = suppliedQueueSettingsStore ?? new QueueSettingsStore({
    path: queueSettingsPath ?? join(dirname(resolve(stateRoot)), "workbench-settings.json"),
  });
  const queueScheduler = suppliedQueueScheduler ?? new AuditQueueScheduler({ runner, settingsStore: queueSettingsStore });
  runner.setQueueScheduler(queueScheduler);
  const xdgConfigHome = resolve(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"));
  const modelCatalog = suppliedModelCatalog ?? new OpenCodeModelCatalog({
    configPaths: modelConfigPaths ?? [
      resolve(platformConfigPath),
      resolve(dirname(platformConfigPath), "opencode.jsonc"),
      join(xdgConfigHome, "opencode.json"),
      join(xdgConfigHome, "opencode.jsonc"),
      join(xdgConfigHome, "opencode", "opencode.json"),
      join(xdgConfigHome, "opencode", "opencode.jsonc"),
    ],
  });
  const modelSettingsStore = suppliedModelSettingsStore ?? new OpenCodeModelSettingsStore({
    path: modelSettingsPath ?? join(dirname(resolve(stateRoot)), "opencode-model-settings.json"),
  });
  const dynamicRunner = suppliedDynamicRunner ?? new DynamicValidationRunner({
    stateRoot: dynamicStateRoot ?? join(dirname(stateRoot), "dynamic-validation-runs"),
    enabled: dynamicRunnerEnabled,
    registryPath: DEFAULT_STAGE_REGISTRY,
    rolesPath: DEFAULT_ROLES,
  });
  const environmentService = suppliedEnvironmentService ?? new EnvironmentHealthService({
    projectRoot: PROJECT_ROOT,
    configPaths: [resolve(platformConfigPath)],
  });
  const findingWorkflow = suppliedFindingWorkflow ?? new FindingWorkflowStore({
    stateRoot: findingStateRoot ?? join(dirname(stateRoot), "finding-workflow"),
  });
  const requestHistory = suppliedRequestHistoryStore ?? new RequestHistoryStore({
    stateRoot: requestStateRoot ?? join(dirname(resolve(stateRoot)), "dynamic-request-workbench"),
  });
  const productStore = suppliedProductStore ?? new ProductStore({
    path: productCatalogPath ?? join(dirname(resolve(stateRoot)), "product-catalog.sqlite"),
    platformRoot: PROJECT_ROOT,
  });
  const productMemory = new ProductMemoryService({ products: productStore, runner, stateRoot: join(dirname(resolve(stateRoot)), "product-memory") });
  const productAudits = new ProductAuditService({ memory: productMemory, runner, products: productStore, stateRoot: join(dirname(resolve(stateRoot)), "product-audits"),
    createAudit: (input, key) => withTargetOperationLock(input.target_id, () => runner.createAuditFromTarget(input, key)) });
  runner.memoryProvider = (audit, repository, paths) => productMemory.prepare(audit, repository, paths);
  runner.productCampaignGuard = id => productAudits.canDispatch(id);
  runner.productCampaignState = id => productMemory.store.db?.prepare('SELECT status FROM pm_campaigns WHERE id=?').get(id)?.status;
  const targetOperationLocks = new Map();

  async function withTargetOperationLock(targetId, operation) {
    const prior = targetOperationLocks.get(targetId) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    targetOperationLocks.set(targetId, current);
    await prior.catch(() => {});
    try { return await productStore.withTargetOperation(targetId, "web-operation", operation); }
    finally {
      release();
      if (targetOperationLocks.get(targetId) === current) targetOperationLocks.delete(targetId);
    }
  }

  const productCatalogReady = Promise.all([runner.ready, productStore.ready]).then(async () => {
    for (const repository of runner.runtimeRepositories()) await productStore.importLegacyRepository(repository);
    for (const audit of runner.listAudits()) {
      if (productStore.auditLink(audit.id)) continue;
      const target = productStore.getTarget(UNDEFINED_PRODUCT_ID, audit.repository_id);
      const snapshot = await productStore.targetExecutionSnapshot(UNDEFINED_PRODUCT_ID, target.id);
      await productStore.linkAudit({ auditId: audit.id, productId: UNDEFINED_PRODUCT_ID, targetId: target.id, snapshot: snapshot.snapshot, snapshotDigest: snapshot.digest });
    }
  });
  productCatalogReady.then(() => productAudits.ready).then(() => { productMemory.start(); productAudits.start(); }).catch(error => { productAudits.lastError = error.message; });
  runner.setTargetOperationGuard?.((audit, operation) => withTargetOperationLock(audit.execution_spec?.target_id ?? audit.repository_id, operation));

  function recordOwnership(record) {
    const auditId = record.audit_id ?? record.id;
    const managed = runner.getAudit(auditId);
    const audit = managed?.repository_id === record.repository_id ? managed : null;
    const link = audit ? productStore.auditLink(auditId) : null;
    const target = productStore.targetById(link?.target_id ?? record.repository_id);
    const product = target ? productStore.assertProduct(target.product_id) : null;
    return { product_id: product?.id ?? null, product_name: product?.name ?? "未关联产品",
      product_name_at_creation: link?.product_name_at_creation ?? null,
      target_id: target?.id ?? null, target_name: target?.name ?? record.repository_name ?? "未关联测试对象",
      audit_managed: Boolean(audit && link), audit_product_id: audit && link ? product?.id ?? null : null };
  }

  function runtimeSources() {
    const artifacts = new Map(runner.artifactSources().map(source => [source.repository_id, source.reports_root]));
    return runner.runtimeRepositories().map(repository => ({ repository, root: legacyRuntimeRoot ? resolvedRuntimeRoot : join(artifacts.get(repository.id), "validation-handoff", "runtime") }));
  }

  async function validationRequests() {
    const values = [];
    for (const { repository, root } of runtimeSources()) {
      const reportsRoot = runner.artifactSources().find(source => source.repository_id === repository.id)?.reports_root;
      if (reportsRoot) {
        for (const audit of runner.listAudits().filter(item => item.repository_id === repository.id && item.status === "completed")) {
          await materializeManualValidationRequests({ reportsRoot, auditId: audit.id, repositoryId: repository.id, commit: audit.commit });
        }
      }
      for (const request of await listValidationRequests(root)) values.push({
        ...request,
        job_id: scopedResourceId(repository.id, request.id),
        repository_id: repository.id,
        repository_name: repository.name,
      });
    }
    const jobs = new Map(dynamicRunner.listRuns().map(run => [run.id, run]));
    const attachSource = createProvenanceIndex(await snapshot(), recordOwnership);
    return Promise.all(values.map(async request => {
      const legacyJob = jobs.get(request.id);
      const audit = runner.getAudit(request.audit_id);
      const auditManaged = Boolean(audit && audit.repository_id === request.repository_id);
      const policy = await runner.dynamicValidationPolicy(request.audit_id, request.repository_id);
      const blockerMessages = {
        "request-invalid": "动态验证请求未通过摘要或字段校验。",
        "validation-type-unsupported": "该漏洞类型不属于当前 Web 动态验证范围。",
        "validation-result-exists": "该漏洞已有动态验证结果，默认拒绝覆盖。",
      };
      return attachSource({
        ...request,
        artifact_dispatch_ready: request.dispatch_ready,
        audit_managed: auditManaged,
        task_test_environment_preconfigured: policy.enabled,
        dispatch_ready: request.dispatch_ready && auditManaged,
        dispatch_blocked_reason: !auditManaged
          ? "动态验证请求不属于当前工作台受管审计。"
          : request.dispatch_ready ? null : request.dispatch_blockers.map(code => blockerMessages[code] ?? code).join(" "),
        job: jobs.get(request.job_id) ?? (legacyJob?.repository_id === request.repository_id ? legacyJob : null),
      }, { findingId: request.finding_id });
    }));
  }

  async function validationRuns() {
    const values = [];
    for (const { repository, root } of runtimeSources()) {
      for (const run of await listValidationRuns(root)) values.push({
        ...run,
        resource_id: scopedResourceId(repository.id, run.id),
        repository_id: repository.id,
        repository_name: repository.name,
      });
    }
    const attachSource = createProvenanceIndex(await snapshot(), recordOwnership);
    return values.map(run => attachSource(run, { findingId: run.finding_id })).sort((a, b) => String(b.recorded_at ?? "").localeCompare(String(a.recorded_at ?? "")));
  }

  async function httpExchanges() {
    const activity = await validationActivity();
    return [...activity.exchanges].sort((left, right) => String(right.started_at ?? "").localeCompare(String(left.started_at ?? "")));
  }

  let validationActivityInFlight = null;
  function validationActivity() {
    // Share only concurrent reads; a later request always reads current state.
    if (!validationActivityInFlight) validationActivityInFlight = readValidationActivity().finally(() => { validationActivityInFlight = null; });
    return validationActivityInFlight;
  }

  async function readValidationActivity() {
    // This display path does not reconcile jobs, materialize requests, or write
    // audit state. Read existing evidence and current in-memory Runner metadata.
    await Promise.all([runner.ready, productCatalogReady]);
    const sources = runner.artifactSources(), audits = runner.listAudits(), snapshots = [];
    for (const source of sources) {
      const value = await buildWorkspaceSnapshot({ reportsRoot: source.reports_root, runnerAudits: audits.filter(audit => audit.repository_id === source.repository_id) });
      for (const key of ["audits", "findings", "reports"]) value[key] = value[key].map(row => ({ ...row,
        repository_id: source.repository_id, repository_name: source.repository_name,
        ...(key === "reports" ? { id: scopedResourceId(source.repository_id, row.id) } : {}),
        ...(key === "findings" ? { resource_id: scopedResourceId(source.repository_id, `${row.audit_id}\0${row.id}`) } : {}) }));
      snapshots.push(value);
    }
    const data = mergeSnapshots(snapshots), attachSource = createProvenanceIndex(data, recordOwnership);
    const runtimeCases = [], runtimeExchanges = [], manualRuns = [], requests = [];
    for (const source of sources) for (const audit of data.audits.filter(row => row.repository_id === source.repository_id && (row.runtime_testing_state || row.runtime_testing))) {
      const activity = await readRuntimeTestingActivity({ reportsRoot: source.reports_root, repositoryId: source.repository_id, audit });
      runtimeCases.push(...activity.cases); runtimeExchanges.push(...activity.exchanges);
    }
    const jobs = new Map(dynamicRunner.listRuns().map(run => [run.id, run]));
    for (const { repository, root } of runtimeSources()) {
      const identity = { repository_id: repository.id, repository_name: repository.name };
      for (const run of await listValidationRunDetails(root)) manualRuns.push({ ...run, ...identity });
      for (const request of await listValidationRequests(root)) requests.push({ ...request, ...identity,
        job: jobs.get(scopedResourceId(repository.id, request.id)) ?? null });
    }
    const historicalExchanges = await requestHistory.list({ limit: 500 });
    const historyCount = requestHistory.records instanceof Map ? requestHistory.records.size : historicalExchanges.length;
    return { ...buildValidationActivity({ runtimeCases, runtimeExchanges, manualRuns, requests, historicalExchanges, attachSource }),
      history_window: { limit: 500, returned: historicalExchanges.length, total: historyCount, has_more: historyCount > historicalExchanges.length } };
  }

  async function httpExchange(exchangeId) {
    return (await httpExchanges()).find(exchange => exchange.exchange_id === exchangeId) ?? null;
  }

  async function validationRun(resourceId) {
    const attachSource = createProvenanceIndex(await snapshot(), recordOwnership);
    for (const { repository, root } of runtimeSources()) {
      for (const run of await listValidationRunDetails(root)) {
        const scopedId = scopedResourceId(repository.id, run.id);
        if (resourceId === scopedId || resourceId === run.id) return attachSource({
          ...run,
          resource_id: scopedId,
          repository_id: repository.id,
          repository_name: repository.name,
        }, { findingId: run.finding?.id });
      }
    }
    return null;
  }

  async function modelSettingsSnapshot() {
    const [catalog, settings] = await Promise.all([modelCatalog.snapshot(), modelSettingsStore.get()]);
    const selected = settings.model ?? DEFAULT_MODEL_SELECTION;
    return {
      selected_model: selected,
      options: [
        { value: DEFAULT_MODEL_SELECTION, label: "默认" },
        ...catalog.models.map(model => ({ value: model, label: model })),
      ],
      sources: catalog.sources,
      selection_available: selected === DEFAULT_MODEL_SELECTION || catalog.models.includes(selected),
      updated_at: settings.updated_at,
    };
  }

  async function auditsForProduct(productId) {
    await productCatalogReady;
    productStore.assertProduct(productId);
    const links = await productStore.auditLinksForProduct(productId);
    return runner.listAudits().flatMap(audit => {
      const link = links.get(audit.id);
      if (!link) return [];
      return [{ ...audit, product_id_at_creation: link.product_id_at_creation, product_name_at_creation: link.product_name_at_creation, target_id: link.target_id, target_snapshot_digest: link.snapshot_digest }];
    });
  }

  async function auditForProduct(productId, auditId) {
    await productCatalogReady;
    productStore.assertProduct(productId);
    const link = productStore.auditLink(auditId);
    const audit = runner.getAudit(auditId);
    if (!link || productStore.targetById(link.target_id)?.product_id !== productId || !audit) throw Object.assign(new Error("产品空间内没有该审计任务。"), { statusCode: 404, code: "product-audit-not-found" });
    return { ...audit, product_id_at_creation: link.product_id_at_creation, product_name_at_creation: link.product_name_at_creation, target_id: link.target_id, target_snapshot_digest: link.snapshot_digest };
  }

  function targetHasRunningWork(targetId) {
    const campaignBusy = productMemory.store.db?.prepare("SELECT 1 FROM pm_nodes n JOIN pm_jobs j ON j.repo_id=n.id JOIN pm_campaigns c ON c.id=j.campaign_id WHERE n.target_id=? AND c.status IN ('RUNNING','PAUSED','CANCELLING') LIMIT 1").get(targetId);
    const auditBusy = runner.listAudits().some(audit => audit.repository_id === targetId && AUDIT_ACTIVE_WORK_STATES.has(audit.status));
    const validationBusy = dynamicRunner.listRuns().some(run => run.repository_id === targetId && VALIDATION_RUNNING_STATES.has(run.status));
    return Boolean(campaignBusy || auditBusy || validationBusy);
  }

  async function assertProductCanArchive(productId) {
    const targetIds = await productStore.targetIds(productId);
    if (targetIds.some(targetHasRunningWork)) {
      throw Object.assign(new Error("产品仍有排队、运行或取消中的审计/验证；请先让这些任务结束后再归档。"), { statusCode: 409, code: "product-has-active-work" });
    }
  }

  async function assertLegacyUndefinedTarget(targetId) {
    await productCatalogReady;
    const target = productStore.targetById(targetId);
    if (target && target.product_id !== UNDEFINED_PRODUCT_ID) {
      throw Object.assign(new Error("该审计对象已归属正式产品；请使用产品空间 API 或界面创建和管理任务。"), { statusCode: 409, code: "legacy-write-product-scoped" });
    }
  }

  async function assertLegacyUndefinedAudit(auditId) {
    await productCatalogReady;
    const link = productStore.auditLink(auditId);
    if (link && productStore.targetById(link.target_id)?.product_id !== UNDEFINED_PRODUCT_ID) {
      throw Object.assign(new Error("该审计任务属于正式产品；请使用产品空间 API 或界面管理。"), { statusCode: 409, code: "legacy-write-product-scoped" });
    }
  }

  // Display reads share a bounded snapshot with live Runner state overlaid.
  async function buildSnapshot() {
    const operation = (async () => {
      await Promise.all([runner.ready, findingWorkflow.ready, queueScheduler.ready, modelSettingsStore.ready, productCatalogReady]);
      await runner.reconcileTerminalCompletions("workspace-watchdog");
      const runnerAudits = await runner.listAuditsWithTodo();
      const validationByRepository = new Map();
      await Promise.all(runtimeSources().map(async ({ repository, root }) => {
        validationByRepository.set(repository.id, await listValidationRuns(root));
      }));
      const sources = runner.artifactSources();
      const snapshots = [];
      for (const source of sources) {
        const sourceRuns = runnerAudits.filter(audit => audit.repository_id === source.repository_id);
        const value = await buildWorkspaceSnapshot({ reportsRoot: source.reports_root, validationRuns: validationByRepository.get(source.repository_id) ?? [], runnerAudits: sourceRuns });
        value.audits = value.audits.map(audit => ({
          ...audit,
          repository_id: audit.repository_id ?? source.repository_id,
          repository_name: audit.repository_name ?? source.repository_name,
        }));
        value.findings = value.findings.map(finding => {
          const resourceId = scopedResourceId(source.repository_id, `${finding.audit_id}\0${finding.id}`);
          return { ...finding, resource_id: resourceId, repository_id: source.repository_id, repository_name: source.repository_name, workflow: findingWorkflow.get(resourceId), memory: productMemory.findingSummary(productStore.targetById(source.repository_id)?.product_id, resourceId, finding) };
        });
        value.reports = value.reports.map(report => ({
          ...report,
          id: scopedResourceId(source.repository_id, report.id),
          repository_id: source.repository_id,
          repository_name: source.repository_name,
        }));
        value.artifacts = value.artifacts.map(artifact => ({
          ...artifact,
          id: scopedResourceId(source.repository_id, artifact.id),
          repository_id: source.repository_id,
        }));
        snapshots.push(value);
      }
      const merged = mergeSnapshots(snapshots);
      const attachSource = createProvenanceIndex(merged, recordOwnership);
      merged.audits = merged.audits.map(audit => attachSource(audit));
      merged.findings = merged.findings.map(finding => attachSource(finding, { findingId: finding.id }));
      merged.reports = merged.reports.map(report => attachSource(report));
      merged.queue = await queueScheduler.snapshot();
      return merged;
    })();
    return operation;
  }
  const snapshotCache = createSnapshotCache(buildSnapshot);
  const snapshot = () => snapshotCache.get();

  async function displaySnapshot(url) {
    if (url.searchParams.get("live") !== "1") return snapshot();
    const data = await snapshotCache.get({ allowStale: true });
    const audits = new Map(data.audits.map(audit => [audit.id, audit]));
    for (const current of runner.listAudits()) {
      const previous = audits.get(current.id);
      const audit = { ...previous };
      const fields = ["id", "name", "repository_id", "repository_name", "commit", "status", "version", "event_sequence", "created_at", "updated_at", "terminal", "queue", "paths", "provider_session_id", "task_context", "todo", "model", "error", "exit_code", "recovery_count", "last_recovered_at", "interrupted_at", "interruption_reason", "todo_completion", "stage_delivery", "context_window_recovery", "completion_source"];
      fields.push("task_protocol", "task_board", "mining_strategy", "runtime_testing", "runtime_testing_state", "bac_analysis");
      for (const field of fields) audit[field] = current[field] ?? null;
      if (!previous) Object.assign(audit, { stages: [], progress: 0, stage: "等待调度", finding_count: 0, artifact_count: 0, runtime_validation_count: 0 });
      if (current.stage_delivery_enforcement === "TODO_ENFORCED" && current.todo?.total > 0) {
        audit.progress = current.todo.progress ?? 0;
        audit.progress_source = "local-audit-todo";
      }
      audits.set(current.id, applyAuditProgress({ ...audit, provenance: { ...audit.provenance, ...recordOwnership(current), audit_id: current.id, audit_name: current.name } }));
    }
    const items = [...audits.values()].sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
    return { ...data, audits: items, queue: await queueScheduler.snapshot(), summary: {
      ...data.summary, audit_count: items.length,
      active_audits: items.filter(audit => ["queued", "preparing", "recovering", "running", "pausing", "paused", "cancelling"].includes(audit.status)).length,
      completed_audits: items.filter(audit => audit.status === "completed").length,
    } };
  }

  async function reportContent(reportId, { original = false } = {}) {
    const data = await snapshot();
    const report = data.reports.find(item => item.id === reportId);
    if (!report) throw Object.assign(new Error("没有找到最终报告。"), { statusCode: 404, code: "report-not-found" });
    const source = runner.artifactSources().find(item => item.repository_id === report.repository_id);
    if (!source) throw Object.assign(new Error("报告所属仓库不再可用。"), { statusCode: 409, code: "report-source-unavailable" });
    const [root, candidate] = await Promise.all([
      realpath(source.reports_root),
      realpath(resolve(source.reports_root, report.path)),
    ]);
    if (!isWithin(root, candidate)) throw Object.assign(new Error("报告路径越出受控制品目录。"), { statusCode: 409, code: "report-path-invalid" });
    const info = await stat(candidate);
    if (!info.isFile() || info.size > MAX_REPORT_BODY) throw Object.assign(new Error("报告文件不可读取或超过大小限制。"), { statusCode: 413, code: "report-body-too-large" });
    const sourceBytes = await readFile(candidate);
    let bytes = sourceBytes, format = "original";
    if (!original && report.path === `final/security-audit-report.${report.audit_id}.md`) {
      try {
        const model = JSON.parse((await controlledBytes(root, `final/task-board-report-model.${report.audit_id}.json`, MAX_REPORT_BODY)).toString("utf8"));
        // A reading edition must reproduce the existing artifact before using its model.
        // The sealed bytes and their verification contract are never overwritten.
        if (model.protocol === "task-board.v1" && model.artifact_type === "task-board-final-report"
          && model.audit_id === report.audit_id && [1, 2, 3].includes(model.report_version ?? 1)
          && renderBoardReport(model) === sourceBytes.toString("utf8")) {
          const structured = Buffer.from(renderStructuredBoardReport(model), "utf8");
          if (structured.length <= MAX_REPORT_BODY) { bytes = structured; format = "structured-v3"; }
        }
      } catch {
        // Other report protocols or unavailable models continue to show the sealed original.
      }
    }
    const sha256 = value => createHash("sha256").update(value).digest("hex");
    return { report, bytes, presentation: { format, source_sha256: sha256(sourceBytes), sha256: sha256(bytes), derived: !bytes.equals(sourceBytes) } };
  }

  async function repositoriesSnapshot(url = null) {
    const [items, data] = await Promise.all([runner.listRepositories({ cached: url?.searchParams.get("live") === "1" }), url ? displaySnapshot(url) : snapshot()]);
    return items.map(repository => {
      const audits = data.audits
        .filter(audit => audit.repository_id === repository.id)
        .sort((a, b) => String(b.updated_at ?? b.created_at ?? "").localeCompare(String(a.updated_at ?? a.created_at ?? "")));
      return {
        ...repository,
        audit_count: audits.length,
        active_audit_count: audits.filter(audit => ["queued", "preparing", "recovering", "running", "pausing", "paused", "cancelling"].includes(audit.status)).length,
        last_audit_at: audits[0]?.updated_at ?? audits[0]?.created_at ?? null,
        last_audit_status: audits[0]?.status ?? null,
      };
    });
  }

  const server = createHttpServer(async (request, response) => {
    securityHeaders(response);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      snapshotCache.invalidate();
      response.once("finish", () => snapshotCache.invalidate());
    }
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (workbenchUi(request, response, url)) return;
      // v2 product-space APIs deliberately use the catalog as the authority.
      // v1 continues to expose the historical repository adapter unchanged.
      if (url.pathname.startsWith("/api/v2/products")) {
        await productCatalogReady;
        if (await productMemoryRoute({ request, response, url, memory: productMemory, campaigns: productAudits, json, requestJson, assertSafeMutation,
          validateModel: async body => {
            const settings = await modelSettingsStore.get(); const model = normalizeOpenCodeModel(Object.hasOwn(body, "model") ? body.model : settings.model);
            const catalog = await modelCatalog.snapshot();
            if (model && !catalog.models.includes(model)) throw Object.assign(new Error("所选模型不在当前配置中。"), { statusCode: 422 }); return model;
          } })) return;
        const findingMemoryPath = url.pathname.match(/^\/api\/v2\/products\/([^/]+)\/findings\/([^/]+)\/memory$/);
        if (request.method === "GET" && findingMemoryPath) {
          const productId = decodeURIComponent(findingMemoryPath[1]), findingId = decodeURIComponent(findingMemoryPath[2]);
          const finding = (await snapshot()).findings.find(row => row.resource_id === findingId);
          if (!finding || recordOwnership(finding).product_id !== productId) throw Object.assign(new Error("当前产品内没有该发现。"), { statusCode: 404 });
          json(response, 200, await productMemory.issueForFinding(productId, finding, findingWorkflow.get(findingId))); return;
        }
        if (request.method === "GET" && url.pathname === "/api/v2/products") {
          json(response, 200, await productStore.listProducts(Object.fromEntries(url.searchParams)));
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/v2/products") {
          assertSafeMutation(request);
          const body = await requestJson(request);
          if (body.root_path) await productStore.canonicalScope({ name: "product-root", path: body.root_path }, 0);
          const product = await productStore.createProduct(body);
          if (body.root_path) product.root = await productMemory.store.bindRoot(product.id, { path: body.root_path });
          json(response, 201, product, { Location: `/api/v2/products/${encodeURIComponent(product.id)}`, ETag: `"${product.version}"` });
          return;
        }
        const productEventsId = matchProductPath(url.pathname, "events");
        if (request.method === "GET" && productEventsId) {
          const items = await productStore.listProductEvents(productEventsId, url.searchParams.get("after"), url.searchParams.get("limit"));
          json(response, 200, { items, count: items.length });
          return;
        }
        const productActionsId = matchProductPath(url.pathname, "actions");
        if (request.method === "POST" && productActionsId) {
          assertSafeMutation(request);
          const body = await requestJson(request);
          if (body.action === "archive") await assertProductCanArchive(productActionsId);
          const product = await productStore.productAction(productActionsId, body.action, expectedVersion(request));
          json(response, 200, product, { ETag: `"${product.version}"` });
          return;
        }
        const productId = matchProductPath(url.pathname);
        if (request.method === "GET" && productId) {
          json(response, 200, productStore.assertProduct(productId), { ETag: `"${productStore.assertProduct(productId).version}"` });
          return;
        }
        if (request.method === "PUT" && productId) {
          assertSafeMutation(request);
          const product = await productStore.updateProduct(productId, await requestJson(request), expectedVersion(request));
          json(response, 200, product, { ETag: `"${product.version}"` });
          return;
        }
        const targetsCollection = url.pathname.match(/^\/api\/v2\/products\/([^/]+)\/targets$/);
        if (targetsCollection) {
          const scopedProductId = decodeURIComponent(targetsCollection[1]);
          if (request.method === "GET") {
            json(response, 200, await productStore.listTargets(scopedProductId, Object.fromEntries(url.searchParams)));
            return;
          }
          if (request.method === "POST") {
            assertSafeMutation(request);
            const target = await productStore.createTarget(scopedProductId, await requestJson(request));
            json(response, 201, target, { Location: `/api/v2/products/${encodeURIComponent(scopedProductId)}/targets/${encodeURIComponent(target.id)}`, ETag: `"${target.version}"` });
            return;
          }
        }
        const transferCollection = url.pathname.match(/^\/api\/v2\/products\/([^/]+)\/targets\/transfer$/);
        if (request.method === "POST" && transferCollection) {
          assertSafeMutation(request);
          const body = await requestJson(request);
          productStore.validateTransferSelection(body.targets);
          const ids = body.targets.map(target => target.id).sort();
          const lockAll = (index, operation) => index === ids.length
            ? operation() : withTargetOperationLock(ids[index], () => lockAll(index + 1, operation));
          const items = await lockAll(0, async () => {
            for (const id of ids) {
              if (targetHasRunningWork(id)) throw Object.assign(new Error("所选对象仍有排队、暂停或运行中的审计/验证；本批次未修改，请先结束任务。"), { statusCode: 409, code: "target-has-active-work" });
            }
            return productStore.transferTargets(decodeURIComponent(transferCollection[1]), body.targets, body.destination_product_id);
          });
          json(response, 200, { items, count: items.length });
          return;
        }
        const targetAction = matchTargetPath(url.pathname, "actions");
        if (request.method === "POST" && targetAction) {
          assertSafeMutation(request);
          const body = await requestJson(request);
          const target = await withTargetOperationLock(targetAction.targetId, async () => {
            if (body.action === "inspect") return productStore.inspectTarget(targetAction.productId, targetAction.targetId);
            if (body.action === "copy") return productStore.copyTarget(targetAction.productId, targetAction.targetId, body);
            if (body.action === "transfer") {
              if (targetHasRunningWork(targetAction.targetId)) throw Object.assign(new Error("对象仍有排队、运行或取消中的审计/验证，不能转移。"), { statusCode: 409, code: "target-has-active-work" });
              return productStore.transferTarget(targetAction.productId, targetAction.targetId, body.destination_product_id, expectedVersion(request));
            }
            if (body.action === "archive" && targetHasRunningWork(targetAction.targetId)) {
              throw Object.assign(new Error("对象仍有排队、运行或取消中的审计/验证，不能归档。"), { statusCode: 409, code: "target-has-active-work" });
            }
            return productStore.targetAction(targetAction.productId, targetAction.targetId, body.action, expectedVersion(request));
          });
          json(response, 200, target, { ETag: target.version ? `"${target.version}"` : undefined });
          return;
        }
        const targetPath = matchTargetPath(url.pathname);
        if (targetPath) {
          if (request.method === "GET") {
            const target = productStore.getTarget(targetPath.productId, targetPath.targetId);
            json(response, 200, target, { ETag: `"${target.version}"` });
            return;
          }
          if (request.method === "PUT") {
            assertSafeMutation(request);
            const input = await requestJson(request);
            const target = await withTargetOperationLock(targetPath.targetId, () => productStore.updateTarget(targetPath.productId, targetPath.targetId, input, expectedVersion(request)));
            json(response, 200, target, { ETag: `"${target.version}"` });
            return;
          }
          if (request.method === "DELETE") {
            assertSafeMutation(request);
            const body = await requestJson(request);
            if (body.confirmation !== targetPath.targetId) throw Object.assign(new Error("删除确认必须与对象 ID 完全一致。"), { statusCode: 422, code: "target-delete-confirmation-invalid" });
            const result = await withTargetOperationLock(targetPath.targetId, async () => {
              if (targetHasRunningWork(targetPath.targetId)) throw Object.assign(new Error("对象仍有活动审计或验证，不能删除。"), { statusCode: 409, code: "target-has-active-work" });
              return productStore.deleteTarget(targetPath.productId, targetPath.targetId, expectedVersion(request));
            });
            json(response, 200, result);
            return;
          }
        }
        const auditsCollection = url.pathname.match(/^\/api\/v2\/products\/([^/]+)\/audits$/);
        if (auditsCollection) {
          const scopedProductId = decodeURIComponent(auditsCollection[1]);
          if (request.method === "GET") {
            const current = await auditsForProduct(scopedProductId);
            const data = await displaySnapshot(url);
            const summaries = new Map(data.audits.map(audit => [audit.id, audit]));
            json(response, 200, targetAuditPage(current.map(audit => mergeAuditPresentation(audit, summaries.get(audit.id) ?? auditsFromArtifacts([], [], [audit])[0])), url.searchParams));
            return;
          }
          if (request.method === "POST") {
            assertSafeMutation(request);
            const [body, settings] = await Promise.all([requestJson(request), modelSettingsStore.get()]);
            const model = normalizeOpenCodeModel(Object.hasOwn(body, "model") ? body.model : settings.model);
            const catalog = await modelCatalog.snapshot();
            if (model && !catalog.models.includes(model)) throw Object.assign(new Error("所选模型不在当前 OpenCode 配置清单中，请重新选择使用模型。"), { statusCode: 422, code: "opencode-model-not-configured" });
            const audit = await withTargetOperationLock(body.target_id, async () => {
              const frozen = await productStore.targetExecutionSnapshot(scopedProductId, body.target_id);
              const created = await runner.createAuditFromTarget({ ...body, model, target_id: frozen.target.id, execution_spec: frozen.snapshot, execution_spec_digest: frozen.digest }, request.headers["idempotency-key"]);
              const existingLink = productStore.auditLink(created.id);
              if (!existingLink) await productStore.linkAudit({ auditId: created.id, productId: scopedProductId, targetId: frozen.target.id, snapshot: frozen.snapshot, snapshotDigest: frozen.digest });
              return created;
            });
            json(response, 202, audit, { Location: `/api/v2/products/${encodeURIComponent(scopedProductId)}/audits/${encodeURIComponent(audit.id)}`, ETag: `"${audit.version}"` });
            return;
          }
        }
        const productTaskBoard = matchProductAuditPath(url.pathname, "task-board");
        if (request.method === "GET" && productTaskBoard) {
          await auditForProduct(productTaskBoard.productId, productTaskBoard.auditId);
          json(response, 200, await runner.taskBoardPage(productTaskBoard.auditId, Object.fromEntries(url.searchParams)));
          return;
        }
        const productAuditRetryDraft = matchProductAuditPath(url.pathname, "retry-draft");
        if (request.method === "POST" && productAuditRetryDraft) {
          // Private text is returned only for an explicit, product-scoped form
          // refill, with the same origin checks as submission and no caching.
          assertSafeMutation(request);
          await requestJson(request);
          await auditForProduct(productAuditRetryDraft.productId, productAuditRetryDraft.auditId);
          json(response, 200, await runner.retryDraft(productAuditRetryDraft.auditId));
          return;
        }
        const productAuditAction = matchProductAuditPath(url.pathname, "actions");
        if (request.method === "POST" && productAuditAction) {
          assertSafeMutation(request);
          const body = await requestJson(request);
          const current = await auditForProduct(productAuditAction.productId, productAuditAction.auditId);
          if (Number(expectedVersion(request)) !== current.version) throw Object.assign(new Error("审计版本已变化，请刷新后重试。"), { statusCode: 412, code: "version-mismatch" });
          const audit = body.action === "dispatch"
            ? await queueScheduler.dispatchAuditNow(productAuditAction.auditId)
            : await runner.action(productAuditAction.auditId, body.action, expectedVersion(request), request.headers["idempotency-key"]);
          json(response, 202, audit, { ETag: `"${audit.version}"` });
          return;
        }
        const productAuditEvents = matchProductAuditPath(url.pathname, "events");
        if (request.method === "GET" && productAuditEvents) {
          await auditForProduct(productAuditEvents.productId, productAuditEvents.auditId);
          await streamAuditEvents(request, response, runner, productAuditEvents.auditId);
          return;
        }
        const productAuditLogs = matchProductAuditPath(url.pathname, "logs");
        if (request.method === "GET" && productAuditLogs) {
          await auditForProduct(productAuditLogs.productId, productAuditLogs.auditId);
          const items = await runner.recentLogs(productAuditLogs.auditId, url.searchParams.get("limit"));
          json(response, 200, { items, count: items.length });
          return;
        }
        const productAuditTerminalResize = matchProductAuditPath(url.pathname, "terminal/resize");
        if (request.method === "POST" && productAuditTerminalResize) {
          assertSafeMutation(request);
          await auditForProduct(productAuditTerminalResize.productId, productAuditTerminalResize.auditId);
          const body = await requestJson(request);
          json(response, 200, await runner.resizeTerminal(productAuditTerminalResize.auditId, body.columns, body.rows));
          return;
        }
        const productAuditTerminal = matchProductAuditPath(url.pathname, "terminal");
        if (request.method === "GET" && productAuditTerminal) {
          await auditForProduct(productAuditTerminal.productId, productAuditTerminal.auditId);
          json(response, 200, await runner.terminalSnapshot(productAuditTerminal.auditId));
          return;
        }
        const productAuditArtifacts = matchProductAuditPath(url.pathname, "artifacts");
        if (request.method === "GET" && productAuditArtifacts) {
          await auditForProduct(productAuditArtifacts.productId, productAuditArtifacts.auditId);
          const data = await snapshot();
          const items = data.artifacts.filter(artifact => artifact.audit_id === productAuditArtifacts.auditId);
          json(response, 200, { items, count: items.length });
          return;
        }
        const productAudit = matchProductAuditPath(url.pathname);
        if (request.method === "GET" && productAudit) {
          const audit = await auditForProduct(productAudit.productId, productAudit.auditId);
          const data = await displaySnapshot(url);
          json(response, 200, mergeAuditPresentation(audit, data.audits.find(item => item.id === audit.id) ?? auditsFromArtifacts([], [], [audit])[0]), { ETag: `"${audit.version}"` });
          return;
        }
      }
      if (request.method === "GET" && (url.pathname === "/api/health" || url.pathname === "/api/v1/runtime/health")) {
        json(response, 200, { ok: true, service: "opencode-audit-workbench", runtime_build: runtimeBuild, runner: runner.health(), dynamic_runner: dynamicRunner.health(), request_history: { mode: "read_only" }, workbench_ui: { modernUrl: modernWorkbenchOrigin ? "/workbench" : null } });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/environment") {
        json(response, 200, await environmentService.snapshot({ force: url.searchParams.get("refresh") === "1" }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/dashboard/summary") {
        const data = await snapshot();
        json(response, 200, { ...data.summary, generated_at: data.generated_at });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/settings/queue") {
        json(response, 200, { queue: await queueScheduler.snapshot() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/settings/model") {
        json(response, 200, { model: await modelSettingsSnapshot() });
        return;
      }
      if (request.method === "PUT" && url.pathname === "/api/v1/settings/model") {
        assertSafeMutation(request);
        const body = await requestJson(request);
        const catalog = await modelCatalog.snapshot();
        await modelSettingsStore.update(body.model, catalog.models);
        json(response, 200, { model: await modelSettingsSnapshot() });
        return;
      }
      if (request.method === "PUT" && url.pathname === "/api/v1/settings/queue") {
        assertSafeMutation(request);
        json(response, 200, { queue: await queueScheduler.updateSettings(await requestJson(request)) });
        return;
      }
      if (request.method === "POST" && (url.pathname === "/api/v1/settings/queue/activate" || url.pathname === "/api/v1/settings/queue/deactivate")) {
        assertSafeMutation(request);
        await requestJson(request);
        const queue = url.pathname.endsWith("/activate") ? await queueScheduler.activate() : await queueScheduler.deactivate();
        json(response, 200, { queue });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/settings/queue/dispatch") {
        assertSafeMutation(request);
        await requestJson(request);
        await queueScheduler.triggerNow();
        json(response, 202, { queue: await queueScheduler.snapshot() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/workspace") {
        const { findings: _findings, ...workspace } = await displaySnapshot(url);
        if (url.searchParams.get("audits") === "compact") workspace.audits = compactWorkspaceAudits(workspace.audits);
        json(response, 200, workspace);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/repositories") {
        const items = await repositoriesSnapshot(url);
        json(response, 200, { items, count: items.length });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/repositories") {
        assertSafeMutation(request);
        const repository = await runner.addRepository(await requestJson(request), request.headers["idempotency-key"]);
        await productStore.importLegacyRepository(runner.runtimeRepositories().find(item => item.id === repository.id));
        json(response, 201, repository, { Location: `/api/v1/repositories/${encodeURIComponent(repository.id)}` });
        return;
      }
      const repositoryDelete = url.pathname.match(/^\/api\/v1\/repositories\/([^/]+)$/);
      if (request.method === "DELETE" && repositoryDelete) {
        assertSafeMutation(request);
        const repositoryId = decodeURIComponent(repositoryDelete[1]);
        const body = await requestJson(request);
        if (body.confirmation !== repositoryId) throw Object.assign(new Error("删除确认必须与项目 ID 完全一致。"), { statusCode: 422, code: "repository-delete-confirmation-invalid" });
        await assertLegacyUndefinedTarget(repositoryId);
        const repository = (await repositoriesSnapshot()).find(item => item.id === repositoryId);
        if (!repository) throw Object.assign(new Error("审计项目不存在。"), { statusCode: 404, code: "repository-not-found" });
        if ((repository.audit_count ?? 0) > 0) throw Object.assign(new Error("该项目仍有关联审计；请先删除这些审计任务。"), { statusCode: 409, code: "repository-has-audits" });
        json(response, 200, await runner.removeRepository(repositoryId));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/audits") {
        const data = await displaySnapshot(url);
        json(response, 200, paginateAudits(data.audits, url.searchParams));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/audits") {
        assertSafeMutation(request);
        const [input, settings] = await Promise.all([requestJson(request), modelSettingsStore.get()]);
        await assertLegacyUndefinedTarget(input.repository_id);
        const model = normalizeOpenCodeModel(Object.hasOwn(input, "model") ? input.model : settings.model);
        const catalog = await modelCatalog.snapshot();
        if (model && !catalog.models.includes(model)) {
          throw Object.assign(new Error("所选模型不在当前 OpenCode 配置清单中，请重新选择使用模型。"), { statusCode: 422, code: "opencode-model-not-configured" });
        }
        const audit = await runner.createAudit({ ...input, model }, request.headers["idempotency-key"]);
        if (!productStore.auditLink(audit.id)) {
          const target = productStore.targetById(audit.repository_id);
          if (target) {
            const frozen = await productStore.targetExecutionSnapshot(UNDEFINED_PRODUCT_ID, target.id);
            await productStore.linkAudit({ auditId: audit.id, productId: UNDEFINED_PRODUCT_ID, targetId: target.id, snapshot: frozen.snapshot, snapshotDigest: frozen.digest });
          }
        }
        json(response, 202, audit, { Location: `/api/v1/audits/${encodeURIComponent(audit.id)}`, ETag: `"${audit.version}"` });
        return;
      }
      const auditId = matchAuditPath(url.pathname);
      if (request.method === "DELETE" && auditId) {
        assertSafeMutation(request);
        const body = await requestJson(request);
        if (body.confirmation !== auditId) throw Object.assign(new Error("删除确认必须与 audit_id 完全一致。"), { statusCode: 422, code: "audit-delete-confirmation-invalid" });
        await assertLegacyUndefinedAudit(auditId);
        const data = await snapshot();
        const audit = data.audits.find(item => item.id === auditId);
        if (!audit) throw Object.assign(new Error("审计不存在。"), { statusCode: 404, code: "audit-not-found" });
        const expected = String(request.headers["if-match"] ?? "").replaceAll('"', "");
        if (Number(expected) !== audit.version) throw Object.assign(new Error("审计版本已变化，请刷新后重试。"), { statusCode: 412, code: "version-mismatch" });
        const runnerAudit = runner.getAudit(auditId);
        if (runnerAudit && ["preparing", "recovering", "running", "pausing", "paused", "cancelling"].includes(runnerAudit.status)) {
          throw Object.assign(new Error("运行中的审计不能删除；请先取消并等待任务结束。"), { statusCode: 409, code: "audit-delete-active" });
        }
        const activeValidations = dynamicRunner.listRuns().filter(run => run.audit_id === auditId && ["preparing", "running", "cancelling"].includes(run.status));
        if (activeValidations.length) throw Object.assign(new Error("该审计仍有动态验证正在运行；请先取消并等待验证结束。"), { statusCode: 409, code: "audit-validation-active" });
        const artifacts = data.artifacts.filter(artifact => artifact.audit_id === auditId && artifact.repository_id === audit.repository_id);
        const validationRunsRemoved = await dynamicRunner.deleteAuditRuns(auditId);
        const findingWorkflowsRemoved = await findingWorkflow.deleteAudit(auditId, audit.repository_id);
        const result = await runner.deleteAudit(auditId, {
          repositoryId: audit.repository_id,
          expectedVersion: expected,
          artifactPaths: artifacts.map(artifact => artifact.path),
        });
        json(response, 200, {
          ...result,
          removed_validation_runs: validationRunsRemoved,
          removed_finding_workflows: findingWorkflowsRemoved,
        });
        return;
      }
      if (request.method === "GET" && auditId) {
        const data = await displaySnapshot(url);
        const repositoryId = url.searchParams.get("repository_id");
        const audit = data.audits.find(item => item.id === auditId && (!repositoryId || item.repository_id === repositoryId));
        if (!audit) json(response, 404, { error: "audit-not-found" });
        else json(response, 200, audit, { ETag: `"${audit.version}"` });
        return;
      }
      const boardAuditId = matchAuditPath(url.pathname, "task-board");
      if (request.method === "GET" && boardAuditId) {
        await assertLegacyUndefinedAudit(boardAuditId);
        json(response, 200, await runner.taskBoardPage(boardAuditId, Object.fromEntries(url.searchParams)));
        return;
      }
      const actionAuditId = matchAuditPath(url.pathname, "actions");
      if (request.method === "POST" && actionAuditId) {
        assertSafeMutation(request);
        const body = await requestJson(request);
        await assertLegacyUndefinedAudit(actionAuditId);
        const expected = String(request.headers["if-match"] ?? "").replaceAll('"', "");
        let audit;
        if (body.action === "dispatch") {
          const current = runner.getAudit(actionAuditId);
          if (!current) throw Object.assign(new Error("审计不存在。"), { statusCode: 404, code: "audit-not-found" });
          if (Number(expected) !== current.version) {
            throw Object.assign(new Error("审计版本已变化，请刷新后重试。"), { statusCode: 412, code: "version-mismatch" });
          }
          audit = await queueScheduler.dispatchAuditNow(actionAuditId);
        } else {
          audit = await runner.action(actionAuditId, body.action, expected, request.headers["idempotency-key"]);
        }
        json(response, 202, audit, { ETag: `"${audit.version}"` });
        return;
      }
      const eventAuditId = matchAuditPath(url.pathname, "events");
      if (request.method === "GET" && eventAuditId) {
        await streamAuditEvents(request, response, runner, eventAuditId);
        return;
      }
      const logAuditId = matchAuditPath(url.pathname, "logs");
      if (request.method === "GET" && logAuditId) {
        const items = runner.getAudit(logAuditId) ? await runner.recentLogs(logAuditId, url.searchParams.get("limit")) : [];
        json(response, 200, { items, count: items.length });
        return;
      }
      const terminalAuditId = matchAuditPath(url.pathname, "terminal");
      if (request.method === "GET" && terminalAuditId) {
        json(response, 200, await runner.terminalSnapshot(terminalAuditId));
        return;
      }
      const terminalResizeAuditId = matchAuditPath(url.pathname, "terminal/resize");
      if (request.method === "POST" && terminalResizeAuditId) {
        assertSafeMutation(request);
        const body = await requestJson(request);
        json(response, 200, await runner.resizeTerminal(terminalResizeAuditId, body.columns, body.rows));
        return;
      }
      const artifactAuditId = matchAuditPath(url.pathname, "artifacts");
      if (request.method === "GET" && artifactAuditId) {
        const data = await snapshot();
        const items = data.artifacts.filter(artifact => artifact.audit_id === artifactAuditId);
        json(response, 200, { items, count: items.length });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/findings") {
        const data = await displaySnapshot(url);
        json(response, 200, paginateFindings(data.findings, url));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/provenance/options") {
        const data = await snapshot();
        const products = new Map();
        for (const record of [...data.audits, ...data.reports, ...data.findings]) {
          const source = record.provenance;
          if (source?.product_id) products.set(source.product_id, { id: source.product_id, name: source.product_name });
        }
        json(response, 200, { products: [...products.values()],
          audits: data.audits.map(audit => ({ id: audit.id, name: audit.name, product_id: audit.provenance?.product_id, repository_id: audit.repository_id })),
          reports: data.reports.map(report => ({ id: report.id, name: report.name, audit_id: report.audit_id, product_id: report.provenance?.product_id })) });
        return;
      }
      const findingDetail = url.pathname.match(/^\/api\/v1\/findings\/([^/]+)$/);
      if (request.method === "GET" && findingDetail) {
        const data = await snapshot();
        const finding = data.findings.find(item => item.resource_id === decodeURIComponent(findingDetail[1]));
        if (!finding) throw Object.assign(new Error("没有找到对应漏洞。"), { statusCode: 404, code: "finding-not-found" });
        json(response, 200, finding);
        return;
      }
      const productFindingWorkflow = url.pathname.match(/^\/api\/v2\/products\/([^/]+)\/findings\/([^/]+)\/workflow$/);
      const findingWorkflowId = productFindingWorkflow ? decodeURIComponent(productFindingWorkflow[2]) : matchFindingWorkflowPath(url.pathname);
      if (request.method === "POST" && findingWorkflowId) {
        assertSafeMutation(request);
        const data = await snapshot();
        const finding = data.findings.find(item => item.resource_id === findingWorkflowId);
        if (!finding) throw Object.assign(new Error("没有找到对应漏洞。"), { statusCode: 404, code: "finding-not-found" });
        if (productFindingWorkflow) {
          const productId = decodeURIComponent(productFindingWorkflow[1]);
          productStore.assertProduct(productId);
          if (recordOwnership(finding).product_id !== productId) throw Object.assign(new Error("产品空间内没有该漏洞。"), { statusCode: 404, code: "product-finding-not-found" });
        } else await assertLegacyUndefinedAudit(finding.audit_id);
        const body = await requestJson(request);
        const expected = String(request.headers["if-match"] ?? "0").replaceAll('"', "");
        const workflow = await findingWorkflow.update({
          finding,
          status: body.status,
          note: body.note ?? "",
          expectedVersion: expected,
          idempotencyKey: request.headers["idempotency-key"],
        });
        const owner = recordOwnership(finding).product_id;
        if (owner) await productMemory.syncLegacyFeedback(owner, finding, workflow);
        snapshotCache.invalidate();
        json(response, 200, workflow, { ETag: `"${workflow.version}"` });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/reports") {
        const data = await snapshot();
        json(response, 200, { items: data.reports, count: data.reports.length });
        return;
      }
      const reportDownloadId = matchReportPath(url.pathname, "download");
      if (request.method === "GET" && reportDownloadId) {
        const { report, bytes, presentation } = await reportContent(reportDownloadId, { original: url.searchParams.get("format") === "original" });
        const fileName = `security-audit-report.${String(report.audit_id).replaceAll(/[^A-Za-z0-9._-]/g, "-")}${presentation.derived ? ".structured" : ""}.md`;
        response.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Length": bytes.length,
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Cache-Control": "no-store",
        });
        response.end(bytes);
        return;
      }
      const reportId = matchReportPath(url.pathname);
      if (request.method === "GET" && reportId) {
        const { report, bytes, presentation } = await reportContent(reportId);
        const body = bytes.toString("utf8");
        json(response, 200, { ...report, body, presentation, rendered_html: markdownRenderer.render(body), rendering: "markdown-it-html-disabled" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/validation-requests") {
        const items = (await validationRequests()).filter(item => matchesProvenance(item, url.searchParams));
        json(response, 200, { items, count: items.length });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/runtime-audits") {
        const data = await displaySnapshot(new URL("/api/v1/workspace?live=1", url));
        const items = data.audits.filter(audit => audit.runtime_testing_state)
          .map(audit => ({ ...audit, audit_id: audit.id }))
          .filter(audit => matchesProvenance(audit, url.searchParams));
        json(response, 200, { items, count: items.length });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/validation-activity") {
        const activity = await validationActivity();
        json(response, 200, filterValidationActivity(activity, url.searchParams));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/http-exchanges") {
        const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 100, 500));
        const items = (await httpExchanges()).filter(item => matchesProvenance(item, url.searchParams)).slice(0, limit);
        json(response, 200, { items, count: items.length });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/http-exchanges/export/bruno") {
        assertSafeMutation(request);
        const body = await requestJson(request);
        if (!Array.isArray(body.exchange_ids) || body.exchange_ids.length < 1 || body.exchange_ids.length > 100) {
          throw Object.assign(new Error("Bruno 导出必须选择 1-100 条记录。"), { statusCode: 422, code: "bruno-export-selection-invalid" });
        }
        const ids = [...new Set(body.exchange_ids.map(value => String(value)))];
        if (ids.some(id => !/^http_[A-Za-z0-9-]+$/.test(id))) {
          throw Object.assign(new Error("Bruno 导出的 exchange ID 无效。"), { statusCode: 422, code: "bruno-export-id-invalid" });
        }
        const available = new Map((await httpExchanges()).map(exchange => [exchange.exchange_id, exchange]));
        const exchanges = ids.map(id => available.get(id) ?? null);
        const missingIndex = exchanges.findIndex(value => !value);
        if (missingIndex >= 0) {
          throw Object.assign(new Error(`没有找到 HTTP exchange：${ids[missingIndex]}`), { statusCode: 404, code: "exchange-not-found" });
        }
        if (body.format != null && !["bruno-json", "opencollection"].includes(body.format)) {
          throw Object.assign(new Error("导出格式必须为 bruno-json 或 opencollection。"), { statusCode: 422, code: "bruno-export-format-invalid" });
        }
        const archive = body.format === "opencollection" ? buildOpenCollectionArchive(exchanges) : buildBrunoCollection(exchanges);
        binary(response, 200, archive.bytes, archive.mime_type ?? "application/zip", archive.filename);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/http-exchanges/export/har") {
        assertSafeMutation(request);
        const body = await requestJson(request);
        if (!Array.isArray(body.exchange_ids) || body.exchange_ids.length < 1 || body.exchange_ids.length > 100) {
          throw Object.assign(new Error("HAR 导出必须选择 1-100 条记录。"), { statusCode: 422, code: "har-export-selection-invalid" });
        }
        const ids = [...new Set(body.exchange_ids.map(value => String(value)))];
        if (ids.some(id => !/^http_[A-Za-z0-9-]+$/.test(id))) throw Object.assign(new Error("HAR 导出的 exchange ID 无效。"), { statusCode: 422, code: "har-export-id-invalid" });
        const available = new Map((await httpExchanges()).map(exchange => [exchange.exchange_id, exchange]));
        const exchanges = ids.map(id => available.get(id) ?? null);
        const missingIndex = exchanges.findIndex(value => !value);
        if (missingIndex >= 0) throw Object.assign(new Error(`没有找到 HTTP exchange：${ids[missingIndex]}`), { statusCode: 404, code: "exchange-not-found" });
        const archive = buildHar(exchanges);
        binary(response, 200, archive.bytes, "application/json", archive.filename);
        return;
      }
      const exchangeDetail = url.pathname.match(/^\/api\/v1\/http-exchanges\/([^/]+)$/);
      if (request.method === "GET" && exchangeDetail) {
        const value = await httpExchange(decodeURIComponent(exchangeDetail[1]));
        if (!value) json(response, 404, { error: "exchange-not-found" });
        else json(response, 200, { exchange: value });
        return;
      }
      const productValidation = url.pathname.match(/^\/api\/v2\/products\/([^/]+)\/validations$/);
      if (request.method === "POST" && (url.pathname === "/api/v1/validations" || productValidation)) {
        assertSafeMutation(request);
        const input = await requestJson(request);
        if (!productValidation) await assertLegacyUndefinedTarget(input.repository_id);
        else productStore.getTarget(decodeURIComponent(productValidation[1]), input.repository_id);
        const repository = runner.runtimeRepositories().find(item => item.id === input.repository_id);
        if (!repository) throw Object.assign(new Error("仓库不在服务端白名单中。"), { statusCode: 422, code: "repository-not-allowed" });
        const requests = await validationRequests();
        const descriptor = requests.find(item => item.id === input.validation_request_id && item.repository_id === repository.id);
        if (!descriptor) throw Object.assign(new Error("没有找到动态验证请求。"), { statusCode: 404, code: "validation-request-not-found" });
        if (productValidation) await auditForProduct(decodeURIComponent(productValidation[1]), descriptor.audit_id);
        if (!descriptor.artifact_dispatch_ready) throw Object.assign(new Error("没有找到可调度的密封动态验证请求。"), { statusCode: 422, code: "validation-request-not-ready" });
        const source = runner.artifactSources().find(item => item.repository_id === repository.id);
        const root = runtimeSources().find(item => item.repository.id === repository.id)?.root;
        const executionPaths = await runner.ensureExecutionWorkspace(descriptor.audit_id, repository.id);
        const audit = runner.getAudit(descriptor.audit_id);
        const run = await dynamicRunner.create({
          input,
          repository,
          reportsRoot: source.reports_root,
          runtimeRoot: root,
          executionPaths,
          requestDescriptor: { ...descriptor, request_id: descriptor.id, id: descriptor.job_id, model: audit?.model ?? null },
          idempotencyKey: request.headers["idempotency-key"],
        });
        json(response, 202, run, { Location: `/api/v1/validations/${encodeURIComponent(run.id)}`, ETag: `"${run.version}"` });
        return;
      }
      const validationAction = url.pathname.match(/^\/api\/v1\/validations\/([^/]+)\/actions$/);
      if (request.method === "POST" && validationAction) {
        assertSafeMutation(request);
        const body = await requestJson(request);
        if (body.action !== "cancel") throw Object.assign(new Error("动态验证当前只支持取消操作。"), { statusCode: 409, code: "validation-action-not-allowed" });
        json(response, 202, await dynamicRunner.cancel(decodeURIComponent(validationAction[1])));
        return;
      }
      const validationEvents = url.pathname.match(/^\/api\/v1\/validations\/([^/]+)\/events$/);
      if (request.method === "GET" && validationEvents) {
        await streamValidationEvents(request, response, dynamicRunner, decodeURIComponent(validationEvents[1]));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/runs") {
        const runs = (await validationRuns()).filter(run => matchesProvenance(run, url.searchParams));
        json(response, 200, { runs, count: runs.length });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/runs/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/runs/".length));
        const run = await validationRun(id);
        if (!run) json(response, 404, { error: "run-not-found" });
        else json(response, 200, { run });
        return;
      }
      if (request.method === "GET" && await staticResponse(response, url.pathname)) return;
      if (request.method !== "GET") json(response, 405, { error: "method-not-allowed" });
      else json(response, 404, { error: "not-found" });
    } catch (error) {
      json(response, error.statusCode ?? 500, { error: error.code ?? "internal-error", message: error.message });
    }
  });
  server.shutdownRunners = async () => {
    await productAudits.shutdown();
    await queueScheduler.shutdown();
    await Promise.all([runner.shutdown(), dynamicRunner.shutdown()]);
    await productMemory.shutdown(); await productStore.writeQueue;
    productStore.close();
  };
  server.productMemory = productMemory; server.productAudits = productAudits;
  server.productStore = productStore;
  server.productCatalogReady = productCatalogReady;
  return server;
}

export function createValidationObservatoryServer(options = {}) {
  return createAuditWorkbenchServer({
    ...options,
    repositories: options.repositories ?? [{ id: "workspace", name: "OpenCode Multi Agents", path: PROJECT_ROOT }],
    legacyRuntimeRoot: options.legacyRuntimeRoot ?? options.repositories === undefined,
  });
}

export function parseArgs(argv) {
  const options = {
    host: process.env.AUDIT_WORKBENCH_HOST ?? process.env.DYNAMIC_VALIDATION_WEB_HOST ?? "127.0.0.1",
    port: Number(process.env.AUDIT_WORKBENCH_PORT ?? process.env.DYNAMIC_VALIDATION_WEB_PORT ?? 4173),
    runtimeRoot: process.env.DYNAMIC_VALIDATION_RUNTIME_ROOT ?? DEFAULT_RUNTIME_ROOT,
    stateRoot: process.env.AUDIT_WORKBENCH_STATE_ROOT ?? DEFAULT_STATE_ROOT,
    runnerEnabled: false,
    dynamicRunnerEnabled: false,
    modernWorkbenchOrigin: normalizeModernOrigin(process.env.AUDIT_WORKBENCH_MODERN_ORIGIN),
    repositories: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--host") options.host = argv[++index];
    else if (option === "--port") options.port = Number(argv[++index]);
    else if (option === "--modern-ui-origin") {
      if (!argv[index + 1]) throw new Error("--modern-ui-origin 需要 HTTP(S) origin。");
      options.modernWorkbenchOrigin = normalizeModernOrigin(argv[++index]);
    }
    else if (option === "--runtime-root") options.runtimeRoot = argv[++index];
    else if (option === "--state-root") options.stateRoot = argv[++index];
    else if (option === "--enable-runner") options.runnerEnabled = true;
    else if (option === "--enable-dynamic-validation") options.dynamicRunnerEnabled = true;
    else if (option === "--repo") {
      const value = argv[++index] ?? "";
      const separator = value.indexOf("=");
      if (separator < 1) throw new Error("--repo 必须使用 id=/absolute/path 格式");
      const path = value.slice(separator + 1);
      if (!isAbsolute(path)) throw new Error("--repo 必须使用 id=/absolute/path 格式");
      options.repositories.push({ id: value.slice(0, separator), path });
    } else throw new Error(`Unknown argument: ${option}`);
  }
  if (!BIND_HOSTS.has(options.host)) throw new Error("工作台只支持 localhost、loopback 地址或 0.0.0.0 监听");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("Invalid port");
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const server = createAuditWorkbenchServer(options);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const host = options.host === "::1" || options.host === "[::1]" ? `[${options.host.replaceAll("[", "").replaceAll("]", "")}]` : options.host;
      const modes = [options.runnerEnabled ? "静态审计 Runner 已启用" : "静态只读", options.dynamicRunnerEnabled ? "动态验证 Runner 已启用" : "动态验证只读"];
      process.stdout.write(`OpenCode 审计工作台已启动：http://${host}:${address.port}（${modes.join("；")}）\n`);
    });
    let shuttingDown = false;
    const shutdown = async signal => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.stdout.write(`收到 ${signal}，正在停止工作台创建的 OpenCode 子进程…\n`);
      await server.shutdownRunners();
      server.close(() => { process.exitCode = 0; });
    };
    process.once("SIGINT", () => shutdown("SIGINT").catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }));
    process.once("SIGTERM", () => shutdown("SIGTERM").catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
