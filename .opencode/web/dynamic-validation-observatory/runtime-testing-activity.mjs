import { createHash } from "node:crypto";
import { controlledBytes } from "../../lib/task-board/contract.mjs";
import { PROTOCOL, ID, SHA, PHASES, digest, validatePacket, httpUrl } from "../../lib/runtime-testing/contract.mjs";
import { sanitizeForWeb } from "./model.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const ensure = (value, message) => { if (!value) throw new Error(message); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const phaseName = phase => ({ CONTACT: "环境接触", EXPLORE: "探索验证", CONFIRM: "漏洞确认", CLEANUP: "测试清理" })[phase] ?? "动态执行";
const unique = rows => [...new Set(rows.filter(Boolean))];

function preview(value, gaps) {
  const safe = sanitizeForWeb(value), text = typeof safe === "string" ? safe : JSON.stringify(safe);
  if (text == null || text.length <= 64 * 1024) return safe;
  gaps.push("动作详情超过显示上限，已截断；关联 HTTP 正文仍保留其原始捕获标记。");
  return { text: text.slice(0, 64 * 1024), truncated: true };
}

function headers(value) {
  if (value == null) return [];
  ensure(object(value) && Object.values(value).every(item => typeof item === "string"), "网络头不是受支持的结构化格式。");
  return Object.entries(value).map(([name, value]) => ({ name, value }));
}
function body(value, headerList) {
  if (value == null) return null;
  ensure(typeof value === "string", "网络正文不是受支持的文本格式。");
  const unavailable = /^<(?:binary data|not available anymore|Response body not available anymore|Request body not available anymore)>$/.test(value);
  const text = value === "<empty response>" ? "" : value;
  return { text, media_type: headerList.find(row => row.name.toLowerCase() === "content-type")?.value ?? "application/octet-stream",
    sha256: hash(text), size: Buffer.byteLength(text), size_kind: "captured", truncated: value.endsWith("... <truncated>"), available: !unavailable };
}

// Chrome DevTools MCP 1.8.0: McpResponse.structuredContent.networkRequest,
// NetworkFormatter.toJSONDetailed(). Text renderings omit the HTTP method and
// can contain arbitrary response headings; never infer an exchange from them.
export function runtimeNetworkExchange({ content, record, binding, packet, repositoryId, authorization }) {
  const gaps = [];
  if (content?.tool !== "get_network_request") return { exchange: null, gaps };
  try {
    ensure(!content.result?.isError, "网络工具调用失败，未生成可导出的 HTTP 记录。");
    const value = content.result?.structuredContent?.networkRequest;
    ensure(object(value), "未捕获可靠的结构化请求/响应；保留脱敏工具原文，不生成猜测的 HTTP 记录。");
    const url = httpUrl(value.url);
    ensure(url && authorization.origins?.includes(url.origin), "网络记录的 URL 未绑定当前授权来源，不能导出。");
    ensure(typeof value.method === "string" && /^[A-Z]+$/.test(value.method) && Number.isInteger(value.requestId) && value.requestId > 0 && object(value.requestHeaders), "结构化网络记录缺少方法、请求头或请求编号。");
    ensure(content.arguments?.reqid == null || content.arguments.reqid === value.requestId, "网络请求编号与工具参数不一致。");
    const requestHeaders = headers(value.requestHeaders), responseHeaders = headers(value.responseHeaders);
    const responseStatus = /^\d{3}$/.test(String(value.status)) ? Number(value.status) : null;
    ensure(responseStatus == null || responseStatus >= 100 && responseStatus <= 599, "网络响应状态无效。");
    const requestBody = body(value.requestBody, requestHeaders), responseBody = body(value.responseBody, responseHeaders);
    if (value.requestBodyFilePath || value.responseBodyFilePath) gaps.push("正文仅保存在工具侧文件，当前只读接口不会读取或导出该文件。");
    if (requestBody?.truncated || responseBody?.truncated) gaps.push("工具捕获的 HTTP 正文已截断，导出保留截断标记。");
    if (requestBody?.available === false || responseBody?.available === false) gaps.push("部分 HTTP 正文不可用，导出保留工具返回的缺失标记。");
    if (responseStatus == null) gaps.push("未捕获完整 HTTP 响应状态。");
    if (responseStatus != null && responseBody == null) gaps.push("工具未保存响应正文；空缺不代表响应体为空。");
    const redirects = Array.isArray(value.redirectChain) ? value.redirectChain.filter(row => object(row) && httpUrl(row.url)).map(row => ({ request_id: row.requestId ?? null, method: row.method ?? null, url: row.url, status: row.status ?? null })) : [];
    if (redirects.length) gaps.push("重定向链仅包含工具摘要，未自动构造各跳的 HTTP 请求/响应。");
    const exchangeId = `http_runtime-${hash(`${repositoryId}\0${packet.audit_id}\0${binding.id}\0${binding.sha256}`).slice(0, 32)}`;
    return { gaps, exchange: sanitizeForWeb({ schema_version: 2, artifact_type: "HTTP_EXCHANGE_V2", exchange_id: exchangeId,
      parent_exchange_id: null, request_session_id: content.identity_id ?? null, source: "chrome_devtools_mcp", runtime_protocol: PROTOCOL,
      audit_id: packet.audit_id, repository_id: repositoryId, finding_id: packet.finding_id ?? null,
      started_at: record.recorded_at, recorded_at: record.recorded_at, timestamp_source: "evidence_capture", duration_ms: null,
      request: { method: value.method, url: value.url, headers: requestHeaders, body: requestBody },
      response: { status: responseStatus, status_text: "", headers: responseHeaders, body: responseBody, error: value.failure ?? (responseStatus == null ? String(value.status ?? "UNKNOWN") : null) },
      redirect_chain: redirects, capture_gaps: [...gaps, "此工具未提供请求开始时间和耗时，时间为证据记录时间。"],
      evidence_binding: { artifact_id: binding.id, sha256: binding.sha256, packet_id: packet.id, phase: packet.phase,
        sequence: Number(binding.id.slice(binding.id.lastIndexOf("-") + 1)), browser_context_id: content.identity_id ?? null, network_request_id: value.requestId }, sanitized: true }) };
  } catch (error) { return { exchange: null, gaps: [error.message] }; }
}

