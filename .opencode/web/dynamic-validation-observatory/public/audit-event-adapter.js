// Pure browser/Node adapter for the already-redacted workbench log API.
// Returned strings are text, never HTML. Task completion comes from task-board.
const WORKER_PREFIX = /^\[(web|java|python|c-cpp|ai|platform)\/([a-zA-Z0-9][a-zA-Z0-9._:-]{0,159})\] (\{[\s\S]*)$/;
const EVENT_TYPES = new Set(["text", "reasoning", "tool_use", "step_start", "step_finish", "prompt_request_started", "prompt_status", "prompt_request_error", "error"]);

const object = value => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const string = value => typeof value === "string" ? value : "";
const identifier = value => typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,159}$/i.test(value) ? value : null;
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const text = value => value == null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";

function usageOf(part) {
  const tokens = object(part.tokens), cache = object(tokens.cache);
  const usage = { total: number(tokens.total), input: number(tokens.input), output: number(tokens.output), reasoning: number(tokens.reasoning),
    cache_read: number(cache.read), cache_write: number(cache.write), cost: number(part.cost) };
  return Object.values(usage).some(value => value !== null) ? usage : null;
}

function usageText(usage) {
  if (!usage) return "";
  return [["total", "总计"], ["input", "输入"], ["output", "输出"], ["reasoning", "推理 token"], ["cache_read", "缓存读取"], ["cache_write", "缓存写入"]]
    .filter(([key]) => usage[key] !== null).map(([key, label]) => `${label} ${usage[key]}`)
    .concat(usage.cost !== null ? [`费用 $${usage.cost.toFixed(6)}`] : []).join(" · ");
}

function toolOutput(state) {
  const value = state.output ?? state.error;
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); if (typeof parsed?.output === "string") return parsed.output; } catch {}
  }
  return text(value);
}

function hiddenReasoning(base) {
  return { ...base, kind: "reasoning", label: "推理活动", status: null, body: "", detail: "", semantic_scope: "activity", content_omitted: true };
}

function declaresReasoningType(fragment) {
  // Read only complete root-level string tokens, even in an incomplete object.
  // Do not mistake quoted tool output or nested input.type for an event type.
  let depth = 0;
  for (let index = 0; index < fragment.length; index++) {
    const char = fragment[index];
    if (char === "{" || char === "[") { depth++; continue; }
    if (char === "}" || char === "]") { depth--; continue; }
    if (char !== '"') continue;
    const start = index;
    for (index++; index < fragment.length; index++) {
      if (fragment[index] === "\\") { index++; continue; }
      if (fragment[index] === '"') break;
    }
    if (index >= fragment.length) return false;
    if (depth !== 1) continue;
    let key;
    try { key = JSON.parse(fragment.slice(start, index + 1)); } catch { return false; }
    if (key !== "type") continue;
    const value = /^\s*:\s*("(?:[^"\\]|\\.)*")/.exec(fragment.slice(index + 1));
    if (value) {
      try { if (JSON.parse(value[1]) === "reasoning") return true; } catch {}
    }
  }
  return false;
}

function baseView(item) {
  // Whitelist fields: never retain an alternate raw/reasoning payload by spread.
  return {
    occurred_at: typeof item.occurred_at === "string" ? item.occurred_at : null,
    source: string(item.source) || "stdout", kind: string(item.kind) || "raw",
    label: string(item.label) || "Runner 输出", status: typeof item.status === "string" ? item.status : null,
    body: string(item.body), detail: string(item.detail),
    domain: identifier(item.domain), task_id: identifier(item.task_id), session_id: identifier(item.session_id),
    call_id: identifier(item.call_id), part_id: identifier(item.part_id), event_id: identifier(item.event_id),
    event_type: string(item.event_type) || null, tool: string(item.tool) || null,
    sequence: Number.isSafeInteger(item.sequence) && item.sequence >= 0 ? item.sequence : null,
    usage: null, semantic_scope: item.kind === "tool" ? "tool" : "activity", parse_status: "preformatted", content_omitted: false,
  };
}

