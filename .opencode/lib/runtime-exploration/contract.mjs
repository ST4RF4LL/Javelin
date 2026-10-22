import { check, digest, text, ID, SHA, httpUrl, EXPLORATION_PROTOCOL } from '../runtime-testing/contract.mjs';

export const PROTOCOL = 'runtime-exploration.v1';
export const LIMITS = Object.freeze({ rounds: 8, intents: 24, perRound: 3, surfaces: 128, followups: 6, contextCharacters: 60000 });
export const planSchema = {
  type: 'object', additionalProperties: false, required: ['summary', 'complete', 'intents', 'gaps'], properties: {
    summary: { type: 'string' }, complete: { type: 'boolean' }, gaps: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    intents: { type: 'array', maxItems: LIMITS.perRound, items: { type: 'object', additionalProperties: false,
      required: ['scope_id', 'question', 'expected_behavior', 'steps', 'counterchecks', 'identity_ids', 'actions', 'evidence_ids'], properties: {
        scope_id: { type: 'string' }, question: { type: 'string' }, expected_behavior: { type: 'string' }, vulnerability_type_id: { type: 'string' },
        finding_revision_id: { type: 'string' }, steps: { type: 'array', items: { type: 'string' }, maxItems: 12 },
        counterchecks: { type: 'array', items: { type: 'string' }, maxItems: 8 }, identity_ids: { type: 'array', items: { type: 'string' } },
        actions: { type: 'array', items: { enum: ['navigate', 'normal_interaction', 'test_input'] } },
        evidence_ids: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      } },
    },
  },
};

export function normalizePlan(value, context) {
  check(value && Object.keys(value).every(key => ['summary', 'complete', 'intents', 'gaps'].includes(key)), 'exploration-plan-invalid');
  check(text(value.summary) && value.summary.length <= 4000 && /\p{Script=Han}/u.test(value.summary) && typeof value.complete === 'boolean', 'exploration-plan-summary-required');
  check(Array.isArray(value.gaps) && value.gaps.length <= 20 && value.gaps.every(gap => text(gap) && gap.length <= 2000), 'exploration-plan-gaps-invalid');
  check(Array.isArray(value.intents) && value.intents.length <= LIMITS.perRound && (!value.complete || !value.intents.length), 'exploration-plan-intents-invalid');
  const knownEvidence = new Set(context.facts.flatMap(fact => fact.evidence_ids ?? []));
  const intents = value.intents.map(input => {
    check(input && Object.keys(input).every(key => Object.hasOwn(planSchema.properties.intents.items.properties, key)), 'exploration-intent-fields-invalid');
    const scope = context.scopes.find(scope => scope.id === input.scope_id);
    check(scope && text(input.question) && input.question.length <= 2000 && text(input.expected_behavior) && input.expected_behavior.length <= 2000, 'exploration-intent-scope-invalid');
    for (const field of ['steps', 'counterchecks']) check(Array.isArray(input[field]) && input[field].length > 0 && input[field].length <= 12 && input[field].every(item => text(item) && item.length <= 2000), 'exploration-intent-checks-required');
    check(Array.isArray(input.identity_ids) && input.identity_ids.length && new Set(input.identity_ids).size === input.identity_ids.length
      && input.identity_ids.every(id => context.authorization.identities.some(identity => identity.id === id)), 'exploration-identities-invalid');
    check(Array.isArray(input.actions) && input.actions.includes('navigate') && new Set(input.actions).size === input.actions.length
      && input.actions.every(action => ['navigate', 'normal_interaction', 'test_input'].includes(action) && context.authorization.allowed_actions.includes(action)), 'exploration-actions-not-authorized');
    check(Array.isArray(input.evidence_ids) && input.evidence_ids.length > 0 && input.evidence_ids.length <= 20 && input.evidence_ids.every(id => knownEvidence.has(id)), 'exploration-evidence-required');
    const revision = input.finding_revision_id ? context.finding_revisions.find(row => row.id === input.finding_revision_id && row.scope_id === scope.id) : null;
    check(!input.finding_revision_id || revision, 'exploration-finding-revision-invalid');
    if (revision) check(text(input.vulnerability_type_id), 'exploration-vulnerability-type-required');
    if (input.vulnerability_type_id != null) check(ID.test(input.vulnerability_type_id), 'exploration-vulnerability-type-invalid');
    const key = digest({ scope: digest(scope), question: input.question.trim(), identity_ids: [...input.identity_ids].sort(), actions: [...input.actions].sort(),
      finding_revision: revision?.id ?? null, environment_revision: context.authorization.environment_revision });
    return { ...structuredClone(input), id: `intent-${key.slice(0, 32)}`, dedupe_key: key, status: 'PROPOSED', scope_ref: { id: scope.id, kind: scope.kind, digest: digest(scope) } };
  });
  return { summary: value.summary, complete: value.complete, gaps: value.gaps, intents };
}

