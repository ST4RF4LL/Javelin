import { createHash } from "node:crypto";
import { parseCvssV31Vector } from "./cvss-v31.mjs";
import { validateFindingReportDetails } from "./finding-report-details.mjs";

export const FINDING_SCHEMA_VERSION = 2;
export const FINDING_STATES = new Set([
  "HYPOTHESIS",
  "CANDIDATE",
  "SUPPORTED_STATIC",
  "SUPPORTED_RUNTIME",
  "REJECTED",
  "INCONCLUSIVE",
]);
export const LENSES = new Set(["sink-driven", "control-driven", "config-driven"]);
export const DIMENSIONS = new Set(Array.from({ length: 10 }, (_, index) => `D${index + 1}`));
export const DISCOVERY_TRACKS = new Set(["coverage", "blind", "seeded-variant"]);
export const ATTACK_SURFACE_SCHEMA_VERSION = 1;

const IN_SCOPE_STATES = new Set(["YES", "NO", "UNKNOWN"]);
const EXPOSURE_STATES = new Set(["PUBLIC", "AUTHENTICATED", "INTERNAL", "LOCAL", "BUILD_TIME", "NONE", "UNKNOWN"]);
const VECTOR_STATES = new Set(["NETWORK", "ADJACENT", "LOCAL", "PHYSICAL", "SUPPLY_CHAIN", "NONE", "UNKNOWN"]);
const AUTH_SCOPE_STATES = new Set([
  "UNAUTHENTICATED",
  "AUTHENTICATED",
  "PRIVILEGED",
  "ADMIN",
  "OPERATOR",
  "DEVELOPER",
  "NOT_APPLICABLE",
  "UNKNOWN",
]);
const PRECONDITION_FEASIBILITY = new Set(["PLAUSIBLE", "CONSTRAINED", "UNPROVEN"]);
const BOUNDARY_STATES = new Set(["PROVEN", "PLAUSIBLE", "ABSENT", "UNKNOWN"]);
const IMPACT_TYPES = new Set(["CONFIDENTIALITY", "INTEGRITY", "AVAILABILITY", "AUTHORIZATION", "PRIVACY", "SUPPLY_CHAIN", "OTHER"]);
const TARGET_REACH_STATES = new Set([
  "SINGLE_OBJECT",
  "SINGLE_USER",
  "SINGLE_SERVICE",
  "TENANT",
  "CROSS_TENANT",
  "MULTI_SERVICE",
  "FLEET",
  "SUPPLY_CHAIN",
  "UNKNOWN",
]);
const CONTROL_STATES = new Set(["EFFECTIVE", "PARTIAL", "ABSENT", "UNKNOWN"]);
const COUNTEREVIDENCE_DISPOSITIONS = new Set(["DEFEATS", "LIMITS", "DOES_NOT_DEFEAT", "UNRESOLVED"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyUniqueStringArray(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every(nonEmptyString)
    && new Set(value).size === value.length;
}

function uniqueStringArray(value) {
  return Array.isArray(value) && value.every(nonEmptyString) && new Set(value).size === value.length;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

export function findingObjectDigest(finding) {
  return sha256(JSON.stringify(canonicalize(finding)));
}

function validDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validateLocation(location, label, errors) {
  if (!isObject(location)) {
    errors.push(`${label}-missing`);
    return;
  }
  if (!nonEmptyString(location.file)) errors.push(`${label}-file-missing`);
  if (!Number.isInteger(location.line_start) || location.line_start < 1) errors.push(`${label}-line-start-invalid`);
  if (location.line_end != null && (!Number.isInteger(location.line_end) || location.line_end < location.line_start)) {
    errors.push(`${label}-line-end-invalid`);
  }
  if (!validDigest(location.source_digest)) errors.push(`${label}-source-digest-invalid`);
}

function validateFact(fact, index, errors) {
  const prefix = `evidence-fact-${index}`;
  if (!isObject(fact)) {
    errors.push(`${prefix}-invalid`);
    return;
  }
  if (!nonEmptyString(fact.kind)) errors.push(`${prefix}-kind-missing`);
  if (!nonEmptyString(fact.claim)) errors.push(`${prefix}-claim-missing`);
  if (!nonEmptyString(fact.method)) errors.push(`${prefix}-method-missing`);
  if (!validDigest(fact.source_digest)) errors.push(`${prefix}-source-digest-invalid`);
  if (!new Set(["high", "medium", "low"]).has(fact.confidence)) errors.push(`${prefix}-confidence-invalid`);
  validateLocation(fact.locator, `${prefix}-locator`, errors);
}

function validateFactIndexes(value, factCount, { required = false } = {}) {
  return Array.isArray(value)
    && (!required || value.length > 0)
    && value.every(index => Number.isInteger(index) && index >= 0 && (factCount == null || index < factCount))
    && new Set(value).size === value.length;
}

function assessmentHasEvidence(state) {
  return !["UNKNOWN", "NONE", "NOT_APPLICABLE", "ABSENT"].includes(state);
}

function validateAssessment(value, {
  label,
  states,
  factCount,
  textFields = ["rationale"],
  stateField = "state",
}, errors) {
  if (!isObject(value)) {
    errors.push(`attack-surface-${label}-missing`);
    return;
  }
  if (!states.has(value[stateField])) errors.push(`attack-surface-${label}-state-invalid`);
  for (const field of textFields) {
    if (!nonEmptyString(value[field])) errors.push(`attack-surface-${label}-${field.replaceAll("_", "-")}-missing`);
  }
  if (!validateFactIndexes(value.evidence_fact_indexes, factCount, {
    required: assessmentHasEvidence(value[stateField]),
  })) {
    errors.push(`attack-surface-${label}-evidence-invalid`);
  }
}

export function validateAttackSurface(attackSurface, context = {}) {
  const errors = [];
  const factCount = Number.isInteger(context.factCount) && context.factCount >= 0 ? context.factCount : null;
  if (!isObject(attackSurface)) return ["attack-surface-missing"];
  if (attackSurface.schema_version !== ATTACK_SURFACE_SCHEMA_VERSION) errors.push("attack-surface-schema-version-invalid");

  validateAssessment(attackSurface.in_scope, {
    label: "in-scope",
    states: IN_SCOPE_STATES,
    factCount,
  }, errors);
  validateAssessment(attackSurface.exposure, {
    label: "exposure",
    states: EXPOSURE_STATES,
    factCount,
    textFields: ["surface", "rationale"],
  }, errors);
  validateAssessment(attackSurface.vector, {
    label: "vector",
    states: VECTOR_STATES,
    factCount,
  }, errors);
  validateAssessment(attackSurface.auth_scope, {
    label: "auth-scope",
    states: AUTH_SCOPE_STATES,
    factCount,
  }, errors);

  if (!Array.isArray(attackSurface.preconditions)) {
    errors.push("attack-surface-preconditions-missing");
  } else {
    const ids = new Set();
    for (const [index, precondition] of attackSurface.preconditions.entries()) {
      if (!isObject(precondition)
        || !nonEmptyString(precondition.precondition_id)
        || ids.has(precondition.precondition_id)
        || !nonEmptyString(precondition.description)
        || !PRECONDITION_FEASIBILITY.has(precondition.feasibility)
        || !validateFactIndexes(precondition.evidence_fact_indexes, factCount)) {
        errors.push(`attack-surface-precondition-${index}-invalid`);
      } else {
        ids.add(precondition.precondition_id);
      }
    }
  }

  const identities = attackSurface.identities;
  if (!isObject(identities)
    || !nonEmptyString(identities.attacker)
    || !nonEmptyString(identities.victim)
    || !nonEmptyString(identities.effective_principal)
    || !validateFactIndexes(identities.evidence_fact_indexes, factCount, { required: true })) {
    errors.push("attack-surface-identities-invalid");
  }

  validateAssessment(attackSurface.boundary_crossing, {
    label: "boundary-crossing",
    states: BOUNDARY_STATES,
    factCount,
    textFields: ["from", "to", "rationale"],
  }, errors);

  const impact = attackSurface.impact;
  if (!isObject(impact)
    || !nonEmptyUniqueStringArray(impact.types)
    || impact.types.some(type => !IMPACT_TYPES.has(type))
    || !nonEmptyString(impact.outcome)
    || !validateFactIndexes(impact.evidence_fact_indexes, factCount, { required: true })) {
    errors.push("attack-surface-impact-invalid");
  }

  validateAssessment(attackSurface.target_reach, {
    label: "target-reach",
    states: TARGET_REACH_STATES,
    factCount,
  }, errors);

  if (!Array.isArray(attackSurface.controls)) {
    errors.push("attack-surface-controls-missing");
  } else {
    const ids = new Set();
    for (const [index, control] of attackSurface.controls.entries()) {
      if (!isObject(control)
        || !nonEmptyString(control.control_id)
        || ids.has(control.control_id)
        || !CONTROL_STATES.has(control.state)
        || !nonEmptyString(control.description)
        || !validateFactIndexes(control.evidence_fact_indexes, factCount, {
          required: assessmentHasEvidence(control.state),
        })) {
        errors.push(`attack-surface-control-${index}-invalid`);
      } else {
        ids.add(control.control_id);
      }
    }
  }

  if (!Array.isArray(attackSurface.counterevidence)) {
    errors.push("attack-surface-counterevidence-missing");
  } else {
    for (const [index, counterevidence] of attackSurface.counterevidence.entries()) {
      if (!isObject(counterevidence)
        || !nonEmptyString(counterevidence.claim)
        || !COUNTEREVIDENCE_DISPOSITIONS.has(counterevidence.disposition)
        || !validateFactIndexes(counterevidence.evidence_fact_indexes, factCount, { required: true })) {
        errors.push(`attack-surface-counterevidence-${index}-invalid`);
      }
    }
  }

  if (!uniqueStringArray(attackSurface.blindspots)) errors.push("attack-surface-blindspots-invalid");
  if (!isObject(attackSurface.confidence)
    || !new Set(["high", "medium", "low"]).has(attackSurface.confidence.level)
    || !nonEmptyString(attackSurface.confidence.rationale)) {
    errors.push("attack-surface-confidence-invalid");
  }
  return [...new Set(errors)];
}

function dimensionsForFinding(finding) {
  const claims = finding?.classification?.dimension_claims;
  if (!Array.isArray(claims)) return [];
  return claims.map(claim => claim?.dimension);
}

export function validateFinding(finding, context = {}) {
  const errors = [];
  if (!isObject(finding)) return ["finding-not-object"];
  if (finding.finding_schema_version !== FINDING_SCHEMA_VERSION) errors.push("finding-schema-version-invalid");
  if (!nonEmptyString(finding.finding_id)) errors.push("finding-id-missing");
  if (!nonEmptyString(finding.audit_id)) errors.push("finding-audit-id-missing");
  if (!validDigest(finding.scope_digest)) errors.push("finding-scope-digest-invalid");
  if (!FINDING_STATES.has(finding.state)) errors.push("finding-state-invalid");
  if (context.expectedFindingId && finding.finding_id !== context.expectedFindingId) errors.push("finding-id-mismatch");
  if (context.auditId && finding.audit_id !== context.auditId) errors.push("finding-audit-id-mismatch");
  if (context.scopeDigest && finding.scope_digest !== context.scopeDigest) errors.push("finding-scope-digest-mismatch");

  const classification = finding.classification;
  if (!isObject(classification)) {
    errors.push("classification-missing");
  } else {
    if (!nonEmptyString(classification.vulnerability_type_id)) errors.push("classification-vulnerability-type-missing");
    if (!LENSES.has(classification.origin_lens)) errors.push("classification-origin-lens-invalid");
    if (!DISCOVERY_TRACKS.has(classification.discovery_track)) errors.push("classification-discovery-track-invalid");
    if (!Array.isArray(classification.dimension_claims) || classification.dimension_claims.length === 0) {
      errors.push("classification-dimension-claims-missing");
    } else {
      const claimedDimensions = dimensionsForFinding(finding);
      if (claimedDimensions.some(dimension => !DIMENSIONS.has(dimension)) || new Set(claimedDimensions).size !== claimedDimensions.length) {
        errors.push("classification-dimension-claims-invalid");
      }
      if (classification.dimension_claims.some(claim => !isObject(claim) || !nonEmptyString(claim.rationale))) {
        errors.push("classification-dimension-rationale-missing");
      }
    }
  }

  const routing = finding.routing;
  if (!isObject(routing)) {
    errors.push("routing-missing");
  } else {
    if (routing.protocol === "task-board.v1") {
      if (!nonEmptyString(routing.task_id)) errors.push("routing-task-missing");
      if (!nonEmptyString(routing.attempt_id)) errors.push("routing-attempt-missing");
      if (routing.focus_area_id != null || routing.primary_check_id != null) errors.push("routing-task-legacy-mixed");
    } else {
      if (!nonEmptyString(routing.focus_area_id)) errors.push("routing-focus-area-missing");
      if (!nonEmptyString(routing.primary_check_id)) errors.push("routing-primary-check-missing");
    }
    if (!nonEmptyString(routing.domain)) errors.push("routing-domain-missing");
    if (!nonEmptyUniqueStringArray(routing.threat_ids)) errors.push("routing-threat-ids-invalid");
  }

  validateLocation(finding.locations?.primary, "primary-location", errors);
  const facts = finding.evidence?.facts;
  if (!Array.isArray(facts) || facts.length === 0) {
    errors.push("evidence-facts-missing");
  } else {
    facts.forEach((fact, index) => validateFact(fact, index, errors));
    const factKinds = new Set(facts.map(fact => fact?.kind));
    if (!factKinds.has("source")) errors.push("evidence-source-missing");
    if (!factKinds.has("sink") && !factKinds.has("config")) errors.push("evidence-semantic-anchor-missing");
  }
  if (!isObject(finding.reachability) || !nonEmptyString(finding.reachability.state)) errors.push("reachability-missing");
  if (!isObject(finding.attacker_influence) || !nonEmptyString(finding.attacker_influence.state)) errors.push("attacker-influence-missing");
  errors.push(...validateAttackSurface(finding.attack_surface, {
    factCount: Array.isArray(facts) ? facts.length : null,
  }));
  if (!Array.isArray(finding.guards)) errors.push("guards-missing");
  if (!Array.isArray(finding.contradictions)) errors.push("contradictions-missing");
  if (!isObject(finding.uncertainty) || !new Set(["low", "medium", "high"]).has(finding.uncertainty.level)
    || !Array.isArray(finding.uncertainty.assumptions)) errors.push("uncertainty-invalid");
  if (!isObject(finding.severity) || !nonEmptyString(finding.severity.rationale)) {
    errors.push("severity-rationale-missing");
  } else {
    for (const field of ["score", "base_score", "rating"]) {
      if (Object.hasOwn(finding.severity, field)) errors.push("severity-manual-score-forbidden");
    }
    if (finding.severity.cvss != null) {
      const provisional = finding.severity.cvss;
      if (finding.state !== "CANDIDATE" || !isObject(provisional) || provisional.assessment_state !== "PROVISIONAL"
        || !nonEmptyString(provisional.vector) || Object.hasOwn(provisional, "base_score")
        || Object.hasOwn(provisional, "score") || Object.hasOwn(provisional, "severity")) {
        errors.push("severity-provisional-cvss-invalid");
      } else {
        try {
          parseCvssV31Vector(provisional.vector);
        } catch (error) {
          errors.push("severity-provisional-cvss-vector-invalid");
        }
      }
    }
  }
  if (!isObject(finding.remediation) || !nonEmptyString(finding.remediation.summary)) errors.push("remediation-missing");
  errors.push(...validateFindingReportDetails(finding, { required: context.requireReportDetails === true }));
  if (!isObject(finding.provenance) || !validDigest(finding.provenance.source_report_sha256)) errors.push("provenance-source-report-digest-invalid");

  const check = context.check;
  if (context.task) {
    if (routing?.protocol !== "task-board.v1" || routing.task_id !== context.task.task_id) errors.push("finding-task-mismatch");
    if (routing?.attempt_id !== context.task.attempt_id) errors.push("finding-attempt-mismatch");
    if (routing?.domain !== context.task.domain) errors.push("finding-domain-mismatch");
  }
  if (check) {
    if (routing?.protocol === "task-board.v1") errors.push("finding-routing-protocol-mismatch");
    if (routing?.primary_check_id !== check.check_id) errors.push("finding-primary-check-mismatch");
    if (routing?.focus_area_id !== check.focus_area_id) errors.push("finding-focus-area-mismatch");
    if (routing?.domain !== check.domain) errors.push("finding-domain-mismatch");
    if (classification?.vulnerability_type_id !== check.vulnerability_type_id) errors.push("finding-vulnerability-type-mismatch");
    if (classification?.origin_lens !== check.lens) errors.push("finding-lens-mismatch");
    if (classification?.discovery_track !== "coverage") errors.push("finding-track-not-coverage");
    if (dimensionsForFinding(finding).some(dimension => !check.dimensions?.includes(dimension))) {
      errors.push("finding-dimension-not-in-check");
    }
    if (!new Set(["CANDIDATE", "SUPPORTED_STATIC", "SUPPORTED_RUNTIME"]).has(finding.state)) {
      errors.push("finding-state-not-admissible-for-ledger");
    }
  }
  return [...new Set(errors)];
}

export function parseFindingArtifact(bytes, context = {}) {
  let finding;
  try {
    finding = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes));
  } catch (error) {
    throw new Error(`Finding artifact must be a JSON object: ${error.message}`);
  }
  const errors = validateFinding(finding, context);
  if (errors.length > 0) throw new Error(`Finding artifact violates v2 contract: ${errors.join(", ")}`);
  return { finding, finding_object_digest: findingObjectDigest(finding) };
}
