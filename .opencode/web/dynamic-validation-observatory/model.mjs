import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalizeBrowserExchangeV2 } from "./http-exchange.mjs";
import { webValidationCapability } from "./web-validation-policy.mjs";
import { redactJsonText } from "../../lib/json-text-redaction.mjs";
import { validateExternalRuntimeValidationRequest } from "../../skills/common-subagent/finding-evidence-contract/scripts/external-runtime-validation-contract.mjs";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const SECRET_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "passwd",
  "secret",
  "access_token",
  "refresh_token",
  "credential_value",
  "credentials",
]);
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeRelative(root, candidate) {
  const absoluteRoot = resolve(root);
  const absolute = resolve(candidate);
  const rel = relative(absoluteRoot, absolute);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) return null;
  return rel;
}

async function readJson(path, root) {
  if (safeRelative(root, path) === null) throw new Error("artifact-outside-runtime-root");
  const linkInfo = await lstat(path);
  if (linkInfo.isSymbolicLink()) throw new Error("artifact-symlink-forbidden");
  const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
  if (safeRelative(realRoot, realPath) === null) throw new Error("artifact-realpath-outside-runtime-root");
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_JSON_BYTES) throw new Error("artifact-size-invalid");
  return JSON.parse(await readFile(path, "utf8"));
}

