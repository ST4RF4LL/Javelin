import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { parse } from "yaml";
import { buildBrunoCollection, buildOpenCollectionArchive } from "../web/dynamic-validation-observatory/bruno-exporter.mjs";
import { loadOfficialBruno } from "./helpers/bruno-official.mjs";
import { runtimeNetworkExchange } from "../web/dynamic-validation-observatory/runtime-testing-activity.mjs";
import { redactJsonText } from "../lib/json-text-redaction.mjs";

const generatedAt = new Date("2026-10-03T00:00:00Z");
const body = (text, media_type = "application/json", rest = {}) => ({ text, media_type, sha256: createHash("sha256").update(text).digest("hex"), size: Buffer.byteLength(text), truncated: false, ...rest });
const fixture = (id = "http_export-1") => ({
  exchange_id: id, started_at: "2026-10-03T00:00:00Z", source: "chrome_devtools_mcp", duration_ms: 23,
  audit_id: "audit-fixture", finding_id: "finding-fixture", validation_run_id: "runtime-fixture", repository_id: "repository-fixture",
  evidence_binding: { artifact_id: "artifact-fixture", sequence: 1, phase: "REQUEST", step_id: "step-fixture" },
  request: {
    method: "POST", url: "https://authorized.example.invalid/api/a%2Fb?tag=one&tag=two&flag&q=a%20b&plus=a+b&token=fixture-query-secret",
    headers: [{ name: "Content-Type", value: "application/json" }, { name: "Authorization", value: "Bearer fixture-authorization-secret" }, { name: "Cookie", value: "session=fixture-cookie-secret" }, { name: "Host", value: "old-host.invalid" }, { name: "Content-Length", value: "999" }, { name: "Connection", value: "X-Connection-State" }, { name: "X-Connection-State", value: "old-state" }],
    body: body(JSON.stringify({ marker: "export-fixture", nested: { clientSecret: "fixture-json-secret" }, values: [1, false] })),
  },
  response: { status: 201, status_text: "Created", headers: [{ name: "Content-Type", value: "application/json" }, { name: "Set-Cookie", value: "session=fixture-response-cookie" }], body: body('{"ok":true,"accessToken":"fixture-response-secret"}'), error: null },
});
const official = loadOfficialBruno();
after(() => official?.cleanup());

