import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { dirname } from "node:path";
import { renderFinalReport, validateFinalReportModel } from "../../skills/common-subagent/audit-coverage-accounting/scripts/final-report-model-core.mjs";
import { renderBoardReport } from "../../lib/task-board/review.mjs";
import { applyAuditProgress } from "./audit-progress.mjs";

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACTS = 5000;
const REPORT_EXTENSIONS = new Set([".json", ".md", ".sarif"]);
const REPORT_DIRECTORIES = new Set([
  "bac",
  "adjudication",
  "attack-chains",
  "checkpoints",
  "correlation",
  "coverage",
  "final",
  "sarif",
  "stage-deliveries",
  "validation",
  "vulnerability-mining",
  "task-board",
]);

const STAGES = [
  { id: "scope", label: "范围冻结" },
  { id: "recon", label: "资产侦察" },
  { id: "threat", label: "威胁建模" },
  { id: "audit", label: "多维漏洞审计" },
  { id: "correlation", label: "证据关联" },
  { id: "adjudication", label: "发现裁决" },
  { id: "validation", label: "验证复核" },
  { id: "report", label: "报告封存" },
];

function safeRelative(root, candidate) {
  const absoluteRoot = resolve(root);
  const absolute = resolve(candidate);
  const value = relative(absoluteRoot, absolute);
  if (value.startsWith("..") || isAbsolute(value) || value.split(sep).includes("..")) return null;
  return value;
}

function normalizedPath(root, candidate) {
  const value = safeRelative(root, candidate);
  return value === null ? null : value.split(sep).join("/");
}

async function collectFiles(root, current = root, depth = 0, output = []) {
  if (output.length >= MAX_ARTIFACTS || depth > 4) return output;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return output;
    throw error;
  }
  for (const entry of entries) {
    if (output.length >= MAX_ARTIFACTS) break;
    if (entry.name.startsWith(".")) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, path, depth + 1, output);
    } else if (entry.isFile() && REPORT_EXTENSIONS.has(extname(entry.name))) {
      output.push(path);
    }
  }
  return output;
}

