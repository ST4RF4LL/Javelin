import { zipSync, strToU8 } from "fflate";
import { stringify } from "yaml";
import { createHash } from "node:crypto";
import { redactJsonText } from "../../lib/json-text-redaction.mjs";

const MAX_EXCHANGES = 100;
const MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const SECRET_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key", "x-auth-token"]);
const REDACTED = "[REDACTED]";

function secretName(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return /(?:authorization|cookie|password|passwd|secret|token|apikey|accesstoken|refreshtoken|clientsecret|session|sessionid)$/.test(normalized);
}

function exportError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

function safeSegment(value, fallback = "request") {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 72);
  return normalized || fallback;
}

function variableName(sequence, label, suffix = "") {
  const safe = String(label ?? "SECRET").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "SECRET";
  return `DYNVAL_${String(sequence).padStart(3, "0")}_${safe}${suffix}`;
}

function placeholderFactory(sequence, environmentKeys) {
  const counts = new Map();
  return label => {
    const base = variableName(sequence, label);
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    const key = count === 1 ? base : `${base}_${count}`;
    environmentKeys.add(key);
    return `{{process.env.${key}}}`;
  };
}

function replaceRedactedText(value, makePlaceholder, label) {
  let index = 0;
  return String(value ?? "").replaceAll(REDACTED, () => makePlaceholder(`${label}_${++index}`));
}

function requestUrl(value, baseVariable, makePlaceholder) {
  return preservedUrl(value, baseVariable, makePlaceholder);
}

function requestHeaders(headers, makePlaceholder) {
  const connectionHeaders = String(headerValue(headers, "connection") ?? "").toLowerCase().split(",").map(name => name.trim());
  return (headers ?? []).filter(header => !OMIT_REQUEST_HEADERS.has(String(header.name).toLowerCase()) && !connectionHeaders.includes(String(header.name).toLowerCase())).map(header => {
    const name = String(header.name ?? "");
    const value = String(header.value ?? "");
    const secret = SECRET_HEADERS.has(name.toLowerCase()) || secretName(name);
    return { name, value: secret ? makePlaceholder(name) : textWithSecrets(value, makePlaceholder) };
  });
}

function formBody(text, makePlaceholder) {
  return [...new URLSearchParams(text).entries()].map(([name, value]) => ({
    name,
    value: secretName(name) ? makePlaceholder(name) : replaceRedactedText(value, makePlaceholder, name),
  }));
}

function requestBody(body, headers, makePlaceholder) {
  if (!body?.text) return undefined;
  const headerType = headers.find(header => header.name.toLowerCase() === "content-type")?.value;
  const mediaType = String(headerType ?? body.media_type ?? "text/plain").split(";", 1)[0].trim().toLowerCase();
  const text = String(body.text);
  if (mediaType.includes("json")) {
    try { JSON.parse(text); return { type: "json", data: safeText(text, makePlaceholder) }; }
    catch { return { type: "text", data: textWithSecrets(text, makePlaceholder) }; }
  }
  if (mediaType === "application/x-www-form-urlencoded") {
    return { type: "form-urlencoded", data: formBody(text, makePlaceholder) };
  }
  if (mediaType.includes("xml")) return { type: "xml", data: textWithSecrets(text, makePlaceholder) };
  return { type: "text", data: textWithSecrets(text, makePlaceholder) };
}

function requestDocs(exchange) {
  const response = exchange.response ?? {};
  const body = response.body;
  return [
    "由动态验证平台的只读发包记录导出。原始凭据未包含在此集合中。",
    "",
    `- exchange_id: ${exchange.exchange_id}`,
    `- parent_exchange_id: ${exchange.parent_exchange_id ?? "无"}`,
    `- source: ${exchange.source}`,
    `- recorded_at: ${exchange.started_at}`,
    `- response_status: ${response.status ?? "ERR"}`,
    `- duration_ms: ${exchange.duration_ms}`,
    `- response_body_sha256: ${body?.sha256 ?? "无"}`,
    `- response_body_size: ${body?.size ?? 0}`,
    `- redirect_count: ${(exchange.redirect_chain ?? []).length}`,
  ].join("\n");
}

