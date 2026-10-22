import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { PROTOCOL, EXPLORATION_PROTOCOL, runtimeProtocol, PHASES, SHA, ID, TERMINAL, CLEANUP, OUTCOMES, digest, check, validatePacket, validateSubmission } from "./contract.mjs";
import { checkedJson } from "./controller.mjs";

export function validateRuntimeEvidence(value, intake = null) {
  const errors = [];
  if (!runtimeProtocol(value?.protocol) || value?.artifact_type !== "runtime-testing-evidence-set" || value?.artifact_digest !== digest(value)) return ["runtime-evidence-header-invalid"];
  if (!SHA.test(value.authorization_digest ?? "") || !ID.test(value.audit_id ?? "") || !["CLOSED", "SKIPPED", "BLOCKED", "QUARANTINED"].includes(value.status)
    || !CLEANUP.has(value.cleanup_status) || !Number.isInteger(value.elapsed_ms) || value.elapsed_ms < 0) errors.push("runtime-evidence-state-invalid");
  if (intake && (value.audit_id !== intake.audit_id || value.artifact_digest !== intake.policy?.runtime_testing?.evidence_digest
    || value.authorization_digest !== intake.policy?.runtime_testing?.authorization_digest)) errors.push("runtime-evidence-intake-binding-invalid");
  const ids = new Set(); const bindings = new Set();
  if (!Array.isArray(value.evidence_bindings) || !Array.isArray(value.packets)) return [...errors, "runtime-evidence-members-invalid"];
  for (const binding of value.evidence_bindings) {
    if (!ID.test(binding.id ?? "") || bindings.has(binding.id) || binding.path !== `evidence/${binding.id}.json` || !SHA.test(binding.sha256 ?? "")) errors.push("runtime-evidence-binding-invalid");
    bindings.add(binding.id);
  }
  for (const packet of value.packets) {
    if (!ID.test(packet.id ?? "") || ids.has(packet.id) || !PHASES.includes(packet.phase) || !TERMINAL.has(packet.execution_status) || !CLEANUP.has(packet.cleanup_status) || !OUTCOMES.has(packet.outcome)) errors.push("runtime-packet-terminal-invalid");
    ids.add(packet.id);
    if (packet.result) {
      const result = packet.result;
      if (result.outcome === "SUPPORTED" && (result.execution_status !== "COMPLETED" || !result.evidence_ids?.length)) errors.push("runtime-supported-evidence-invalid");
      if (packet.result_path !== `packets/${packet.id}.result.json` || !Array.isArray(packet.evidence_ids)
        || new Set(packet.evidence_ids).size !== packet.evidence_ids.length
        || packet.evidence_ids.some(id => typeof id !== "string" || !id.startsWith(`${packet.id}.action-`) || !bindings.has(id))) errors.push("runtime-packet-evidence-ownership-invalid");
      if (digest(result) !== packet.result_digest || result.artifact_digest !== packet.result_digest || result.input_digest !== packet.input_digest
        || result.authorization_digest !== value.authorization_digest || result.environment_revision !== value.environment_revision
        || result.audit_id !== value.audit_id || result.packet_id !== packet.id || result.execution_status !== packet.execution_status
        || result.outcome !== packet.outcome || result.cleanup_status !== packet.cleanup_status
        || !Array.isArray(result.evidence_ids) || result.evidence_ids.some(id => !bindings.has(id))) errors.push("runtime-packet-result-invalid");
    } else if (!["SKIPPED", "FAILED"].includes(packet.execution_status) || packet.outcome !== "INCONCLUSIVE") errors.push("runtime-packet-result-missing");
    if (packet.phase === "CONFIRM" && packet.result) {
      const finding = intake?.findings?.find(item => item.finding_id === packet.finding_id);
      // Changed candidates remain historical; runtimeForFinding excludes stale object digests.
      if (finding && packet.scope_digest !== intake.scope_digest) errors.push("runtime-finding-scope-mismatch");
    }
  }
  if (value.status === "SKIPPED" && (value.packets.length || value.evidence_bindings.length || value.elapsed_ms)) errors.push("runtime-skipped-has-execution");
  return [...new Set(errors)];
}