async function readJsonArtifact(path, info) {
  if (info.size > MAX_ARTIFACT_BYTES) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function auditIdFromFileName(fileName) {
  const patterns = [
    /^security-audit-report\.(.+)\.md$/,
    /^coverage-(?:plan|summary|verification|structural-v1)\.(.+)\.(?:json|md)$/,
    /^semantic-coverage-verification\.(.+)\.json$/,
    /^vuln-judger-review\.(.+)\.(?:json|md)$/,
  ];
  for (const pattern of patterns) {
    const match = fileName.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function artifactKind(path) {
  const first = path.split("/")[0];
  return REPORT_DIRECTORIES.has(first) ? first : "other";
}

export function finalReportArtifactForAudit(artifacts, auditId) {
  const canonicalPath = `final/security-audit-report.${auditId}.md`;
  return artifacts.find(artifact => artifact.audit_id === auditId
    && artifact.path === canonicalPath
    && artifact.kind === "final"
    && artifact.media_type === "text/markdown") ?? null;
}

function finalReportModelForAudit(artifacts, auditId) {
  const canonicalPath = `final/security-audit-report-model.${auditId}.json`;
  const candidates = artifacts
    .filter(artifact => artifact.kind === "final"
      && artifact.media_type === "application/json"
      && artifact.data?.audit_id === auditId)
    .sort((left, right) => Number(right.path === canonicalPath) - Number(left.path === canonicalPath)
      || right.modified_at.localeCompare(left.modified_at));
  for (const artifact of candidates) {
    try {
      if (artifact.data?.protocol === "task-board.v1" && artifact.data.artifact_type === "task-board-final-report"
        && artifact.path === `final/task-board-report-model.${auditId}.json`) return { artifact, model: artifact.data };
      if (validateFinalReportModel(artifact.data).length === 0
        && ["FINAL", "POLICY_FINAL", "PARTIAL_FINAL"].includes(artifact.data.report_kind)) return { artifact, model: artifact.data };
    } catch {
      // Continue looking for another valid, audit-bound final report model.
    }
  }
  return null;
}

// A completed model has a deterministic Markdown representation.  Materializing a
// missing canonical file is a local repair, not a re-run of the audit or a new
// report synthesis.  Existing files are deliberately never overwritten.
export async function materializeFinalReportFromModel({ reportsRoot, auditId }) {
  const root = resolve(reportsRoot);
  const canonicalPath = `final/security-audit-report.${auditId}.md`;
  const outputPath = resolve(root, canonicalPath);
  if (normalizedPath(root, outputPath) !== canonicalPath) {
    throw new Error("最终报告目标路径越出受控报告目录。");
  }
  const artifacts = await scanReportArtifacts(root);
  const existing = finalReportArtifactForAudit(artifacts, auditId);
  if (existing) return { available: true, materialized: false, artifact: existing, model_path: null };
  const source = finalReportModelForAudit(artifacts, auditId);
  if (!source) return { available: false, materialized: false, artifact: null, model_path: null };
  const markdown = source.model.protocol === "task-board.v1" ? renderBoardReport(source.model) : renderFinalReport(source.model);
  if (Buffer.byteLength(markdown, "utf8") > MAX_ARTIFACT_BYTES) {
    return { available: false, materialized: false, artifact: null, model_path: source.artifact.path, error: "final-report-render-too-large" };
  }
  await mkdir(dirname(outputPath), { recursive: true });
  let created = false;
  try {
    await stat(outputPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const temporary = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, markdown, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, outputPath);
    created = true;
  }
  const repaired = finalReportArtifactForAudit(await scanReportArtifacts(root), auditId);
  return {
    available: Boolean(repaired),
    materialized: created && Boolean(repaired),
    artifact: repaired,
    model_path: source.artifact.path,
  };
}

export async function scanReportArtifacts(reportsRoot) {
  const root = resolve(reportsRoot);
  const files = await collectFiles(root);
  const artifacts = [];
  for (const path of files) {
    const rel = normalizedPath(root, path);
    if (!rel) continue;
    const info = await stat(path);
    const extension = extname(path);
    const data = extension === ".json" || extension === ".sarif" ? await readJsonArtifact(path, info) : null;
    const auditId = typeof data?.audit_id === "string" ? data.audit_id : auditIdFromFileName(path.split(sep).at(-1));
    if (!auditId) continue;
    const kind = artifactKind(rel);
    artifacts.push({
      id: createHash("sha256").update(rel).digest("hex").slice(0, 24),
      audit_id: auditId,
      kind,
      path: rel,
      media_type: extension === ".md" ? "text/markdown" : extension === ".sarif" ? "application/sarif+json" : "application/json",
      size: info.size,
      modified_at: info.mtime.toISOString(),
      data,
    });
  }
  return artifacts.sort((left, right) => right.modified_at.localeCompare(left.modified_at));
}

function hasArtifact(artifacts, kind, fragment = null) {
  return artifacts.some(artifact => artifact.kind === kind && (!fragment || artifact.path.includes(fragment)));
}

function stageSnapshot(artifacts, runtimeCount, materialized = null) {
  if (materialized) return materialized.stages.map(stage => ({
    id: stage.id,
    label: stage.label,
    state: stage.state,
    round: stage.round,
    manifest_path: stage.manifest_path,
    manifest_digest: stage.manifest_digest,
    issues: stage.errors,
  }));
  const reached = {
    scope: hasArtifact(artifacts, "coverage", "coverage-plan."),
    recon: hasArtifact(artifacts, "coverage", "coverage-plan."),
    threat: hasArtifact(artifacts, "coverage", "coverage-plan."),
    audit: hasArtifact(artifacts, "vulnerability-mining"),
    correlation: hasArtifact(artifacts, "correlation"),
    adjudication: hasArtifact(artifacts, "adjudication"),
    validation: hasArtifact(artifacts, "validation") || runtimeCount > 0,
    report: hasArtifact(artifacts, "final"),
  };
  let contiguousReached = -1;
  for (let index = 0; index < STAGES.length && reached[STAGES[index].id]; index += 1) contiguousReached = index;
  const hasOutOfOrderEvidence = STAGES.some((stage, index) => index > contiguousReached + 1 && reached[stage.id]);
  const activeIndex = hasOutOfOrderEvidence ? -1 : contiguousReached + 1;
  return STAGES.map((stage, index) => ({
    ...stage,
    state: reached[stage.id] ? "completed" : index === activeIndex ? "active" : "pending",
  }));
}

function coverageFromArtifacts(artifacts) {
  const summary = artifacts.find(artifact => artifact.path.includes("coverage-summary.") && artifact.media_type === "application/json")?.data;
  if (!summary) return null;
  return {
    status: summary.coverage_status ?? (summary.complete ? "COMPLETE" : "UNKNOWN"),
    complete: summary.complete === true,
    files: summary.inventory?.files ?? summary.files?.complete_entities ?? null,
    functions: summary.functions?.complete_entities ?? null,
    vulnerability_types: summary.vulnerability_types?.fully_checked ?? summary.vulnerability_types?.checks ?? null,
    external_interfaces: summary.external_interfaces?.complete_entities ?? null,
    manifest_digest: summary.manifest_digest ?? null,
  };
}

function currentStageLabel({ stages, todo, todoEnforced, completed }) {
  if (todoEnforced && (todo?.running || todo?.pending)) {
    return `多维漏洞审计 · ${todo.done ?? 0}/${todo.total ?? 0}`;
  }
  if (todoEnforced && !todo?.complete) return "多维漏洞审计 · 需处理失败项";
  const activeStage = stages.find(stage => stage.state === "active");
  if (activeStage) return activeStage.label;
  const completedCount = stages.filter(stage => stage.state === "completed").length;
  if (!completed && completedCount > 0) return "制品不连续";
  return completed ? "报告封存" : "等待开始";
}

function severityRank(value) {
  return ({ CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 })[String(value ?? "").toUpperCase()] ?? -1;
}

function displayText(value, limit = 4000) {
  const text = Array.isArray(value)
    ? value.map(item => displayText(item, limit)).filter(Boolean).join("\n")
    : typeof value === "string"
      ? value
      : value?.summary ?? value?.description ?? value?.claim ?? value?.rationale ?? value?.outcome ?? value?.note ?? value?.control ?? null;
  if (!text) return null;
  const normalized = String(text).trim();
  if (!normalized) return null;
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function positiveInteger(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function locationFrom(value, role = null) {
  if (!value || typeof value !== "object") return null;
  const path = [value.path, value.file, value.file_path, value.source_file, value.uri]
    .find(item => typeof item === "string" && item.trim()) ?? null;
  const line = positiveInteger(value.line ?? value.line_start ?? value.start_line);
  const lineEnd = positiveInteger(value.line_end ?? value.end_line);
  const detail = displayText(value.detail ?? value.description ?? value.snippet ?? value.claim ?? value.rationale, 1000);
  if (!path && !detail) return null;
  return { path, line, line_end: lineEnd && (!line || lineEnd >= line) ? lineEnd : null, detail, role };
}

function normalizedLocations(raw) {
  const candidates = [];
  const add = (value, role = null) => {
    for (const item of Array.isArray(value) ? value : [value]) {
      const location = locationFrom(item, role);
      if (location) candidates.push(location);
    }
  };

  // 旧版 correlation artifact 使用 locations 数组；Finding v2 使用
  // locations.primary，并把源/汇证据的位置放进 evidence.facts[].locator。
  if (Array.isArray(raw.locations)) {
    add(raw.locations);
  } else if (raw.locations && typeof raw.locations === "object") {
    add(raw.locations.primary, "主位置");
    for (const key of ["secondary", "related", "additional", "affected"]) add(raw.locations[key], key);
  }
  add(raw.primary_location, "主位置");
  add(raw.affected_locations, "受影响位置");
  add(raw.additional_locations, "补充位置");
  add(raw.source_binding?.primary_location, "主位置");
  if (raw.file || raw.location) {
    add(typeof raw.location === "object" ? raw.location : {
      path: raw.file,
      line: raw.line_start ?? raw.line,
      line_end: raw.line_end,
      detail: typeof raw.location === "string" ? raw.location : raw.lines,
    }, "主位置");
  }
  for (const fact of Array.isArray(raw.evidence?.facts) ? raw.evidence.facts : []) {
    const role = typeof fact?.kind === "string" && fact.kind ? `${fact.kind} 证据` : "证据位置";
    add(fact?.locator ?? fact?.location, role);
  }

  const locations = [];
  const seen = new Map();
  for (const candidate of candidates) {
    // 同一文件同一起始行的主定位与 evidence locator 表示同一个锚点；
    // line_end 的差异不应令它在页面里重复出现。
    const key = `${candidate.path ?? ""}\u0000${candidate.line ?? ""}`;
    const existing = seen.get(key);
    if (existing) {
      if (!existing.line_end && candidate.line_end) existing.line_end = candidate.line_end;
      if (candidate.detail && !existing.detail?.includes(candidate.detail)) {
        existing.detail = existing.detail ? `${existing.detail}\n${candidate.detail}` : candidate.detail;
      }
      continue;
    }
    seen.set(key, candidate);
    locations.push(candidate);
    if (locations.length >= 20) break;
  }
  return locations;
}

function normalizedEvidence(raw) {
  const values = [];
  const add = (items, fallbackKind = "证据") => {
    for (const item of Array.isArray(items) ? items : [items]) {
      const text = displayText(item?.claim ?? item?.description ?? item?.summary ?? item);
      if (!text) continue;
      values.push({
        kind: typeof item?.kind === "string" && item.kind ? item.kind : fallbackKind,
        text,
        location: locationFrom(item?.locator ?? item?.location),
      });
    }
  };
  add(raw.evidence?.facts);
  add(raw.sink_evidence, "汇点证据");
  add(raw.control_evidence, "控制证据");
  add(raw.config_evidence, "配置证据");
  add(raw.blind_evidence, "盲测证据");
  add(raw.seeded_evidence, "变体证据");
  add(raw.mitigating_evidence, "缓解证据");
  add((raw.source_findings ?? []).map(item => item?.title ? {
    kind: item.lens ? `来源候选 / ${item.lens}` : "来源候选",
    claim: item.title,
    locator: item.location,
  } : null).filter(Boolean), "来源候选");
  return values.slice(0, 24);
}

function normalizedDimensions(raw) {
  const dimensions = [
    ...(Array.isArray(raw.dimensions) ? raw.dimensions : []),
    ...(typeof raw.dimension === "string" ? [raw.dimension] : []),
    ...(Array.isArray(raw.classification?.dimension_claims)
    ? raw.classification.dimension_claims.map(item => item?.dimension).filter(item => typeof item === "string" && item)
    : []),
  ].filter(item => typeof item === "string" && item.trim());
  return dimensions.length ? [...new Set(dimensions)].join("、") : null;
}

function normalizedStatus(raw) {
  if (typeof raw.validation_state === "string" && raw.validation_state) return raw.validation_state;
  if (typeof raw.status === "string" && raw.status) return raw.status;
  const states = {
    SUPPORTED_RUNTIME: "supported_runtime",
    SUPPORTED_STATIC: "supported_static",
    REJECTED: "rejected",
    INCONCLUSIVE: "insufficient_evidence",
  };
  return states[raw.state] ?? "unvalidated";
}

function normalizedSeverity(raw) {
  const value = raw.severity;
  if (typeof value === "string") return value.toUpperCase();
  if (value && typeof value === "object") {
    const label = value.rating ?? value.level ?? value.label ?? value.severity;
    if (typeof label === "string" && label) return label.toUpperCase();
  }
  return "UNKNOWN";
}

function normalizeFinding(raw, auditId, sourcePath) {
  const locations = normalizedLocations(raw);
  const location = locations[0] ?? {};
  const evidence = normalizedEvidence(raw);
  const sourceFindings = Array.isArray(raw.source_findings) ? raw.source_findings : [];
  const sourceTypes = [...new Set(sourceFindings.map(item => item?.vuln_type ?? item?.vulnerability_type_id).filter(item => typeof item === "string" && item))];
  const vulnerabilityType = raw.vulnerability_type_id ?? raw.classification?.vulnerability_type_id ?? raw.cwe ?? (sourceTypes.length ? sourceTypes.join("、") : null);
  const evidenceSummary = evidence.slice(0, 3).map(item => `${item.kind}：${item.text}`).join("\n");
  const description = displayText(raw.description ?? raw.summary ?? raw.claim?.summary)
    ?? displayText(raw.attack_surface?.impact?.outcome)
    ?? (evidenceSummary || null)
    ?? displayText(raw.severity?.rationale)
    ?? "未提供漏洞判断摘要。";
  return {
    id: raw.canonical_id ?? raw.finding_id ?? raw.id ?? createHash("sha256").update(`${auditId}:${sourcePath}:${raw.title ?? "finding"}`).digest("hex").slice(0, 16),
    audit_id: auditId,
    title: raw.title ?? raw.summary ?? raw.claim?.title ?? raw.classification?.title ?? (vulnerabilityType ? `漏洞类型：${vulnerabilityType}` : "未命名漏洞发现"),
    severity: normalizedSeverity(raw),
    cvss_score: raw.cvss_score ?? raw.cvss?.score ?? raw.severity?.cvss?.score ?? null,
    status: normalizedStatus(raw),
    dimension: normalizedDimensions(raw),
    vulnerability_type_id: vulnerabilityType,
    description,
    location,
    locations,
    location_complete: Boolean(location.path && location.line),
    evidence,
    impact: displayText(raw.attack_surface?.impact?.outcome ?? raw.impact),
    severity_rationale: displayText(raw.severity?.rationale),
    reachability: displayText(raw.reachability?.rationale ?? raw.reachability?.state),
    attacker_influence: displayText(raw.attacker_influence?.rationale ?? raw.attacker_influence?.state),
    guards: displayText(raw.guards ?? raw.attack_surface?.controls),
    remediation: displayText(raw.remediation?.summary ?? raw.remediation),
    residual_uncertainty: displayText(raw.residual_uncertainty ?? raw.uncertainty?.assumptions ?? raw.attack_surface?.blindspots),
    source_finding_ids: sourceFindings.slice(0, 32).map(item => item?.finding_id ?? item?.id).filter(Boolean),
    contradiction_count: Array.isArray(raw.contradictions) ? raw.contradictions.length : 0,
    source_path: sourcePath,
  };
}

export function findingsFromArtifacts(artifacts) {
  const byAudit = new Map();
  for (const artifact of artifacts.filter(item => item.kind === "correlation")) {
    if (byAudit.has(artifact.audit_id)) continue;
    const findings = Array.isArray(artifact.data?.canonical_findings) ? artifact.data.canonical_findings : [];
    if (findings.length) byAudit.set(artifact.audit_id, findings.map(item => normalizeFinding(item, artifact.audit_id, artifact.path)));
  }
  for (const artifact of artifacts.filter(item => item.kind === "vulnerability-mining")) {
    if (byAudit.has(artifact.audit_id)) continue;
    const current = byAudit.get(artifact.audit_id) ?? [];
    const findings = Array.isArray(artifact.data?.findings) ? artifact.data.findings : [];
    for (const item of findings) current.push(normalizeFinding(item, artifact.audit_id, artifact.path));
    byAudit.set(artifact.audit_id, current);
  }
  const seen = new Set();
  return [...byAudit.values()].flat().filter(finding => {
    const key = `${finding.audit_id}:${finding.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => severityRank(right.severity) - severityRank(left.severity));
}

function reportFromArtifact(artifact) {
  return {
    id: artifact.id,
    audit_id: artifact.audit_id,
    name: `安全审计报告 · ${artifact.audit_id}`,
    path: artifact.path,
    size: artifact.size,
    sealed_at: artifact.modified_at,
    media_type: artifact.media_type,
  };
}

export function auditsFromArtifacts(artifacts, validationRuns = [], runnerAudits = [], stageDeliveriesByAudit = new Map()) {
  const groups = new Map();
  for (const artifact of artifacts) {
    const current = groups.get(artifact.audit_id) ?? [];
    current.push(artifact);
    groups.set(artifact.audit_id, current);
  }
  for (const run of validationRuns) if (!groups.has(run.audit_id)) groups.set(run.audit_id, []);
  for (const run of runnerAudits) if (!groups.has(run.id)) groups.set(run.id, []);
  const runnerById = new Map(runnerAudits.map(run => [run.id, run]));
  const findings = findingsFromArtifacts(artifacts);
  return [...groups.entries()].map(([auditId, auditArtifacts]) => {
    const runtimeCount = validationRuns.filter(run => run.audit_id === auditId).length;
    const runner = runnerById.get(auditId);
    const materialized = stageDeliveriesByAudit.get(auditId);
    const useMaterialized = Boolean(materialized && (runner?.stage_delivery_enforcement === "ENFORCED"
      || materialized.completed_count > 0));
    const stages = stageSnapshot(auditArtifacts, runtimeCount, useMaterialized ? materialized : null);
    const board = runner?.task_board;
    const todo = runner?.todo ?? null;
    const lastModified = auditArtifacts.map(item => item.modified_at).sort().at(-1) ?? runner?.updated_at ?? null;
    const completedCount = stages.filter(stage => stage.state === "completed").length;
    const completed = completedCount === stages.length;
    const todoEnforced = runner?.stage_delivery_enforcement === "TODO_ENFORCED" && Number(todo?.total ?? 0) > 0;
    const progress = todoEnforced ? Number(todo.progress ?? 0) : Math.round((completedCount / stages.length) * 100);
    return applyAuditProgress({
      id: auditId,
      name: runner?.name ?? `仓库级安全审计 · ${auditId}`,
      repository_id: runner?.repository_id ?? null,
      repository_name: runner?.repository_name ?? null,
      commit: runner?.commit ?? null,
      status: runner?.status ?? (completed ? "completed" : "artifact_only"),
      version: runner?.version ?? 1,
      event_sequence: runner?.event_sequence ?? 0,
      stage: board ? board.publication !== "SEALED" ? "任务规划与发布" : !board.mining_complete ? `任务执行 · ${board.reported}/${board.total}` : board.validation?.status !== "REVIEWED" ? "报告内容复核" : "报告封存" : currentStageLabel({ stages, todo, todoEnforced, completed }),
      stages,
      progress,
      progress_source: board ? "task-board" : todoEnforced ? "local-audit-todo" : useMaterialized ? "stage-delivery-manifest" : "legacy-artifact-heuristic",
      task_protocol: runner?.task_protocol ?? null,
      mining_strategy: runner?.mining_strategy ?? null,
      task_board: runner?.task_board ?? null,
      completion_source: runner?.completion_source ?? null,
      finding_count: findings.filter(finding => finding.audit_id === auditId).length,
      runtime_validation_count: runtimeCount,
      artifact_count: auditArtifacts.length,
      coverage: coverageFromArtifacts(auditArtifacts),
      bac_analysis: runner?.bac_analysis ?? null,
      bac_summary: finalReportModelForAudit(auditArtifacts, auditId)?.model.bac_analysis ?? null,
      created_at: runner?.created_at ?? lastModified,
      updated_at: runner?.updated_at ?? lastModified,
      exit_code: runner?.exit_code ?? null,
      error: runner?.error ?? null,
      execution_transport: runner?.execution_transport ?? null,
      terminal: runner?.terminal ?? null,
      queue: runner?.queue ?? null,
      paths: runner?.paths ?? null,
      provider_session_id: runner?.provider_session_id ?? runner?.terminal?.provider_session_id ?? null,
      recovery_count: Number(runner?.recovery_count ?? 0),
      last_recovered_at: runner?.last_recovered_at ?? null,
      interrupted_at: runner?.interrupted_at ?? null,
      interruption_reason: runner?.interruption_reason ?? null,
      todo_completion: runner?.todo_completion ?? null,
      stage_delivery: runner?.stage_delivery ?? null,
      task_context: runner?.task_context ?? {
        additional_instructions_enabled: false,
        additional_instructions_length: 0,
        test_environment_enabled: false,
        test_environment_length: 0,
        dynamic_validation_enabled: false,
      },
      todo,
    });
  }).sort((left, right) => String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")));
}

export async function buildWorkspaceSnapshot({ reportsRoot, validationRuns = [], runnerAudits = [] }) {
  const artifacts = await scanReportArtifacts(reportsRoot);
  const findings = findingsFromArtifacts(artifacts);
  const stageDeliveriesByAudit = new Map(runnerAudits
    .filter(audit => Array.isArray(audit.stage_delivery?.stages))
    .map(audit => [audit.id, audit.stage_delivery]));
  const audits = auditsFromArtifacts(artifacts, validationRuns, runnerAudits, stageDeliveriesByAudit);
  const reports = artifacts
    .filter(artifact => artifact.kind === "final" && artifact.media_type === "text/markdown")
    .filter(artifact => finalReportArtifactForAudit(artifacts, artifact.audit_id)?.id === artifact.id)
    .map(artifact => {
      const model = finalReportModelForAudit(artifacts, artifact.audit_id)?.model;
      return { ...reportFromArtifact(artifact), finding_index_available: Boolean(model),
        finding_ids: (model?.findings ?? []).map(row => row.finding_id ?? row.canonical_id ?? row.id).filter(Boolean),
        excluded_finding_ids: (model?.excluded_findings ?? []).map(row => row.finding_id ?? row.canonical_id ?? row.id).filter(Boolean) };
    });
  const severity = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const finding of findings) {
    const key = finding.severity.toLowerCase();
    severity[key in severity ? key : "unknown"] += 1;
  }
  return {
    generated_at: new Date().toISOString(),
    summary: {
      audit_count: audits.length,
      active_audits: audits.filter(audit => ["queued", "preparing", "recovering", "running", "pausing", "paused", "cancelling"].includes(audit.status)).length,
      completed_audits: audits.filter(audit => audit.status === "completed").length,
      finding_count: findings.length,
      report_count: reports.length,
      validation_run_count: validationRuns.length,
      severity,
    },
    audits,
    findings,
    reports,
    artifacts: artifacts.map(({ data, markdown, ...metadata }) => metadata),
  };
}