async function readOptionalJson(path, root) {
  try {
    return await readJson(path, root);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function redactString(value) {
  return value
    .replace(/(["'](?:password|passwd|secret|token|access_token|refresh_token|authorization|cookie)["']\s*:\s*["'])[^"']+(["'])/gi, "$1[REDACTED]$2")
    .replace(/\b(password|passwd|secret|token|access_token|refresh_token|authorization|cookie)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[JWT_REDACTED]")
    .replace(/(?:\/Users\/[^/\s]+|\/home\/[^/\s]+)\/[^\s"',)]+/g, "[LOCAL_PATH]")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+\\[^\s"',)]+/g, "[LOCAL_PATH]");
}

export function sanitizeForWeb(value, key = "") {
  if (SECRET_KEYS.has(key.toLowerCase())) return "[REDACTED]";
  if (typeof value === "string") {
    // JSON bodies are text evidence: preserve numeric literals and escaping,
    // and replace complete credential values instead of matching partial quotes.
    try { return redactJsonText(value, {
      sensitiveKey: name => SECRET_KEYS.has(name.toLowerCase()) || /(?:authorization|cookie|password|passwd|secret|token|apikey|credentials|session|sessionid)$/i.test(name.replace(/[^a-z0-9]/gi, "")),
      redactString,
    }); } catch { return redactString(value); }
  }
  if (Array.isArray(value)) {
    if (key === "headers") {
      return value.map(header => {
        if (!isObject(header)) return sanitizeForWeb(header);
        const name = String(header.name ?? "");
        return {
          name,
          value: SENSITIVE_HEADERS.has(name.toLowerCase()) ? "[REDACTED]" : sanitizeForWeb(header.value),
        };
      });
    }
    return value.map(item => sanitizeForWeb(item));
  }
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitizeForWeb(child, childKey)]));
}

function publicArtifactPath(path, runtimeRoot) {
  if (typeof path !== "string") return null;
  const rel = safeRelative(runtimeRoot, path);
  return rel === null ? null : rel.split(sep).join("/");
}

async function artifactJson(artifact, evidenceRoot, auditRoot) {
  if (!artifact || artifact.media_type !== "application/json" || artifact.sanitized !== true) return null;
  const rel = publicArtifactPath(artifact.path, evidenceRoot);
  if (!rel) return null;
  try {
    const [realAudit, realEvidence] = await Promise.all([realpath(auditRoot), realpath(evidenceRoot)]);
    if (realEvidence !== resolve(realAudit, relative(auditRoot, evidenceRoot))) return null;
    return sanitizeForWeb(await readJson(join(evidenceRoot, rel), evidenceRoot));
  } catch {
    return null;
  }
}

function runId(auditId, findingId) {
  return `${auditId}::${findingId}`;
}

function runSummary(detail) {
  return {
    id: detail.id,
    audit_id: detail.audit_id,
    finding_id: detail.finding.id,
    agent_name: detail.actor.agent_name,
    recorded_at: detail.recorded_at,
    outcome: detail.finding.outcome,
    verification_level: detail.finding.verification_level,
    cleanup_status: detail.finding.cleanup?.status ?? "UNKNOWN",
    target_origin: detail.environment.base_url,
    exchange_count: detail.network.exchange_count,
    network_capture_status: detail.network.status,
  };
}

function normalizeExchange(exchange, reference) {
  const safe = sanitizeForWeb(exchange), normalized = normalizeBrowserExchangeV2(safe, reference);
  // Keep explicit legacy ownership fields for the activity reader to check;
  // normalizing v1 must not erase a conflicting source declaration.
  const ownership = value => Object.fromEntries(["repository_id", "audit_id", "finding_id"].filter(key => value?.[key] != null).map(key => [key, value[key]]));
  return { ...normalized, ...ownership(safe), evidence_binding: { ...normalized.evidence_binding, ...ownership(safe.evidence_binding) } };
}

async function loadNetwork(result, artifactById, evidenceRoot, auditRoot) {
  const trace = result.network_trace;
  if (!isObject(trace) || trace.schema_version !== 1 || !Array.isArray(trace.exchanges)) {
    return {
      status: "NOT_CAPTURED",
      completeness: "NONE",
      exchange_count: 0,
      exchanges: [],
      warning: "该历史运行未持久化成对的 HTTP 请求/响应证据。",
    };
  }

  const exchanges = [];
  for (const reference of trace.exchanges) {
    const artifact = artifactById.get(reference.artifact_id);
    const value = await artifactJson(artifact, evidenceRoot, auditRoot);
    if (value) exchanges.push(normalizeExchange(value, reference));
  }
  exchanges.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  return {
    status: exchanges.length === trace.exchanges.length ? "CAPTURED" : "PARTIAL",
    completeness: trace.completeness ?? "KEY_EXCHANGES",
    exchange_count: exchanges.length,
    exchanges,
    warning: exchanges.length === trace.exchanges.length ? null : "部分 HTTP exchange 证据缺失或无法读取。",
  };
}

async function buildDetail(runtimeRoot, auditId, resultFile) {
  const auditRoot = join(runtimeRoot, auditId);
  const resultPath = join(auditRoot, resultFile);
  const result = await readJson(resultPath, auditRoot);
  const findingId = resultFile.slice(0, -".result.json".length);
  if (!findingId || result.finding_id != null && result.finding_id !== findingId || result.audit_id != null && result.audit_id !== auditId) {
    throw new Error("validation-result-source-binding-mismatch");
  }
  // Legacy validator contract: <audit>/<finding>/evidence/**. Missing source
  // fields in v1 exchanges may only be filled from this verified directory.
  const evidenceRoot = join(auditRoot, findingId, "evidence");
  const [target, request, envelope, resultStat] = await Promise.all([
    readOptionalJson(join(auditRoot, `${findingId}.target.json`), runtimeRoot),
    readOptionalJson(join(auditRoot, "request.json"), runtimeRoot),
    readOptionalJson(join(auditRoot, "envelope-output.json"), runtimeRoot),
    stat(resultPath),
  ]);
  const artifacts = Array.isArray(result.evidence_artifacts) ? result.evidence_artifacts : [];
  const artifactById = new Map(artifacts.map(artifact => [artifact.artifact_id, artifact]));
  const network = await loadNetwork(result, artifactById, evidenceRoot, auditRoot);
  const observations = [];
  for (const observation of result.observations ?? []) {
    const evidence = [];
    for (const artifactId of observation.evidence_artifact_ids ?? []) {
      const artifact = artifactById.get(artifactId);
      evidence.push({
        artifact_id: artifactId,
        path: publicArtifactPath(artifact?.path, evidenceRoot) === null ? null : publicArtifactPath(artifact?.path, runtimeRoot),
        data: await artifactJson(artifact, evidenceRoot, auditRoot),
      });
    }
    observations.push(sanitizeForWeb({ ...observation, evidence }));
  }

  return sanitizeForWeb({
    id: runId(auditId, findingId),
    audit_id: auditId,
    recorded_at: result.recorded_at ?? resultStat.mtime.toISOString(),
    recorded_at_source: result.recorded_at ? "result" : "file_mtime",
    actor: {
      agent_name: envelope?.agent_name ?? "dynamic-vulnerability-validator",
      agent_session_id: envelope?.agent_session_id ?? result.validator?.session_id ?? null,
      validator_project: result.validator?.project ?? null,
      validator_version: result.validator?.version ?? null,
    },
    environment: {
      base_url: target?.target?.base_url ?? null,
      allowed_origins: target?.target?.allowed_origins ?? [],
      authorization: target?.authorization ?? null,
      account_roles: target?.accounts ?? null,
      source_repository: request?.source_binding?.repository_id ?? null,
      source_commit: request?.source_binding?.commit ?? null,
      browser_backend: result.browser_backend ?? null,
      attacker_context_id: result.xss_verification?.attacker_context_id ?? null,
      victim_context_id: result.xss_verification?.victim_context_id ?? null,
      binding_digest: target?.binding_digest ?? null,
    },
    finding: {
      id: findingId,
      vulnerability_type_id: request?.claim?.vulnerability_type_id ?? null,
      summary: request?.claim?.summary ?? null,
      expected_security_effect: request?.claim?.expected_security_effect ?? null,
      static_state: request?.static_assessment?.state ?? null,
      primary_location: request?.source_binding?.primary_location ?? null,
      outcome: result.outcome ?? envelope?.payload?.outcome ?? "UNKNOWN",
      verification_level: result.xss_verification?.level ?? envelope?.payload?.xss_verification_level ?? null,
      preferred_goal_met: result.xss_verification?.preferred_goal_met ?? false,
      proof_id: result.xss_verification?.proof_id ?? null,
      cleanup: result.xss_verification?.cleanup ?? null,
      residual_gaps: result.residual_gaps ?? envelope?.payload?.residual_gaps ?? [],
    },
    methods: result.methods ?? [],
    observations,
    network,
    safety_attestation: result.safety_attestation ? {
      isolated_test_environment: result.safety_attestation.isolated_test_environment,
      production_targets_contacted: result.safety_attestation.production_targets_contacted,
      third_party_targets_contacted: result.safety_attestation.third_party_targets_contacted,
      real_credentials_used: result.safety_attestation.real_credentials_used,
      destructive_actions_performed: result.safety_attestation.destructive_actions_performed,
    } : null,
  });
}

export async function listValidationRunDetails(runtimeRoot) {
  let auditEntries = [];
  try {
    auditEntries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const details = [];
  for (const auditEntry of auditEntries) {
    if (!auditEntry.isDirectory()) continue;
    const auditId = auditEntry.name;
    const files = await readdir(join(runtimeRoot, auditId), { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".result.json")) continue;
      try {
        details.push(await buildDetail(runtimeRoot, auditId, file.name));
      } catch (error) {
        details.push({
          id: runId(auditId, file.name.slice(0, -".result.json".length)),
          audit_id: auditId,
          recorded_at: null,
          actor: { agent_name: "dynamic-vulnerability-validator" },
          finding: { id: file.name.slice(0, -".result.json".length), outcome: "READ_ERROR", cleanup: null },
          environment: { base_url: null },
          network: { status: "READ_ERROR", exchange_count: 0 },
          error: error.message,
        });
      }
    }
  }
  return details.sort((left, right) => String(right.recorded_at ?? "").localeCompare(String(left.recorded_at ?? "")));
}

export async function listValidationRuns(runtimeRoot) {
  return (await listValidationRunDetails(runtimeRoot)).map(runSummary);
}

export async function getValidationRun(runtimeRoot, id) {
  return (await listValidationRunDetails(runtimeRoot)).find(detail => detail.id === id) ?? null;
}

export async function listValidationRequests(runtimeRoot) {
  let auditEntries = [];
  try {
    auditEntries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const requests = [];
  for (const auditEntry of auditEntries) {
    if (!auditEntry.isDirectory()) continue;
    const auditRoot = join(runtimeRoot, auditEntry.name);
    const files = await readdir(auditRoot, { withFileTypes: true });
    const requestFiles = files.filter(file => file.isFile() && (file.name === "request.json" || file.name.endsWith(".request.json")));
    for (const file of requestFiles) {
      try {
        const request = await readJson(join(auditRoot, file.name), runtimeRoot);
        const findingId = request.finding_id;
        if (!findingId) continue;
        const resultPresent = files.some(candidate => candidate.isFile() && candidate.name === `${findingId}.result.json`);
        const envelopeFile = files.find(candidate => candidate.isFile() && candidate.name === `${findingId}.envelope-input.json`)
          ?? (file.name === "request.json" ? files.find(candidate => candidate.isFile() && candidate.name === "envelope-input.json") : null);
        const capability = await webValidationCapability(request.claim?.vulnerability_type_id);
        const requestErrors = validateExternalRuntimeValidationRequest(request);
        requests.push(sanitizeForWeb({
          id: runId(request.audit_id ?? auditEntry.name, findingId),
          audit_id: request.audit_id ?? auditEntry.name,
          finding_id: findingId,
          request_id: request.request_id ?? null,
          request_digest: request.packet_digest ?? null,
          vulnerability_type_id: request.claim?.vulnerability_type_id ?? null,
          summary: request.claim?.summary ?? null,
          expected_security_effect: request.claim?.expected_security_effect ?? null,
          source_repository: request.source_binding?.repository_id ?? null,
          source_commit: request.source_binding?.commit ?? null,
          network_policy: request.validation_policy?.network_access ?? null,
          credential_policy: request.validation_policy?.credentials ?? null,
          request_path: publicArtifactPath(join(auditRoot, file.name), runtimeRoot),
          envelope_path: envelopeFile ? publicArtifactPath(join(auditRoot, envelopeFile.name), runtimeRoot) : null,
          result_present: resultPresent,
          validation_type_supported: Boolean(capability),
          validator: capability?.validator ?? null,
          dispatch_blockers: [
            ...(requestErrors.length ? ["request-invalid"] : []),
            ...(!capability ? ["validation-type-unsupported"] : []),
            ...(resultPresent ? ["validation-result-exists"] : []),
          ],
          dispatch_ready: !resultPresent && requestErrors.length === 0 && Boolean(capability),
        }));
      } catch {
        // Invalid request artifacts remain invisible to dispatch and available on disk for manual diagnosis.
      }
    }
  }
  return requests.sort((left, right) => left.id.localeCompare(right.id));
}