export async function readRuntimeTestingActivity({ reportsRoot, repositoryId, audit }) {
  const auditId = audit.id ?? audit.audit_id, cases = [], exchanges = [];
  const baseCase = (packetId, phase, findingId = null) => ({ id: `runtime:${repositoryId}:${auditId}:${packetId}`, repository_id: repositoryId, audit_id: auditId,
    finding_id: findingId, title: findingId ? `漏洞 ${findingId}` : `${phaseName(phase)} / 未关联漏洞`, status: "UNKNOWN", summary: "", updated_at: null,
    phase, packet_id: packetId, actions: [], exchange_ids: [], gaps: [] });
  const fallback = baseCase("audit", "CONTACT");
  fallback.status = audit.runtime_testing_state?.status ?? "UNKNOWN";
  fallback.summary = audit.runtime_testing_state?.reason ?? "尚无可读取的动态执行证据。";
  async function read(path, sha = null) {
    const bytes = await controlledBytes(reportsRoot, `runtime-testing/${auditId}/${path}`, 16 * 1024 * 1024);
    if (sha != null) ensure(SHA.test(sha) && hash(bytes) === sha, "证据文件 SHA-256 不匹配。");
    return JSON.parse(bytes.toString("utf8"));
  }
  const sealed = value => ensure(value?.protocol === PROTOCOL && value.audit_id === auditId && value.artifact_digest === digest(value), "动态证据协议、审计或封存摘要不匹配。");
  try {
    ensure(typeof auditId === "string" && ID.test(auditId), "审计编号格式无效。");
    const authorization = await read("authorization.json"); sealed(authorization);
    let state, terminal = false;
    try { state = await read("evidence-set.json"); terminal = true; sealed(state); ensure(state.artifact_type === "runtime-testing-evidence-set", "证据集类型无效。"); }
    catch (error) { if (error.code !== "ENOENT") throw error; state = await read("state.json"); }
    ensure(state.protocol === PROTOCOL && state.audit_id === auditId && state.authorization_digest === authorization.artifact_digest
      && state.environment_revision === authorization.environment_revision && Array.isArray(state.packets), "执行状态与授权或审计绑定不一致。");
    const bindings = terminal ? state.evidence_bindings : state.evidence;
    ensure(Array.isArray(bindings) && new Set(bindings.map(row => row.id)).size === bindings.length, "证据索引缺失或重复。");
    ensure(new Set(state.packets.map(row => row.id)).size === state.packets.length, "执行工作包编号重复。");
    fallback.status = state.status; fallback.summary = state.reason ?? "本次动态执行尚无动作。"; fallback.updated_at = state.started_at ?? null;
    for (const row of state.packets) {
      const item = baseCase(row.id, row.phase); item.status = row.execution_status ?? "UNKNOWN"; item.updated_at = row.started_at ?? null;
      item.runtime_status = state.status; item.packet_status = item.status; item.cleanup_status = state.cleanup_status ?? "UNKNOWN";
      item.summary = row.summary ?? row.reason ?? `${phaseName(row.phase)}：${item.status}`;
      try {
        ensure(ID.test(row.id) && PHASES.includes(row.phase), "执行工作包标识或阶段无效。");
        if (!row.input_digest) {
          ensure(["SKIPPED", "FAILED"].includes(row.execution_status), "工作包缺少封存输入绑定。");
          item.gaps.push("工作包未进入执行，未捕获实际动作。");
          if (state.status === "BLOCKED") { item.status = "BLOCKED"; if (state.reason) item.gaps.push(state.reason); }
          cases.push(sanitizeForWeb(item)); continue;
        }
        const packet = await read(`packets/${row.id}.input.json`); sealed(packet);
        validatePacket(packet, authorization);
        ensure(packet.id === row.id && packet.artifact_digest === row.input_digest
          && ["phase", "finding_id", "finding_object_digest", "hypothesis_id", "scope_digest"].every(key => (packet[key] ?? null) === (row[key] ?? null)), "工作包输入与执行记录绑定不一致。");
        item.finding_id = packet.finding_id ?? null; item.title = item.finding_id ? `漏洞 ${item.finding_id}` : `${phaseName(packet.phase)} / 未关联漏洞`;
        if (row.result_path) {
          ensure(row.result_path === `packets/${row.id}.result.json`, "工作包结果路径无效。");
          const result = await read(row.result_path); sealed(result);
          ensure(result.artifact_digest === row.result_digest && result.packet_id === row.id && result.input_digest === row.input_digest
            && result.authorization_digest === authorization.artifact_digest && result.environment_revision === authorization.environment_revision
            && result.execution_status === row.execution_status, "工作包结果绑定不一致。");
          item.summary = result.summary ?? item.summary; item.gaps.push(...(Array.isArray(result.gaps) ? result.gaps : []));
        }
        const owned = bindings.filter(binding => binding.id.startsWith(`${row.id}.action-`));
        const admitted = new Set(row.evidence_ids ?? []);
        ensure(!terminal && row.execution_status === "RUNNING" && state.active_packet === row.id || owned.every(binding => admitted.has(binding.id)), "动作证据未绑定该工作包的已接收动作清单。");
        for (const id of admitted) if (!owned.some(binding => binding.id === id)) item.gaps.push(`动作 ${id} 缺少证据索引，未展示或导出。`);
        for (const binding of owned) {
          try {
            ensure(/^\d+$/.test(binding.id.slice(`${row.id}.action-`.length)) && binding.path === `evidence/${binding.id}.json`, "动作证据路径或编号无效。");
            const record = await read(binding.path, binding.sha256); sealed(record);
            ensure(typeof record.content === "string" || object(record.content), "动作证据正文无效。");
            ensure(typeof record.recorded_at === "string" && Number.isFinite(Date.parse(record.recorded_at)), "动作记录时间无效。");
            let content;
            if (Object.hasOwn(record, "structured_content")) {
              ensure(object(record.structured_content), "结构化动作证据格式无效。"); content = record.structured_content;
            } else {
              content = record.content;
              if (typeof content === "string") { try { content = JSON.parse(content); } catch { content = { raw: record.content }; } }
            }
            const gaps = [], action = { id: binding.id, packet_id: packet.id, phase: packet.phase, tool: typeof content.tool === "string" ? content.tool : "UNKNOWN",
              status: content.status === "FAILED" || content.result?.isError ? "FAILED" : content.raw ? "UNKNOWN" : "COMPLETED",
              recorded_at: record.recorded_at ?? null, summary: content.code ?? content.tool ?? "脱敏动作原文", identity_id: content.identity_id ?? null,
              exchange_ids: [], gaps };
            if (content.identity_id != null) ensure(packet.identity_ids.includes(content.identity_id), "动作身份不属于当前工作包。");
            const captured = runtimeNetworkExchange({ content, record, binding, packet, repositoryId, authorization });
            gaps.push(...captured.gaps);
            if (captured.exchange) { exchanges.push(captured.exchange); action.exchange_ids.push(captured.exchange.exchange_id); item.exchange_ids.push(captured.exchange.exchange_id); }
            if (content.arguments != null) action.arguments = preview(content.arguments, gaps);
            action.result = preview(content.raw ?? content.result ?? content, gaps);
            if (content.raw) gaps.push("脱敏原文无法可靠解析为结构化动作，未推断工具参数或 HTTP 请求。");
            item.actions.push(action); if (action.recorded_at > (item.updated_at ?? "")) item.updated_at = action.recorded_at;
          } catch (error) { item.gaps.push(`动作 ${binding.id} 无法读取：${error.message}`); }
        }
        if (!item.actions.length) {
          item.gaps.push("当前工作包没有可核验的实际动作记录。");
          if (state.status === "BLOCKED") { item.status = "BLOCKED"; if (state.reason) item.gaps.push(state.reason); }
        }
      } catch (error) { item.status = "EVIDENCE_INVALID"; item.gaps.push(error.message); }
      item.gaps = unique(item.gaps); cases.push(sanitizeForWeb(item));
    }
    if (!cases.length) { fallback.gaps.push("本次动态执行没有工作包或实际动作。"); cases.push(sanitizeForWeb(fallback)); }
  } catch (error) { fallback.gaps.push(`动态证据不可读取：${error.message}`); cases.push(sanitizeForWeb(fallback)); }
  return { cases, exchanges };
}
