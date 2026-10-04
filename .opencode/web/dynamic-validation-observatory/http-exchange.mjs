import { createHash } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function normalizedBody(body) {
  if (!body || typeof body !== "object") return null;
  const text = typeof body.text === "string" ? body.text : null;
  const available = text !== null && body.available !== false && !body.omitted && body.capture_status !== "missing";
  return {
    media_type: String(body.media_type ?? "application/octet-stream"),
    text,
    sha256: text === null ? null : sha256(text),
    size: text === null ? null : Buffer.byteLength(text, "utf8"),
    truncated: body.truncated === true,
    available,
    ...Object.fromEntries(["omitted", "capture_status", "encoding", "binary", "base64"].filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]])),
  };
}

function normalizedHeaders(headers) {
  return Array.isArray(headers)
    ? headers.map(header => ({ name: String(header?.name ?? ""), value: String(header?.value ?? "") }))
    : [];
}

function v2ExchangeId(value) {
  if (/^http_[A-Za-z0-9-]+$/.test(value ?? "")) return value;
  return `http_browser-${sha256(String(value ?? "unknown")).slice(0, 20)}`;
}

export function normalizeBrowserExchangeV2(exchange, reference = {}) {
  const request = exchange?.request ?? {};
  const response = exchange?.response ?? {};
  const legacy = exchange?.artifact_type !== "HTTP_EXCHANGE_V2" || exchange?.schema_version !== 2;
  if (!legacy) return structuredClone(exchange);
  const durationKnown = exchange?.duration_ms != null && Number.isFinite(Number(exchange.duration_ms)) && Number(exchange.duration_ms) >= 0;
  return {
    schema_version: 2,
    artifact_type: "HTTP_EXCHANGE_V2",
    exchange_id: v2ExchangeId(exchange?.exchange_id ?? reference?.exchange_id),
    parent_exchange_id: null,
    request_session_id: exchange?.browser_context_id ?? null,
    source: "chrome_devtools_mcp",
    ...Object.fromEntries(["audit_id", "repository_id", "finding_id"].filter(key => exchange?.[key] != null).map(key => [key, exchange[key]])),
    started_at: exchange?.started_at ?? null,
    duration_ms: durationKnown ? Math.round(Number(exchange.duration_ms)) : null,
    capture_gaps: [...(exchange?.capture_gaps ?? []), ...(!exchange?.started_at ? ["历史请求未记录开始时间。"] : []), ...(!durationKnown ? ["历史请求未记录耗时。"] : [])],
    request: {
      method: String(request.method ?? "UNKNOWN").toUpperCase(),
      url: String(request.url ?? ""),
      headers: normalizedHeaders(request.headers),
      body: normalizedBody(request.body),
    },
    response: {
      status: Number.isInteger(response.status) ? response.status : null,
      status_text: String(response.status_text ?? ""),
      headers: normalizedHeaders(response.headers),
      body: normalizedBody(response.body),
      error: response.error === null || typeof response.error === "string" ? response.error : null,
    },
    redirect_chain: Array.isArray(exchange?.redirect_chain) ? structuredClone(exchange.redirect_chain) : [],
    evidence_binding: {
      ...Object.fromEntries(["audit_id", "repository_id", "finding_id"].filter(key => exchange?.evidence_binding?.[key] != null).map(key => [key, exchange.evidence_binding[key]])),
      artifact_id: String(reference?.artifact_id ?? exchange?.evidence_binding?.artifact_id ?? "legacy-artifact"),
      sequence: Number.isInteger(exchange?.sequence) ? exchange.sequence : Number(reference?.sequence) || 1,
      phase: String(exchange?.phase ?? reference?.phase ?? "UNCLASSIFIED"),
      step_id: exchange?.step_id ?? reference?.step_id ?? null,
      browser_context_id: String(exchange?.browser_context_id ?? exchange?.request_session_id ?? "unknown-context"),
    },
    sanitized: true,
  };
}