export async function verifyRuntimeEvidenceFiles(path, intake = null) {
  const root = dirname(path); const value = JSON.parse(await readFile(path, "utf8"));
  check(validateRuntimeEvidence(value, intake).length === 0, "runtime-evidence-invalid");
  const grant = await checkedJson(root, "authorization.json");
  check(digest(grant) === value.authorization_digest && grant.protocol === value.protocol && grant.artifact_digest === value.authorization_digest && grant.audit_id === value.audit_id
    && grant.environment_revision === value.environment_revision && (!intake || grant.scope_digest === intake.scope_digest), "runtime-evidence-authorization-invalid");
  for (const revision of value.finding_revisions ?? []) {
    if (!value.scopes?.some(scope => scope.id === revision.scope_id && scope.kind === 'FINAL_REPORT_FINDING')) continue;
    const source = await checkedJson(root, 'source-report.json', revision.report?.sha256);
    check(source.protocol === 'report-validation.v1' && digest(source) === source.artifact_digest
      && digest(source.source) === digest(revision.source_report)
      && source.findings.some(finding => finding.finding_id === revision.finding_id && digest(finding) === revision.finding_object_digest), 'runtime-report-source-changed');
  }
  for (const binding of value.evidence_bindings) {
    const record = await checkedJson(root, binding.path, binding.sha256);
    check(record.protocol === value.protocol && record.audit_id === value.audit_id && record.artifact_digest === digest(record), "runtime-evidence-record-invalid");
  }
  for (const packet of value.packets.filter(row => row.result)) {
    const input = await checkedJson(root, `packets/${packet.id}.input.json`);
    validatePacket(input, grant); check(digest(input) === packet.input_digest && input.artifact_digest === packet.input_digest, "runtime-packet-input-changed");
    for (const field of ["id", "phase", "hypothesis_id", "finding_id", "finding_object_digest", "vulnerability_type_id", "focus_area_id", "scope_digest", "finding_revision_id"]) {
      check((input[field] ?? null) === (packet[field] ?? null), "runtime-packet-input-binding-invalid");
    }
    if (value.protocol === EXPLORATION_PROTOCOL && ["EXPLORE", "CONFIRM"].includes(packet.phase)) {
      check(digest(input.scope_ref) === digest(packet.scope_ref), "runtime-packet-scope-changed");
      check(value.scopes?.some(scope => scope.id === input.scope_ref.id && scope.kind === input.scope_ref.kind && digest(scope) === input.scope_ref.digest), "runtime-packet-scope-unregistered");
      if (packet.phase === "CONFIRM") check(value.finding_revisions?.some(revision => revision.id === input.finding_revision_id && revision.scope_id === input.scope_ref.id
        && revision.finding_id === input.finding_id && revision.finding_object_digest === input.finding_object_digest), "runtime-finding-revision-unregistered");
    }
    const result = await checkedJson(root, packet.result_path);
    check(digest(result) === packet.result_digest && result.artifact_digest === packet.result_digest, "runtime-packet-result-changed");
    if (["COMPLETED", "SKIPPED", "BLOCKED"].includes(result.execution_status)) {
      const { execution_status, outcome, cleanup_status, summary, evidence_ids, observations, gaps, changes, proof } = result;
      validateSubmission({ execution_status, outcome, cleanup_status, summary, evidence_ids, observations, gaps, changes, proof }, input, new Set(packet.evidence_ids));
    }
  }
  return value;
}

export function runtimeForFinding(evidence, finding) {
  const bound = evidence.packets.filter(packet => packet.finding_id === finding.finding_id && packet.finding_object_digest === (finding.finding_object_digest ?? digest(finding)));
  const hypotheses = new Set(bound.map(packet => packet.hypothesis_id).filter(Boolean));
  const packets = evidence.packets.filter(packet => bound.includes(packet) || packet.phase === "EXPLORE" && hypotheses.has(packet.hypothesis_id));
  return { status: evidence.status === "SKIPPED" ? "SKIPPED" : packets.length ? "AVAILABLE" : "NOT_TESTED", packets };
}

export function runtimeCandidates(evidence, sourceFindings = []) {
  if (!Array.isArray(evidence?.packets)) return [];
  const mapped = new Set(evidence.packets.filter(packet => packet.phase === "CONFIRM" && sourceFindings.some(finding =>
    (finding.finding_id === packet.finding_id || evidence.protocol === EXPLORATION_PROTOCOL && !finding.finding_id)
    && (finding.finding_object_digest ?? (evidence.protocol === EXPLORATION_PROTOCOL ? digest(finding) : null)) === packet.finding_object_digest)).map(packet => packet.hypothesis_id));
  const latest = new Map(evidence.packets.filter(packet => (packet.phase === "EXPLORE" || evidence.protocol === EXPLORATION_PROTOCOL && packet.phase === "CONFIRM") && packet.result?.outcome === "SUPPORTED" && !mapped.has(packet.hypothesis_id)).map(packet => [packet.hypothesis_id, packet]));
  return [...latest.values()]
    .map(packet => ({ finding_id: `runtime-${packet.id}`, claim_scope: "RUNTIME_ONLY", source_mapping: "UNKNOWN", packet_id: packet.id,
      ...(packet.scope_ref?.kind === 'FINAL_REPORT_FINDING' ? { source_finding_id: packet.finding_id,
        source_report: evidence.scopes.find(scope => scope.id === packet.scope_ref.id)?.source_report } : {}),
      ...(evidence.protocol === EXPLORATION_PROTOCOL ? { title: packet.result?.summary, scope_ref: packet.scope_ref,
        evidence_chain: evidence.packets.filter(row => row.phase === "CONTACT" || row.hypothesis_id === packet.hypothesis_id || row.scope_ref?.id === packet.scope_ref?.id)
          .map(row => ({ packet_id: row.id, input_digest: row.input_digest, result_digest: row.result_digest, outcome: row.outcome, evidence_ids: row.evidence_ids ?? [] })), deployment_binding: "UNKNOWN" } : {}),
      vulnerability_type_id: packet.vulnerability_type_id, evidence_digest: packet.result_digest, scope_digest: packet.scope_digest }));
}