test("Bruno JSON preserves evidence, request semantics and historical examples without leaking credentials", () => {
  const exchange = fixture(), before = structuredClone(exchange);
  const result = buildBrunoCollection([exchange], { generatedAt });
  assert.deepEqual(exchange, before);
  const serialized = result.bytes.toString();
  for (const secret of ["fixture-query-secret", "fixture-authorization-secret", "fixture-cookie-secret", "fixture-json-secret", "fixture-response-cookie", "fixture-response-secret"]) assert(!serialized.includes(secret), secret);
  assert.equal(result.mime_type, "application/json");
  assert.equal(result.filename, "dynamic-validation-20261003T000000Z.bruno.json");
  assert.equal(result.replayable_count, 1);
  const item = result.document.items[0];
  assert.match(item.request.url, /\/a%2Fb\?tag=one&tag=two&flag&q=a%20b&plus=a\+b&token=\{\{DYNVAL/);
  assert.equal(item.settings.encodeUrl, false);
  assert.equal(item.settings.followRedirects, false);
  assert.deepEqual(item.request.headers.map(header => header.name), ["Content-Type", "Authorization", "Cookie"]);
  assert.match(item.request.headers[1].value, /^Bearer \{\{/);
  assert.deepEqual(JSON.parse(item.request.body.json).values, [1, false]);
  for (const id of ["audit-fixture", "finding-fixture", "runtime-fixture", "artifact-fixture", "step-fixture", exchange.request.body.sha256]) assert(item.request.docs.includes(id));
  assert.equal(item.examples[0].response.status, 201);
  assert.equal(JSON.parse(item.examples[0].response.body.content).ok, true);
  assert.equal(item.examples[0].response.headers[1].value, "[REDACTED]");
  assert.equal(item.request.script.req, "");
  assert(result.document.environments[0].variables.filter(variable => variable.secret).every(variable => variable.value === ""));
});

test("JSON text redaction preserves exact numbers, duplicate keys, whitespace and unchanged string escapes", () => {
  const input = String.raw` { "id":9223372036854775807, "id":18446744073709551615, "n":-0, "decimal":1.230000000000000000001e-500, "plain":"\u4e2d\/x", "to\u006ben": {"nested": [false, 99999999999999999999]}, "message": "Bearer fixture-secret" } `;
  const output = redactJsonText(input, { sensitiveKey: key => key === "token", replaceSensitive: () => "[MASKED]", redactString: value => value.replace("Bearer fixture-secret", "Bearer [MASKED]") });
  const expected = input.replace('{"nested": [false, 99999999999999999999]}', '"[MASKED]"').replace("Bearer fixture-secret", "Bearer [MASKED]");
  assert.equal(output, expected);
  for (const value of ["null", " true ", "false", "-0", "1E+999999", '"\\uD800"', '[[],{},1,false,null,"x"]']) assert.equal(redactJsonText(value), value);
  const deeplyNested = "[".repeat(4000) + '{"token":{"nested":1},"id":9223372036854775807}' + "]".repeat(4000);
  assert.equal(redactJsonText(deeplyNested, { sensitiveKey: key => key === "token" }), deeplyNested.replace('{"nested":1}', '"[REDACTED]"'));
});

test("JSON text redaction validates the complete JSON grammar without accepting malformed payloads", () => {
  for (const value of ["", " ", "01", "1.", "1e", "1e+", "-.1", "+1", "Infinity", "NaN", "truefalse", "null x", '[1,]', '{"x":1,}', '{,}', '{"x" 1}', '{"x":}', '[}', '{"x":1]','"\\uZZZZ"', '"unterminated', '"line\nbreak"']) {
    assert.throws(() => redactJsonText(value), SyntaxError, value);
  }
});

test("Bruno request and historical response preserve 64-bit JSON identifiers and duplicate object keys", () => {
  const exchange = fixture();
  const request = String.raw`{ "id":9223372036854775807, "id":18446744073709551615, "scale":1.230000000000001e-500, "zero":-0, "label":"\u4e2d\/x", "secret":"request-fixture-secret" }`;
  const response = String.raw`{ "id":9223372036854775807, "id":18446744073709551615, "number":0.00000000000000000000000001, "token":{"private":"response-fixture-secret"} }`;
  exchange.request.body = body(request); exchange.response.body = body(response);
  const item = buildBrunoCollection([exchange], { generatedAt }).document.items[0];
  assert.equal(item.request.body.json, request.replace('"request-fixture-secret"', '"{{DYNVAL_001_SECRET}}"'));
  assert.equal(item.examples[0].request.body.json, item.request.body.json);
  assert.equal(item.examples[0].response.body.content, response.replace('{"private":"response-fixture-secret"}', '"[REDACTED]"'));
});

test("form, XML, text, empty body and URL basic credentials are correctly represented", () => {
  const form = fixture("http_form");
  form.request.body = body("tag=one&tag=two&password=fixture-form-secret&name=a+b", "application/x-www-form-urlencoded");
  form.request.headers = [{ name: "Content-Type", value: form.request.body.media_type }];
  form.request.url = "https://fixture-user:fixture-password@authorized.example.invalid/form";
  const xml = fixture("http_xml");
  xml.request.body = body('<root><password>fixture-xml-secret</password><marker>ok</marker></root>', "application/xml");
  xml.request.headers = [{ name: "Content-Type", value: "application/xml" }];
  const text = fixture("http_text");
  text.request.body = body('password="fixture-text-secret"\nmarker=ok', "text/plain");
  text.request.headers = [{ name: "Content-Type", value: "text/plain" }];
  const empty = fixture("http_empty");
  empty.request.body = body("", "text/plain");
  empty.request.headers = [];
  const result = buildBrunoCollection([form, xml, text, empty], { generatedAt });
  for (const secret of ["fixture-user", "fixture-password", "fixture-form-secret", "fixture-xml-secret", "fixture-text-secret"]) assert(!result.bytes.toString().includes(secret), secret);
  const formItem = result.document.items.find(item => item.request.body.mode === "formUrlEncoded");
  assert.deepEqual(formItem.request.body.formUrlEncoded.slice(0, 2).map(({ name, value }) => ({ name, value })), [{ name: "tag", value: "one" }, { name: "tag", value: "two" }]);
  assert.equal(formItem.request.body.formUrlEncoded.at(-1).value, "a b");
  assert.match(formItem.request.headers.at(-1).value, /^Basic \{\{/);
  assert.equal(result.replayable_count, 4);
});

test("missing, truncated, binary and multipart request bodies remain evidence only", () => {
  const cases = [null, body('{"partial":', "application/json", { truncated: true }), body("AA==", "application/octet-stream"), body("--boundary", "multipart/form-data; boundary=boundary")];
  const records = cases.map((value, index) => {
    const exchange = fixture(`http_gap-${index}`); exchange.request.body = value; exchange.request.headers = [];
    return exchange;
  });
  const result = buildBrunoCollection(records, { generatedAt });
  assert.equal(result.document.items.length, 0);
  assert.equal(result.skipped_count, 4);
  assert.equal(result.warnings.length, 4);
  assert(result.document.root.docs.includes("http_gap-0"));
  assert(result.document.root.docs.includes("历史证据"));
  assert(!result.bytes.toString().includes("fixture-response-secret"));
  const get = fixture("http_get"); get.request.method = "GET"; get.request.body = null; get.request.headers = [];
  assert.equal(buildBrunoCollection([get]).document.items[0].request.body.mode, "none");
});

test("records with incomplete responses keep actual status and captured limits", () => {
  const truncated = fixture(); truncated.response.body.truncated = true;
  assert.match(buildBrunoCollection([truncated]).document.items[0].request.docs, /历史响应正文已截断/);
  const failed = fixture(); failed.response = { status: null, status_text: "", headers: [], body: null, error: "timeout" };
  const item = buildBrunoCollection([failed]).document.items[0];
  assert.equal(item.examples[0].response.status, null);
  assert.equal(item.examples[0].response.body, null);
  assert.match(item.request.docs, /捕获错误：timeout/);
});

test("runtime missing-body signals are not exported as captured request or response content", () => {
  for (const state of [{ available: false }, { omitted: true }, { capture_status: "missing" }, {}]) {
    const exchange = fixture();
    exchange.request.body = body("<Request body not available anymore>", "application/json", state);
    exchange.response.body = body("<Response body not available anymore>", "application/json", state);
    const result = buildBrunoCollection([exchange], { generatedAt });
    assert.equal(result.replayable_count, 0);
    assert.equal(result.skipped_count, 1);
    assert.equal(result.document.items.length, 0);
    assert(!result.bytes.toString().includes("body not available anymore"));
    assert.match(result.document.root.docs, /请求正文未捕获或已无法读取/);
    assert.match(result.document.root.docs, /"response_body_available": false/);
    const responseOnly = fixture(); responseOnly.response.body = exchange.response.body;
    const item = buildBrunoCollection([responseOnly]).document.items[0];
    assert.equal(item.examples[0].response.body, null);
    assert.match(item.request.docs, /未捕获历史响应正文/);
  }
  for (const state of [{ available: false }, { omitted: true }, { capture_status: "missing" }]) {
    const exchange = fixture(); exchange.request.body = body("stale capture contents", "application/json", state);
    assert.equal(buildBrunoCollection([exchange]).replayable_count, 0);
  }
});

test("actual runtime adapter output retains sealed identity and does not turn missing-body sentinels into requests", () => {
  const { exchange, gaps } = runtimeNetworkExchange({
    content: { tool: "get_network_request", arguments: { reqid: 1 }, result: { structuredContent: { networkRequest: {
      requestId: 1, method: "POST", url: "https://authorized.example.invalid/submit", requestHeaders: { "Content-Type": "application/json" },
      requestBody: "<Request body not available anymore>", status: 200, responseHeaders: { "Content-Type": "application/json" }, responseBody: "<Response body not available anymore>",
    } } } },
    record: { recorded_at: generatedAt.toISOString() }, binding: { id: "packet.action-1", sha256: "a".repeat(64) },
    packet: { audit_id: "audit-fixture", finding_id: "finding-fixture", id: "packet-fixture", phase: "CONFIRM" }, repositoryId: "repository-fixture",
    authorization: { origins: ["https://authorized.example.invalid"] },
  });
  assert(exchange, gaps.join("; "));
  const result = buildBrunoCollection([exchange], { generatedAt });
  assert.equal(result.replayable_count, 0);
  assert.equal(result.document.items.length, 0);
  assert(!result.bytes.toString().includes("body not available anymore"));
  assert(result.document.root.docs.includes('"artifact_sha256": "' + "a".repeat(64) + '"'));
  assert(result.document.root.docs.includes('"packet_id": "packet-fixture"'));
  assert(result.document.root.docs.includes('"captured_response_body_sha256": null'));
});

test("conflicting identities, unsupported URLs, count and size limits fail explicitly", () => {
  const a = fixture(), b = fixture(); b.request.method = "DELETE";
  assert.throws(() => buildBrunoCollection([a, b]), { code: "bruno-export-id-conflict" });
  assert.equal(buildBrunoCollection([a, a]).exchange_count, 1);
  for (const url of ["file:///etc/passwd", "not-a-url"]) { const value = fixture(); value.request.url = url; assert.throws(() => buildBrunoCollection([value]), { code: "bruno-export-url-invalid" }); }
  assert.throws(() => buildBrunoCollection([]), { code: "bruno-export-count-invalid" });
  assert.throws(() => buildBrunoCollection(Array.from({ length: 101 }, (_, i) => fixture(`http_many-${i}`))), { code: "bruno-export-count-invalid" });
  const large = fixture(); large.response.body = body("a".repeat(33 * 1024 * 1024), "text/plain");
  assert.throws(() => buildBrunoCollection([large]), { code: "bruno-export-too-large" });
});

test("existing OpenCollection ZIP export remains available", () => {
  const result = buildOpenCollectionArchive([fixture()], { generatedAt });
  assert.equal(result.filename, "dynamic-validation-20261003T000000Z.zip");
  assert.equal(result.bytes[0], 0x50);
  assert.equal(result.bytes[1], 0x4b);
  const files = Object.fromEntries(Object.entries(unzipSync(result.bytes)).map(([name, value]) => [name, strFromU8(value)]));
  const request = parse(Object.entries(files).find(([name]) => name.includes("/requests/"))[1]);
  assert.equal(request.settings.followRedirects, false);
  assert.equal(request.settings.encodeUrl, false);
  assert.deepEqual(request.http.headers.map(header => header.name), ["Content-Type", "Authorization", "Cookie"]);
  assert.match(request.http.url, /q=a%20b&plus=a\+b/);
  for (const incomplete of [null, body("partial", "application/json", { truncated: true }), body("<Request body not available anymore>", "application/json", { available: false })]) {
    const exchange = fixture(); exchange.request.body = incomplete;
    assert.throws(() => buildOpenCollectionArchive([exchange]), { code: "bruno-export-body-incomplete" });
  }
});

test("official Bruno schema and actual BRU/YAML parsers accept exported collection", { skip: official ? false : "安装官方 @usebruno/schema、@usebruno/filestore 或设置 BRUNO_APP_ASAR 后运行导入验证" }, t => {
  t.diagnostic(official.source);
  const exchanges = [fixture()];
  const form = fixture("http_form"); form.request.body = body("tag=one&tag=two&password=fixture-form-secret", "application/x-www-form-urlencoded"); form.request.headers = [{ name: "Content-Type", value: form.request.body.media_type }]; exchanges.push(form);
  const empty = fixture("http_empty"); empty.request.method = "GET"; empty.request.body = null; empty.request.headers = []; exchanges.push(empty);
  const gap = fixture("http_gap"); gap.request.body.truncated = true; exchanges.push(gap);
  const precise = fixture("http_precise");
  precise.request.body = body('{ "id":9223372036854775807, "id":18446744073709551615, "n":-0, "small":1.23000001e-500, "token":"fixture-large-secret" }');
  precise.response.body = body('{ "id":9223372036854775807, "id":18446744073709551615, "token":"fixture-response-secret" }'); exchanges.push(precise);
  const result = buildBrunoCollection(exchanges, { generatedAt });
  official.schema.collectionSchema.validateSync(JSON.parse(result.bytes), { strict: true, abortEarly: false });
  for (const format of ["bru", "yml"]) {
    for (const item of result.document.items) {
      const text = official.filestore.stringifyRequest(structuredClone(item), { format });
      const parsed = official.filestore.parseRequest(text, { format });
      assert.equal(parsed.request.method, item.request.method);
      assert.equal(parsed.request.url, item.request.url);
      assert.equal(parsed.request.body.mode, item.request.body.mode);
      if (item.request.body.mode === "json") assert.equal(parsed.request.body.json, item.request.body.json);
      if (item.request.body.mode === "formUrlEncoded") assert.deepEqual(parsed.request.body.formUrlEncoded.map(({ name, value }) => ({ name, value })), item.request.body.formUrlEncoded.map(({ name, value }) => ({ name, value })));
      assert.equal(parsed.examples[0].response.status, item.examples[0].response.status);
      assert.equal(parsed.examples[0].response.body.content, item.examples[0].response.body.content);
      assert(parsed.request.docs.includes("artifact-fixture"));
    }
    const environment = official.filestore.stringifyEnvironment(structuredClone(result.document.environments[0]), { format });
    const parsed = official.filestore.parseEnvironment(environment, { format });
    assert(parsed.variables.some(variable => variable.name === "baseUrl" && variable.value === "https://authorized.example.invalid"));
  }
});