function normalize(item) {
  let base = baseView(object(item));
  if (base.kind === "reasoning" || base.event_type === "reasoning") return hiddenReasoning(base);
  if (base.event_type === "step_finish") return { ...base, kind: "step", label: "单步结束", status: "ended", semantic_scope: "step" };
  if (base.event_type === "step_start") return { ...base, kind: "step", label: "单步开始", status: "running", semantic_scope: "step" };
  if (!["raw", "error"].includes(base.kind)) return base;

  const match = WORKER_PREFIX.exec(base.body);
  if (!match) return { ...base, parse_status: "plain" };
  base = { ...base, domain: match[1], task_id: match[2], parse_status: "unparsed" };
  let event;
  try { event = JSON.parse(match[3]); } catch {
    // A truncated known reasoning envelope must not expose its partial body.
    if (declaresReasoningType(match[3])) return hiddenReasoning(base);
    return base;
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) return base;
  const part = object(event.part);
  if (event.type === "reasoning" || part.type === "reasoning") return hiddenReasoning({ ...base,
    event_type: "reasoning", session_id: identifier(event.sessionID ?? event.session_id ?? part.sessionID ?? part.session_id), part_id: identifier(part.id), parse_status: "structured" });
  if (!EVENT_TYPES.has(event.type)) return base;
  base = { ...base, event_type: event.type, session_id: identifier(event.sessionID ?? event.session_id ?? part.sessionID ?? part.session_id),
    part_id: identifier(part.id), call_id: identifier(part.callID ?? part.call_id), body: "", detail: "", parse_status: "structured" };
  if (event.type === "text") return { ...base, kind: "text", label: "Agent", status: null, body: text(part.text ?? event.text) };
  if (event.type === "tool_use") {
    const state = object(part.state), tool = string(part.tool) || "tool";
    return { ...base, kind: "tool", label: string(object(state.metadata).title) || tool, tool,
      status: string(state.status) || "unknown", body: toolOutput(state), detail: text(state.input), semantic_scope: "tool" };
  }
  if (event.type === "step_start") return { ...base, kind: "step", label: "单步开始", status: "running", semantic_scope: "step" };
  if (event.type === "step_finish") {
    const usage = usageOf(part);
    return { ...base, kind: "step", label: "单步结束", status: "ended", semantic_scope: "step", usage,
      body: [part.reason ? `原因 ${text(part.reason)}` : "", usageText(usage)].filter(Boolean).join(" · ") };
  }
  if (["prompt_request_error", "error"].includes(event.type)) return { ...base, kind: "error", label: "OpenCode 错误", status: "error", body: text(object(event.error).message ?? event.message ?? event.error) };
  if (event.type === "prompt_request_started") return { ...base, kind: "status", label: "请求已提交", status: "running", body: text(event.message) };
  return { ...base, kind: "status", label: "OpenCode 状态", status: string(event.status ?? event.state) || "unknown", body: text(event.message ?? event.status ?? event.state) };
}

function fingerprint(value) {
  // Two independent 32-bit lanes; only a UI identity, never an evidence digest.
  let left = 0x811c9dc5, right = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}-${value.length}`;
}

/** Stable for identical payloads; occurrence disambiguates exact duplicate rows. */
export function itemKey(item, occurrence = 0) {
  const value = object(item);
  const identity = [value.event_id, value.sequence, value.part_id, value.occurred_at, value.source, value.domain, value.task_id,
    value.session_id, value.call_id, value.event_type, value.kind, value.status, value.label, value.body, value.detail, value.usage];
  return `audit-event-${fingerprint(JSON.stringify(identity))}-${Number.isSafeInteger(occurrence) && occurrence >= 0 ? occurrence : 0}`;
}

/** No network, DOM, Node imports, mutations, task status inference or HTML. */
export function normalizeAuditEvent(item) {
  const result = normalize(item);
  return { ...result, event_key: itemKey(result) };
}

/** Keep exact duplicates; latest-tail APIs cannot identify them across windows. */
export function normalizeAuditEvents(items) {
  const occurrences = new Map();
  return (Array.isArray(items) ? items : []).map(item => {
    const result = normalizeAuditEvent(item), baseKey = result.event_key;
    const occurrence = occurrences.get(baseKey) ?? 0;
    occurrences.set(baseKey, occurrence + 1);
    return { ...result, event_key: itemKey(result, occurrence) };
  });
}
