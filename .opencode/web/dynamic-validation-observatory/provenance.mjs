const scopeKey = row => `${row.repository_id ?? ""}\0${row.audit_id ?? row.id ?? ""}`;
const idsFor = finding => new Set([finding?.id, ...(finding?.source_finding_ids ?? [])].filter(Boolean));

export function createProvenanceIndex(snapshot, ownership) {
  const audits = new Map(snapshot.audits.map(audit => [scopeKey(audit), audit]));
  const findings = new Map(), reports = new Map();
  for (const finding of snapshot.findings) {
    const key = scopeKey(finding);
    if (!findings.has(key)) findings.set(key, []);
    findings.get(key).push(finding);
  }
  for (const report of snapshot.reports) {
    const key = scopeKey(report);
    if (!reports.has(key)) reports.set(key, []);
    reports.get(key).push(report);
  }
  return (record, { findingId = null, sourcePath = null } = {}) => {
    const key = scopeKey(record), audit = audits.get(key);
    const candidates = findings.get(key) ?? [];
    const exact = findingId ? candidates.filter(row => row.id === findingId) : [];
    const matches = exact.length ? exact : findingId ? candidates.filter(row => idsFor(row).has(findingId)) : [];
    const finding = matches.length === 1 ? matches[0] : null;
    const findingIds = finding ? idsFor(finding) : new Set(findingId ? [findingId] : []);
    return { ...record, provenance: {
      ...ownership(record), audit_id: record.audit_id ?? record.id, audit_name: audit?.name ?? record.audit_id ?? record.id,
      finding_id: finding?.id ?? findingId, finding_resource_id: finding?.resource_id ?? null,
      finding_title: finding?.title ?? null,
      finding_link: !findingId ? "NOT_APPLICABLE" : finding ? "MATCHED" : matches.length > 1 ? "AMBIGUOUS" : "MISSING",
      source_path: sourcePath ?? record.source_path ?? record.request_path ?? null,
      reports: (reports.get(key) ?? []).map(report => ({
        id: report.id, audit_id: report.audit_id, name: report.name, path: report.path,
        repository_name: report.repository_name, sealed_at: report.sealed_at,
        membership: !findingId ? "RELATED" : (report.finding_ids ?? []).some(id => findingIds.has(id)) ? "INCLUDED"
          : (report.excluded_finding_ids ?? []).some(id => findingIds.has(id)) ? "EXCLUDED"
            : report.finding_index_available ? "NOT_INCLUDED" : "UNKNOWN",
      })),
    } };
  };
}

export function matchesProvenance(record, parameters) {
  const product = parameters.get("product_id"), audit = parameters.get("audit_id"), report = parameters.get("report_id");
  return (!product || record.provenance?.product_id === product)
    && (!audit || record.audit_id === audit || record.id === audit)
    && (!report || record.provenance?.reports?.some(row => row.id === report && row.membership !== "NOT_INCLUDED"));
}
