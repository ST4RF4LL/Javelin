import { createHash } from "node:crypto";
import { sanitizeForWeb } from "./model.mjs";
import { matchesProvenance } from "./provenance.mjs";
import { httpUrl } from "../../lib/runtime-testing/contract.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const unique = values => [...new Set(values.filter(Boolean))];
const scope = row => `${row.repository_id ?? ""}\0${row.audit_id ?? ""}`;

export function buildValidationActivity({ runtimeCases = [], runtimeExchanges = [], manualRuns = [], requests = [], historicalExchanges = [], attachSource = value => value } = {}) {
  const cases = new Map(), exchanges = new Map();
  function sourced(value) {
    const row = attachSource(sanitizeForWeb(value), { findingId: value.finding_id ?? null });
    if (row.provenance?.finding_link === "MATCHED") row.finding_id = row.provenance.finding_id;
    return row;
  }
  function sameFinding(left, right, base) {
    if (left === right) return true;
    const a = sourced({ ...base, finding_id: left }), b = sourced({ ...base, finding_id: right });
    return a.provenance?.finding_link === "MATCHED" && b.provenance?.finding_link === "MATCHED" && a.finding_id === b.finding_id;
  }
  function legacyBindingConflict(exchange, base) {
    for (const binding of [exchange, exchange.evidence_binding ?? {}]) {
      for (const key of ["repository_id", "audit_id"]) if (binding[key] != null && binding[key] !== base[key]) return `历史 HTTP 的 ${key} 与执行来源冲突，未展示或导出该记录。`;
      if (binding.finding_id != null && !sameFinding(binding.finding_id, base.finding_id, base)) return "历史 HTTP 的漏洞绑定与执行来源冲突，未展示或导出该记录。";
    }
    return null;
  }
  function add(value, priority) {
    const row = sourced(value), key = `${scope(row)}\0${row.finding_id ?? `unlinked:${row.phase ?? "LEGACY"}`}`;
    const current = cases.get(key);
    if (!current) {
      row.id = `validation_${hash(key).slice(0, 32)}`;
      row.title = row.provenance?.finding_title ?? row.title;
      row.actions ??= []; row.exchange_ids ??= []; row.gaps ??= [];
      row._priority = priority; cases.set(key, row); return row;
    }
    current.actions.push(...(row.actions ?? [])); current.exchange_ids.push(...(row.exchange_ids ?? [])); current.gaps.push(...(row.gaps ?? []));
    if (priority > current._priority || priority === current._priority && String(row.updated_at ?? "") > String(current.updated_at ?? "")) {
      current.status = row.status; current.summary = row.summary; current._priority = priority;
    }
    if (String(row.updated_at ?? "") > String(current.updated_at ?? "")) current.updated_at = row.updated_at;
    return current;
  }
  for (const exchange of runtimeExchanges) exchanges.set(exchange.exchange_id, sourced(exchange));
  for (const item of runtimeCases) add(structuredClone(item), 30);
  for (const run of manualRuns) {
    const findingId = run.finding?.id ?? run.finding_id ?? null;
    const base = { repository_id: run.repository_id, repository_name: run.repository_name, audit_id: run.audit_id, finding_id: findingId };
    const item = { ...base, title: run.finding?.summary ?? (findingId ? `漏洞 ${findingId}` : "补充验证 / 未关联漏洞"),
      status: run.finding?.outcome ?? "UNKNOWN", summary: run.finding?.summary ?? run.error ?? "补充验证执行记录", updated_at: run.recorded_at ?? null,
      actions: [], exchange_ids: [], gaps: [...(run.finding?.residual_gaps ?? []), ...(run.network?.warning ? [run.network.warning] : [])] };
    for (const [index, observation] of (run.observations ?? []).entries()) {
      const gaps = ["历史观察记录未提供与 HTTP 请求的一对一动作绑定。"], text = JSON.stringify(observation);
      const result = text.length > 64 * 1024 ? { text: text.slice(0, 64 * 1024), truncated: true } : observation;
      if (result?.truncated) gaps.push("历史观察详情超过显示上限，已截断。");
      item.actions.push({ id: `legacy_${hash(`${scope(base)}\0${findingId}\0${index}`).slice(0, 24)}`, phase: "MANUAL", tool: "observation", status: "RECORDED", recorded_at: run.recorded_at ?? null,
        summary: observation?.summary ?? observation?.description ?? observation?.observation ?? `观察记录 ${index + 1}`, result, exchange_ids: [], gaps });
    }
    for (const captured of run.network?.exchanges ?? []) {
      const conflict = legacyBindingConflict(captured, base);
      if (conflict) { item.gaps.push(conflict); continue; }
      if (!httpUrl(captured.request?.url) || !/^[A-Z]+$/.test(captured.request?.method ?? "") || captured.request.method === "UNKNOWN") {
        item.gaps.push("历史 HTTP 缺少可靠的方法或 URL，未生成导出项。"); continue;
      }
      const id = `http_legacy-${hash(`${scope(base)}\0${findingId}\0${captured.exchange_id}`).slice(0, 32)}`;
      const exchange = sourced({ ...captured, repository_id: captured.repository_id ?? base.repository_id, repository_name: base.repository_name,
        audit_id: captured.audit_id ?? base.audit_id, finding_id: captured.finding_id ?? base.finding_id, exchange_id: id, source_exchange_id: captured.exchange_id });
      exchanges.set(id, exchange); item.exchange_ids.push(id);
      item.actions.push({ id: `network_${id}`, phase: captured.evidence_binding?.phase ?? "MANUAL", tool: "http_exchange", status: "RECORDED",
        recorded_at: captured.started_at ?? null, summary: `${captured.request?.method ?? "UNKNOWN"} ${captured.request?.url ?? ""}`,
        exchange_ids: [id], gaps: [], result: { status: captured.response?.status ?? null, evidence_binding: captured.evidence_binding ?? null } });
    }
    if (!item.actions.length) item.gaps.push("历史结果没有可展示的实际动作或 HTTP 捕获记录。");
    add(item, 20);
  }
  for (const captured of historicalExchanges) {
    const base = { repository_id: captured.repository_id ?? captured.evidence_binding?.repository_id ?? null,
      audit_id: captured.audit_id ?? captured.evidence_binding?.audit_id ?? null, finding_id: captured.finding_id ?? captured.evidence_binding?.finding_id ?? null };
    const id = /^http_[A-Za-z0-9-]+$/.test(captured.exchange_id ?? "") ? captured.exchange_id : `http_history-${hash(`${scope(base)}\0${captured.exchange_id}`).slice(0, 32)}`;
    const item = { ...base, phase: "HISTORY", title: base.finding_id ? `漏洞 ${base.finding_id}` : "历史 HTTP / 未关联漏洞", status: "RECORDED",
      summary: "历史工作台保存的 HTTP 记录。", updated_at: captured.started_at ?? null, actions: [], exchange_ids: [], gaps: [] };
    if (!base.audit_id || !base.finding_id) item.gaps.push("历史记录缺少审计或漏洞绑定，不能推测其所属漏洞。");
    const conflict = legacyBindingConflict(captured, base);
    if (conflict) item.gaps.push(conflict);
    else if (httpUrl(captured.request?.url) && /^[A-Z]+$/.test(captured.request?.method ?? "") && captured.request.method !== "UNKNOWN") {
      if (!exchanges.has(id)) exchanges.set(id, sourced({ ...captured, ...base, exchange_id: id }));
      item.exchange_ids.push(id); item.actions.push({ id: `history_${id}`, phase: "HISTORY", tool: "http_exchange", status: "RECORDED",
        recorded_at: captured.started_at ?? null, summary: `${captured.request.method} ${captured.request.url}`, exchange_ids: [id], gaps: [] });
    } else item.gaps.push("历史记录缺少请求方法或 URL，不能导出。");
    add(item, 20);
  }
  for (const request of requests) add({ repository_id: request.repository_id, repository_name: request.repository_name, audit_id: request.audit_id,
    finding_id: request.finding_id, title: request.summary ?? `漏洞 ${request.finding_id}`, summary: request.summary ?? "补充验证请求",
    status: ["preparing", "running", "cancelling"].includes(request.job?.status) ? "RUNNING" : request.result_present ? "COMPLETED" : request.dispatch_ready ? "PENDING" : "BLOCKED",
    updated_at: request.job?.updated_at ?? null, actions: [], exchange_ids: [],
    gaps: request.result_present ? [] : ["该条目是验证请求，尚无实际动作证据。", ...(request.dispatch_blockers ?? [])] }, 10);
  const items = [...cases.values()].map(({ _priority, ...item }) => ({ ...item, exchange_ids: unique(item.exchange_ids), gaps: unique(item.gaps),
    actions: [...new Map(item.actions.map(action => [action.id, action])).values()].sort((a, b) => String(a.recorded_at ?? "").localeCompare(String(b.recorded_at ?? ""))) }))
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")) || a.id.localeCompare(b.id));
  return { items, count: items.length, exchanges: [...exchanges.values()], has_more: false };
}

export function filterValidationActivity(activity, parameters) {
  const items = activity.items.filter(item => matchesProvenance(item, parameters));
  const ids = new Set(items.flatMap(item => item.exchange_ids));
  return { items, count: items.length, exchanges: activity.exchanges.filter(exchange => ids.has(exchange.exchange_id)), has_more: activity.history_window?.has_more ?? false,
    ...(activity.history_window ? { history_window: activity.history_window } : {}) };
}