function requestFile(exchange, sequence, baseVariable, environmentKeys) {
  const gap = bodyReplayGap(exchange.request);
  if (gap) throw exportError(`${exchange.exchange_id}：${gap}。OpenCollection ZIP 不会生成不完整请求，请改用 Bruno JSON 导出保存历史证据。`, 422, "bruno-export-body-incomplete");
  const makePlaceholder = placeholderFactory(sequence, environmentKeys);
  const headers = requestHeaders(exchange.request.headers, makePlaceholder);
  const body = requestBody(exchange.request.body, headers, makePlaceholder);
  const url = new URL(exchange.request.url);
  if ((url.username || url.password) && !headers.some(header => header.name.toLowerCase() === "authorization")) headers.push({ name: "Authorization", value: `Basic ${makePlaceholder("URL_BASIC_AUTH_BASE64")}` });
  const pathName = safeSegment(url.pathname.split("/").filter(Boolean).slice(-2).join("-") || "root");
  const shortId = safeSegment(exchange.exchange_id.replace(/^http_/, "").slice(0, 8), "exchange");
  const name = `${exchange.request.method} ${url.pathname}`.slice(0, 120);
  const document = {
    info: { name, type: "http", seq: sequence },
    http: {
      method: exchange.request.method,
      url: requestUrl(exchange.request.url, `{{${baseVariable}}}`, makePlaceholder),
      ...(headers.length ? { headers } : {}),
      ...(body ? { body } : {}),
      auth: "none",
    },
    settings: { encodeUrl: false, timeout: 15000, followRedirects: false, maxRedirects: 0 },
    docs: { content: requestDocs(exchange), type: "text/markdown" },
  };
  return {
    path: `requests/${String(sequence).padStart(3, "0")}-${safeSegment(exchange.request.method, "HTTP")}-${pathName}-${shortId}.yml`,
    content: stringify(document, { lineWidth: 0 }),
  };
}

