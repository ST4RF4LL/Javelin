import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = ['path', 'symbol', 'weakness', 'trust_boundary', 'preconditions'];

// Equivalence is deliberately narrower than similarity. Missing conditions keep occurrences separate.
export function groupConfirmedFindings(occurrences) {
  const groups = new Map();
  for (const finding of occurrences) {
    const cause = finding.root_cause;
    const complete = cause && typeof cause === 'object' && !Array.isArray(cause)
      && fields.every(key => typeof cause[key] === 'string' && cause[key].trim());
    const key = complete ? hash([finding.claim_scope, ...fields.map(key => cause[key].trim())]) : `occurrence:${finding.finding_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(finding);
  }
  return [...groups].map(([key, rows]) => {
    const strategyIds = [...new Set(rows.flatMap(row => row.strategy_ids ?? []))];
    if (rows.length === 1 || strategyIds.length < 2) return rows;
    const references = rows.flatMap(row => row.review.evidence_refs);
    const uniqueReferences = [...new Map(references.map(ref => [JSON.stringify(ref), ref])).values()];
    const severityOrder = ['critical', 'high', 'medium', 'low', 'info', 'informational'];
    const severity = row => severityOrder.indexOf(String(typeof row.severity === 'string' ? row.severity : row.severity?.rating).toLowerCase());
    const representative = [...rows].sort((a, b) => (severity(a) < 0 ? 99 : severity(a)) - (severity(b) < 0 ? 99 : severity(b)))[0];
    return [{ ...representative, finding_id: `candidate-${key.slice(0, 32)}`,
      strategy_ids: strategyIds,
      source_finding_ids: [...new Set(rows.flatMap(row => [row.finding_id, ...(row.source_finding_ids ?? [])]))],
      source_task_ids: [...new Set(rows.map(row => row.task_id))],
      source_refs: [...new Map(rows.flatMap(row => row.source_refs ?? []).map(ref => [JSON.stringify(ref), ref])).values()],
      source_occurrences: rows,
      creed_analyses: rows.filter(row => row.creed_analysis).map(row => ({ finding_id: row.finding_id, analysis: row.creed_analysis })),
      occurrences: rows.map(row => ({ finding_id: row.finding_id, task_id: row.task_id, strategy_ids: row.strategy_ids, review: row.review })),
      review: { ...representative.review, reason: rows.map(row => `${row.strategy_ids.join(' / ')}：${row.review.reason}`).join('\n'), evidence_refs: uniqueReferences },
      ...(rows.some(row => row.creed_analysis) ? { creed_analysis: rows.find(row => row.creed_analysis).creed_analysis } : {}) }];
  }).flat();
}