export function projectPacket(intent, authorization, revisions) {
  check(authorization.protocol === EXPLORATION_PROTOCOL && authorization.status === 'AUTHORIZED', 'exploration-authorization-required');
  const revision = revisions.find(row => row.id === intent.finding_revision_id);
  return { protocol: EXPLORATION_PROTOCOL, id: intent.id, phase: revision ? 'CONFIRM' : 'EXPLORE', audit_id: authorization.audit_id,
    authorization_digest: authorization.artifact_digest, environment_revision: authorization.environment_revision,
    scope_ref: intent.scope_ref, scope_digest: authorization.scope_digest, hypothesis_id: `hyp-${intent.dedupe_key.slice(0, 32)}`,
    question: intent.question, expected_behavior: intent.expected_behavior, steps: intent.steps, counterchecks: intent.counterchecks,
    identity_ids: intent.identity_ids, actions: intent.actions, budget_seconds: 300,
    vulnerability_type_id: intent.vulnerability_type_id ?? null,
    ...(revision ? { finding_id: revision.finding_id, finding_object_digest: revision.finding_object_digest, finding_revision_id: revision.id } : {}),
  };
}

export function findingRevisions({ auditId, task, report, reportRef, scopeDigest }) {
  check(SHA.test(reportRef.sha256) && SHA.test(scopeDigest), 'finding-revision-binding-invalid');
  return (Array.isArray(report.findings) ? report.findings : []).filter(finding => finding && typeof finding === "object").map((finding, index) => {
    const binding = { audit_id: auditId, task_id: task.task_id, attempt_id: task.attempt_id, report: reportRef,
      finding_id: finding.finding_id ?? `source-${digest({ task: task.task_id, index, finding }).slice(0, 32)}`, finding_object_digest: digest(finding), scope_digest: scopeDigest };
    return { ...binding, id: `revision-${digest(binding).slice(0, 32)}`, scope_id: `static-${digest(task.task_id).slice(0, 32)}`, finding };
  });
}

export function runtimeSurfaces(records, authorization) {
  const rows = new Map();
  for (const { id: evidenceId, record } of records) {
    const value = record.structured_content;
    if (!value || value.status === 'FAILED' || value.result?.isError) continue;
    const pages = value.result?.structuredContent?.pages ?? [];
    const structured = value.result?.structuredContent;
    const connection = value.tool === 'ssh_connect' ? structured?.ssh_connection : null;
    if (connection?.authenticated && connection.identity_id === value.identity_id) {
      const target = authorization.ssh_targets?.find(target => target.id === connection.target_id && target.identity_id === value.identity_id && target.origin === connection.origin);
      if (target) {
        const surface = { kind: 'RUNTIME_SURFACE', transport: 'ssh', target_id: target.id, identity_id: target.identity_id,
          environment_revision: authorization.environment_revision, origin: target.origin, method: 'SSH', deployment_binding: 'UNKNOWN' };
        const id = `surface-${digest(surface).slice(0, 32)}`;
        if (!rows.has(id)) rows.set(id, { ...surface, id, evidence_ids: [] });
        if (rows.get(id).evidence_ids.length < 8) rows.get(id).evidence_ids.push(evidenceId);
      }
    }
    const requests = [...(Array.isArray(structured?.requests) ? structured.requests : []), ...(Array.isArray(structured?.networkRequests) ? structured.networkRequests : []), ...(structured?.networkRequest ? [structured.networkRequest] : [])];
    for (const item of [...pages.map(page => ({ ...page, method: 'PAGE' })), ...requests]) {
      const url = httpUrl(item.url);
      if (!url || !authorization.origins.includes(url.origin) || !text(item.method)) continue;
      const surface = { kind: 'RUNTIME_SURFACE', environment_revision: authorization.environment_revision,
        origin: url.origin, path: url.pathname, method: item.method.toUpperCase(), deployment_binding: 'UNKNOWN' };
      const id = `surface-${digest(surface).slice(0, 32)}`;
      if (!rows.has(id)) rows.set(id, { ...surface, id, parameter_names: [...new Set(url.searchParams.keys())].slice(0, 40), status: item.status ?? null, evidence_ids: [] });
      if (rows.get(id).evidence_ids.length < 8 && !rows.get(id).evidence_ids.includes(evidenceId)) rows.get(id).evidence_ids.push(evidenceId);
    }
  }
  return [...rows.values()].slice(0, LIMITS.surfaces);
}