function archiveName(date) {
  return `dynamic-validation-${date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}

export function buildOpenCollectionArchive(exchanges, { generatedAt = new Date() } = {}) {
  if (!Array.isArray(exchanges) || !exchanges.length || exchanges.length > MAX_EXCHANGES) {
    throw exportError(`Bruno 导出必须包含 1-${MAX_EXCHANGES} 条记录。`, 422, "bruno-export-count-invalid");
  }
  const unique = new Map();
  for (const exchange of exchanges) {
    if (!exchange?.exchange_id || !exchange?.request?.url || !exchange?.request?.method) throw exportError("HTTP exchange 结构无效。", 422, "bruno-export-exchange-invalid");
    unique.set(exchange.exchange_id, exchange);
  }
  const ordered = [...unique.values()].sort((left, right) => String(left.started_at).localeCompare(String(right.started_at)) || left.exchange_id.localeCompare(right.exchange_id));
  const name = archiveName(generatedAt);
  const origins = [...new Set(ordered.map(exchange => new URL(exchange.request.url).origin))];
  const baseVariables = new Map(origins.map((origin, index) => [origin, index === 0 ? "baseUrl" : `baseUrl${index + 1}`]));
  const environmentKeys = new Set();
  const files = new Map();
  files.set("opencollection.yml", stringify({
    opencollection: "1.0.0",
    info: { name: `Dynamic Validation Export ${generatedAt.toISOString()}` },
    bundled: false,
    extensions: { bruno: { ignore: [".env", ".env.example", "README.md"] } },
  }, { lineWidth: 0 }));
  files.set("environments/local.yml", stringify({
    name: "local",
    variables: origins.map(origin => ({ name: baseVariables.get(origin), value: origin })),
  }, { lineWidth: 0 }));
  ordered.forEach((exchange, index) => {
    const file = requestFile(exchange, index + 1, baseVariables.get(new URL(exchange.request.url).origin), environmentKeys);
    files.set(file.path, file.content);
  });
  files.set(".env.example", `${[...environmentKeys].sort().map(key => `${key}=`).join("\n")}${environmentKeys.size ? "\n" : ""}`);
  files.set("README.md", [
    "# 动态验证请求导出",
    "",
    "本目录是 OpenCollection 1.0.0 YAML 集合；建议使用 Bruno 3.1 或更高版本。它是打开目录格式，不能当作 Bruno Collection JSON 导入。",
    "",
    "1. 解压 ZIP，并在 Bruno 中打开解压后的集合目录。",
    "2. 选择 `local` 环境。",
    "3. 如 `.env.example` 包含变量，复制为 `.env` 并仅在本机填写凭据。",
    "4. 运行前确认目标仍属于你明确授权的测试环境。重定向默认关闭。",
    "",
    "导出文件不包含原始认证凭据、响应头或响应正文。需要历史响应时请选择 Bruno JSON 导出。Bruno 本身不会继承平台的授权控制。",
    "",
  ].join("\n"));
  let uncompressedBytes = 0;
  const archiveEntries = {};
  for (const [path, content] of files) {
    const bytes = strToU8(content);
    uncompressedBytes += bytes.length;
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw exportError("Bruno 导出内容超过 32 MiB。", 413, "bruno-export-too-large");
    archiveEntries[`${name}/${path}`] = [bytes, { level: 6 }];
  }
  return {
    bytes: Buffer.from(zipSync(archiveEntries, { level: 6 })),
    filename: `${name}.zip`,
    collection_name: name,
    exchange_count: ordered.length,
  };
}

export const BRUNO_EXPORT_LIMITS = Object.freeze({ max_exchanges: MAX_EXCHANGES, max_uncompressed_bytes: MAX_UNCOMPRESSED_BYTES });

// Bruno's Import Collection -> Bruno Collection accepts this versioned JSON
// document. OpenCollection ZIP is a directory format, not this import format.
const OMIT_REQUEST_HEADERS = new Set(["host", "content-length", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const uid = value => createHash("sha256").update(String(value)).digest("hex").slice(0, 21);
const headerValue = (headers, name) => (headers ?? []).find(header => String(header.name).toLowerCase() === name)?.value;

function textWithSecrets(text, replace) {
  return String(text ?? "")
    .replace(/\b(Bearer|Basic)\s+[^\s,"'<>]+/gi, (_, scheme) => `${scheme} ${replace("AUTHORIZATION")}`)
    .replace(/((?:password|passwd|client[_-]?secret|secret|access[_-]?token|refresh[_-]?token|token|authorization|cookie|api[_-]?key)\s*[:=]\s*)(["'])([\s\S]*?)\2/gi, (_, prefix, quote) => `${prefix}${quote}${replace("BODY_SECRET")}${quote}`)
    .replace(/((?:password|passwd|client[_-]?secret|secret|access[_-]?token|refresh[_-]?token|token|authorization|cookie|api[_-]?key)\s*[:=]\s*)(?!["'{])[^\s,&<>"']+/gi, (_, prefix) => `${prefix}${replace("BODY_SECRET")}`)
    .replace(/(<((?:[\w.-]+:)?(?:password|passwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|authorization|cookie|session(?:id)?))\b[^>]*>)[\s\S]*?(<\/\2\s*>)/gi, (_, open, name, close) => `${open}${replace(name)}${close}`)
    .replaceAll(REDACTED, () => replace("REDACTED"));
}

function safeText(text, replace) {
  try {
    return redactJsonText(text, { sensitiveKey: secretName, replaceSensitive: replace, redactString: value => textWithSecrets(value, replace) });
  } catch { return textWithSecrets(text, replace); }
}

function preservedUrl(value, base, replace) {
  const url = new URL(value);
  // Keep duplicate keys, '+' versus '%20', encoded slashes and bare flags intact.
  const search = url.search.slice(1).split("&").map(pair => {
    if (!pair) return pair;
    const equals = pair.indexOf("=");
    const name = equals < 0 ? pair : pair.slice(0, equals);
    const raw = equals < 0 ? "" : pair.slice(equals + 1);
    let decodedName, decodedValue;
    try { decodedName = decodeURIComponent(name.replaceAll("+", " ")); decodedValue = decodeURIComponent(raw.replaceAll("+", " ")); }
    catch { decodedName = name; decodedValue = raw; }
    if (secretName(decodedName) || decodedValue.includes(REDACTED)) return `${name}=${replace(decodedName)}`;
    const cleaned = textWithSecrets(decodedValue, replace);
    return cleaned === decodedValue ? pair : `${name}=${encodeURIComponent(cleaned).replaceAll("%7B", "{").replaceAll("%7D", "}")}`;
  }).join("&");
  const pathname = url.pathname.replace(/(?:%5BREDACTED%5D|\[REDACTED\])/gi, () => replace("PATH_SECRET"));
  return `${base}${pathname}${url.search ? `?${search}` : ""}`;
}

function bodyUnavailable(body) {
  return body?.available === false || body?.omitted === true || ["missing", "unavailable", "omitted", "not_captured"].includes(String(body?.capture_status ?? "").toLowerCase())
    || /^<(?:binary data|not available anymore|(?:Request|Response) body not available(?: anymore)?)>$/i.test(String(body?.text ?? "").trim());
}

function bodyReplayGap(request) {
  const body = request.body;
  if (bodyUnavailable(body)) return "请求正文未捕获或已无法读取";
  if (body?.truncated) return "请求正文已截断";
  if (body?.encoding === "base64" || body?.binary || body?.base64) return "请求正文仅有二进制记录";
  if (!body) {
    if (/^(POST|PUT|PATCH)$/i.test(request.method) || Number(headerValue(request.headers, "content-length")) > 0 || headerValue(request.headers, "transfer-encoding")) return "没有捕获请求正文，无法确认是否为空";
    return null;
  }
  if (typeof body.text !== "string") return "没有捕获可还原的请求正文";
  const type = String(headerValue(request.headers, "content-type") ?? body.media_type ?? "").toLowerCase();
  if (/multipart\//.test(type)) return "multipart 正文不能可靠还原为表单和文件";
  if (body.text.includes("\u0000") || (body.text.length && type && !/(?:text\/|json|xml|javascript|x-www-form-urlencoded|graphql|sparql)/.test(type))) return "请求正文为二进制或未知媒体类型";
  return null;
}

function jsonRequestBody(request, replace, itemUid) {
  const body = request.body;
  if (!body) return { mode: "none" };
  const type = String(headerValue(request.headers, "content-type") ?? body.media_type ?? "text/plain").toLowerCase();
  if (type.includes("application/x-www-form-urlencoded")) return {
    mode: "formUrlEncoded",
    formUrlEncoded: [...new URLSearchParams(body.text).entries()].map(([name, value], index) => ({ uid: uid(`${itemUid}:form:${index}`), name, value: secretName(name) ? replace(name) : textWithSecrets(value, replace), enabled: true })),
  };
  const mode = type.includes("json") ? "json" : type.includes("xml") ? "xml" : "text";
  return { mode, [mode]: safeText(body.text, replace) };
}

function exchangeIdentity(exchange) {
  const source = exchange.provenance ?? {};
  return Object.fromEntries(Object.entries({
    exchange_id: exchange.exchange_id, parent_exchange_id: exchange.parent_exchange_id ?? null,
    audit_id: exchange.audit_id ?? source.audit_id ?? null,
    finding_id: exchange.finding_id ?? source.finding_id ?? null,
    validation_run_id: exchange.validation_run_id ?? exchange.run_id ?? null,
    repository_id: exchange.repository_id ?? source.repository_id ?? null,
    product_id: exchange.product_id ?? source.product_id ?? null,
    artifact_id: exchange.evidence_binding?.artifact_id ?? null,
    artifact_sha256: exchange.evidence_binding?.sha256 ?? null,
    packet_id: exchange.evidence_binding?.packet_id ?? null,
    step_id: exchange.evidence_binding?.step_id ?? null,
    phase: exchange.evidence_binding?.phase ?? null,
    sequence: exchange.evidence_binding?.sequence ?? null,
    network_request_id: exchange.evidence_binding?.network_request_id ?? null,
    recorded_at: exchange.started_at ?? null, source: exchange.source ?? null,
    timestamp_source: exchange.timestamp_source ?? null,
    duration_ms: exchange.duration_ms ?? null,
    captured_request_body_sha256: bodyUnavailable(exchange.request.body) ? null : exchange.request.body?.sha256 ?? null,
    captured_response_body_sha256: bodyUnavailable(exchange.response?.body) ? null : exchange.response?.body?.sha256 ?? null,
    response_body_truncated: exchange.response?.body?.truncated === true,
    request_body_available: Boolean(exchange.request.body) && !bodyUnavailable(exchange.request.body),
    response_body_available: Boolean(exchange.response?.body) && !bodyUnavailable(exchange.response?.body),
  }).filter(([, value]) => value !== undefined));
}

function historyResponse(exchange, itemUid) {
  const response = exchange.response ?? {};
  const body = response.body;
  const textAvailable = body && !bodyUnavailable(body) && typeof body.text === "string" && !body.binary && body.encoding !== "base64";
  const type = String(body?.media_type ?? "").toLowerCase();
  return {
    status: Number.isInteger(response.status) ? response.status : null,
    statusText: textWithSecrets(response.status_text ?? "", () => REDACTED),
    headers: (response.headers ?? []).map((header, index) => ({
      uid: uid(`${itemUid}:response-header:${index}`), name: String(header.name ?? ""), enabled: true,
      value: SECRET_HEADERS.has(String(header.name).toLowerCase()) || secretName(header.name) ? REDACTED : textWithSecrets(header.value, () => REDACTED),
    })),
    body: textAvailable ? { type: type.includes("json") ? "json" : type.includes("xml") ? "xml" : type.includes("html") ? "html" : "text", content: safeText(body.text, () => REDACTED) } : null,
  };
}

/** Build Bruno Collection JSON without executing requests or attaching credentials. */
export function buildBrunoCollection(exchanges, { generatedAt = new Date() } = {}) {
  if (!Array.isArray(exchanges) || !exchanges.length || exchanges.length > MAX_EXCHANGES) throw exportError(`Bruno 导出必须包含 1-${MAX_EXCHANGES} 条记录。`, 422, "bruno-export-count-invalid");
  const unique = new Map();
  for (const exchange of exchanges) {
    if (!exchange?.exchange_id || !exchange?.request?.url || !exchange?.request?.method) throw exportError("HTTP exchange 结构无效。", 422, "bruno-export-exchange-invalid");
    let url;
    try { url = new URL(exchange.request.url); } catch { throw exportError("HTTP exchange URL 无效。", 422, "bruno-export-url-invalid"); }
    if (!["http:", "https:"].includes(url.protocol)) throw exportError("Bruno 导出仅接受 HTTP(S) 请求记录。", 422, "bruno-export-url-invalid");
    if (unique.has(exchange.exchange_id) && JSON.stringify(unique.get(exchange.exchange_id)) !== JSON.stringify(exchange)) throw exportError("相同 exchange ID 对应不同记录，无法确定导出来源。", 409, "bruno-export-id-conflict");
    unique.set(exchange.exchange_id, exchange);
  }
  const ordered = [...unique.values()].sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)) || a.exchange_id.localeCompare(b.exchange_id));
  const name = archiveName(generatedAt);
  const origins = [...new Set(ordered.map(exchange => new URL(exchange.request.url).origin))];
  const environmentUid = uid(`${name}:environment`);
  const variables = origins.map((origin, index) => ({ uid: uid(`${name}:base:${index}`), name: index === 0 ? "baseUrl" : `baseUrl${index + 1}`, value: origin, enabled: true, type: "text", secret: false }));
  const warnings = [], items = [], evidenceOnly = [];
  for (const [index, exchange] of ordered.entries()) {
    const itemUid = uid(`${name}:${exchange.exchange_id}`), keys = new Set();
    const makeProcessPlaceholder = placeholderFactory(index + 1, keys);
    const replace = label => makeProcessPlaceholder(label).replace("process.env.", "");
    const parsedUrl = new URL(exchange.request.url);
    const originVariable = variables[origins.indexOf(parsedUrl.origin)].name;
    const url = preservedUrl(exchange.request.url, `{{${originVariable}}}`, replace);
    const connectionHeaders = String(headerValue(exchange.request.headers, "connection") ?? "").toLowerCase().split(",").map(name => name.trim());
    const headers = (exchange.request.headers ?? []).filter(header => !OMIT_REQUEST_HEADERS.has(String(header.name).toLowerCase()) && !connectionHeaders.includes(String(header.name).toLowerCase())).map((header, headerIndex) => {
      const name = String(header.name ?? ""), raw = String(header.value ?? "");
      let value;
      if (name.toLowerCase() === "authorization") {
        const scheme = raw.match(/^(Bearer|Basic)\s+/i)?.[1];
        value = scheme ? `${scheme} ${replace(`${name}_${scheme}`)}` : replace(name);
      } else value = SECRET_HEADERS.has(name.toLowerCase()) || secretName(name) ? replace(name) : textWithSecrets(raw, replace);
      return { uid: uid(`${itemUid}:header:${headerIndex}`), name, value, enabled: true };
    });
    if ((parsedUrl.username || parsedUrl.password) && !headers.some(header => header.name.toLowerCase() === "authorization")) headers.push({ uid: uid(`${itemUid}:url-auth`), name: "Authorization", value: `Basic ${replace("URL_BASIC_AUTH_BASE64")}`, enabled: true });
    const gap = bodyReplayGap(exchange.request);
    const identity = exchangeIdentity(exchange);
    const docs = [
      "# 动态验证 HTTP 记录", "", "这是已捕获的历史证据，不代表再次执行后的结果。凭据已移除；请先在 local 环境填写空白凭据变量，确认测试授权后再发送。",
      "", "原始捕获正文的 SHA-256 用于关联平台证据；导出中的脱敏正文与原始字节不同。",
      ...(exchange.response?.body?.truncated ? ["", "注意：历史响应正文已截断，仅显示已捕获的部分。"] : []),
      ...(!exchange.response?.body || bodyUnavailable(exchange.response.body) || exchange.response.body.binary || exchange.response.body.encoding === "base64" ? ["", "捕获缺口：未捕获历史响应正文、正文已无法读取或只有二进制记录，Examples 中的响应 body 为 null。"] : []),
      ...(exchange.capture_gaps?.length ? ["", "## 来源捕获局限", ...exchange.capture_gaps.map(gap => `- ${textWithSecrets(gap, () => REDACTED)}`)] : []),
      ...(exchange.response?.error ? ["", `捕获错误：${textWithSecrets(exchange.response.error, () => REDACTED)}`] : []),
      "", "```json", JSON.stringify(identity, null, 2), "```",
    ].join("\n");
    if (gap) {
      const message = `${exchange.exchange_id}：${gap}；仅保存历史证据，未生成可发送请求。`;
      warnings.push({ exchange_id: exchange.exchange_id, code: "request-body-incomplete", message });
      evidenceOnly.push({ ...identity, replay_gap: gap, request: { method: exchange.request.method, url, headers, body_excerpt: bodyUnavailable(exchange.request.body) ? null : safeText(exchange.request.body?.text ?? "", () => REDACTED) }, response: historyResponse(exchange, itemUid) });
    } else {
      const body = jsonRequestBody(exchange.request, replace, itemUid);
      const request = { url, method: exchange.request.method, headers, params: [], body, auth: { mode: "none" }, script: { req: "", res: "" }, vars: { req: [], res: [] }, assertions: [], tests: "", docs };
      items.push({ uid: itemUid, type: "http-request", name: `${String(index + 1).padStart(3, "0")} ${exchange.request.method} ${parsedUrl.pathname}`.slice(0, 180), seq: index + 1, request,
        settings: { encodeUrl: false, followRedirects: false, maxRedirects: 0, timeout: 15000 },
        examples: [{ uid: uid(`${itemUid}:example`), itemUid, type: "http-request", name: `历史响应 · ${exchange.response?.status ?? "未收到响应"}`, description: docs,
          request: { url, method: request.method, headers, params: [], body }, response: historyResponse(exchange, itemUid) }],
      });
    }
    for (const key of keys) variables.push({ uid: uid(`${name}:secret:${key}`), name: key, value: "", enabled: true, type: "text", secret: true });
  }
  const rootDocs = [
    "# 动态验证证据与 Bruno 请求集合", "", "导入：Bruno → Import Collection → 选择本 JSON 文件；如有格式选项，选择 Bruno Collection。",
    "选择 local 环境并填写空白凭据变量；所有认证信息均由操作者在本机补全。导入只创建集合，不发送请求。",
    "每个请求的 Examples 保存历史响应，Docs 保存审计、漏洞与 HTTP 证据标识。导出不等于漏洞已被确认。",
    "已移除 Host、Content-Length 和逐跳请求头，由客户端根据实际发送内容生成；重定向默认关闭。",
    "运行前请确认目标仍属于你明确授权的测试环境，Bruno 不继承平台的授权控制。",
    "", `记录数：${ordered.length}；可补充凭据后发送：${items.length}；仅保留证据：${evidenceOnly.length}。`,
    ...(warnings.length ? ["", "## 导出局限", ...warnings.map(warning => `- ${warning.message}`)] : []),
    ...(evidenceOnly.length ? ["", "## 未生成请求的历史证据", "```json", JSON.stringify(evidenceOnly, null, 2), "```"] : []),
  ].join("\n");
  const document = { version: "1", uid: uid(`${name}:collection`), name: `动态验证 · ${generatedAt.toISOString()}`, items, environments: [{ uid: environmentUid, name: "local", variables }], activeEnvironmentUid: environmentUid,
    root: { docs: rootDocs, request: { headers: [], auth: { mode: "none" }, script: { req: "", res: "" }, vars: { req: [], res: [] }, tests: "" } } };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  if (bytes.length > MAX_UNCOMPRESSED_BYTES) throw exportError("Bruno 导出内容超过 32 MiB。", 413, "bruno-export-too-large");
  return { bytes, filename: `${name}.bruno.json`, document, collection_name: name, exchange_count: ordered.length, replayable_count: items.length, skipped_count: evidenceOnly.length, warnings, mime_type: "application/json", format: "bruno-json" };
}
