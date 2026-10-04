const RUNNING_STATUSES = new Set(["preparing", "recovering", "running", "pausing", "cancelling"]);

export function isRunningAudit(audit) {
  return RUNNING_STATUSES.has(audit.status);
}

export function auditListItem(audit) {
  const fields = ["id", "name", "repository_name", "repository_id", "commit", "stage", "progress", "progress_text", "progress_source", "task_protocol", "task_board", "mining_strategy", "execution_incomplete", "finding_count", "status", "updated_at", "event_sequence", "version"];
  const item = Object.fromEntries(fields.map(key => [key, audit[key]]));
  if (audit.provenance) item.provenance = audit.provenance;
  if (audit.todo) item.todo = { total: audit.todo.total, done: audit.todo.done, gap: audit.todo.gap };
  return item;
}

export function paginateAudits(audits, parameters) {
  const tab = parameters.get("tab") ?? "all";
  const pageSize = Number(parameters.get("page_size") ?? 20);
  const requestedPage = Number(parameters.get("page") ?? 1);
  if (!["running", "completed", "all"].includes(tab) || ![20, 30, 50, 100].includes(pageSize) || !Number.isSafeInteger(requestedPage) || requestedPage < 1) {
    throw Object.assign(new Error("任务列表参数无效。"), { statusCode: 422, code: "audit-pagination-invalid" });
  }
  const query = (parameters.get("q") ?? "").trim().toLowerCase();
  const items = audits.filter(audit => (tab === "all" || isRunningAudit(audit) === (tab === "running"))
    && (!query || [audit.id, audit.name, audit.repository_name, audit.commit].some(value => String(value ?? "").toLowerCase().includes(query))))
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")) || String(a.id).localeCompare(String(b.id)));
  const totalPages = tab === "running" ? 1 : Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const selected = tab === "running" ? items : items.slice((page - 1) * pageSize, page * pageSize);
  return { items: selected.map(auditListItem), count: items.length, page, page_size: tab === "running" ? null : pageSize, total_pages: totalPages };
}

export function compactWorkspaceAudits(audits) {
  // Recent cards and the event subscription need only lightweight summaries.
  const eventAudit = audits.find(audit => ["queued", "paused"].includes(audit.status) || isRunningAudit(audit));
  return audits.filter((audit, index) => index < 5 || audit === eventAudit).map(auditListItem);
}
