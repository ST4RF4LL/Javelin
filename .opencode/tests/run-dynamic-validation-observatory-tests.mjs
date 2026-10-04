#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import {
  getValidationRun,
  listValidationRuns,
  sanitizeForWeb,
} from "../web/dynamic-validation-observatory/model.mjs";
import { createValidationObservatoryServer } from "../web/dynamic-validation-observatory/server.mjs";

const temp = await mkdtemp(join(tmpdir(), "dynamic-validation-observatory-"));
const runtimeRoot = join(temp, "runtime");
const auditRoot = join(runtimeRoot, "audit-001");
const evidenceRoot = join(auditRoot, "finding-001", "evidence");

try {
  await mkdir(evidenceRoot, { recursive: true });
  const exchangePath = join(evidenceRoot, "http-001.json");
  await writeFile(exchangePath, JSON.stringify({
    schema_version: 1,
    artifact_type: "SANITIZED_HTTP_EXCHANGE",
    exchange_id: "http-001",
    sequence: 1,
    phase: "APP_INPUT_SUBMISSION",
    started_at: "2026-08-08T14:32:06.000Z",
    duration_ms: 41,
    browser_context_id: "attacker-context",
    request: {
      method: "POST",
      url: "http://127.0.0.1:8080/api/profile",
      headers: [
        { name: "Content-Type", value: "application/json" },
        { name: "Authorization", value: "Bearer must-not-leak" },
      ],
      body: { media_type: "application/json", text: "{\"marker\":\"proof-001\"}", truncated: false },
    },
    response: {
      status: 200,
      status_text: "OK",
      headers: [{ name: "Set-Cookie", value: "session=must-not-leak" }],
      body: { media_type: "application/json", text: "{\"updated\":true}", truncated: false },
      error: null,
    },
  }), "utf8");

  await writeFile(join(auditRoot, "request.json"), JSON.stringify({
    source_binding: {
      repository_id: "fixture-repository",
      commit: "abcdef0123456789",
      primary_location: { file: "public/app.js", line_start: 42 },
    },
    static_assessment: { state: "SUPPORTED_STATIC" },
    claim: {
      vulnerability_type_id: "JW-INJECT-06",
      summary: "服务端数据未经编码进入 DOM。",
      expected_security_effect: "在测试浏览器上下文执行唯一标记。",
    },
  }), "utf8");
  await writeFile(join(auditRoot, "finding-001.target.json"), JSON.stringify({
    target: { base_url: "http://127.0.0.1:8080", allowed_origins: ["http://127.0.0.1:8080"] },
    authorization: { explicit_dynamic_validation_request: true },
    accounts: { attacker_role: "attacker", victim_role: "victim", distinct_test_accounts: true },
    binding_digest: "b".repeat(64),
  }), "utf8");
  await writeFile(join(auditRoot, "envelope-output.json"), JSON.stringify({
    agent_name: "dynamic-vulnerability-validator",
    agent_session_id: "session-001",
  }), "utf8");
  await writeFile(join(auditRoot, "finding-001.result.json"), JSON.stringify({
    audit_id: "audit-001",
    finding_id: "finding-001",
    recorded_at: "2026-08-08T14:33:00.000Z",
    outcome: "SUPPORTED_RUNTIME",
    validator: { project: "fixture", version: "1.0.0", session_id: "session-001" },
    browser_backend: { name: "chrome-devtools-mcp", resolved_version: "1.2.3", isolated: true, headless: false },
    xss_verification: {
      level: "STORED_CROSS_USER",
      proof_id: "proof-001",
      preferred_goal_met: true,
      attacker_context_id: "attacker-context",
      victim_context_id: "victim-context",
      cleanup: { status: "SUCCEEDED", attempted: true, still_executable: false, details: "已清理。" },
    },
    evidence_artifacts: [{
      artifact_id: "ev-http-001",
      path: exchangePath,
      sha256: "a".repeat(64),
      kind: "sanitized-http-exchange",
      media_type: "application/json",
      sanitized: true,
    }],
    observations: [{ observation_id: "o-1", claim: "标记执行。", outcome: "CONFIRMS", evidence_artifact_ids: [] }],
    residual_gaps: [],
    network_trace: {
      schema_version: 1,
      capture_source: "chrome-devtools-mcp",
      completeness: "KEY_EXCHANGES",
      sensitive_headers_redacted: true,
      exchanges: [{ exchange_id: "http-001", artifact_id: "ev-http-001", sequence: 1, phase: "APP_INPUT_SUBMISSION" }],
    },
  }), "utf8");

  const summaries = await listValidationRuns(runtimeRoot);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].exchange_count, 1);
  assert.equal(summaries[0].target_origin, "http://127.0.0.1:8080");

  const detail = await getValidationRun(runtimeRoot, "audit-001::finding-001");
  assert.equal(detail.environment.source_repository, "fixture-repository");
  assert.equal(detail.finding.verification_level, "STORED_CROSS_USER");
  assert.equal(detail.network.exchanges[0].schema_version, 2);
  assert.equal(detail.network.exchanges[0].artifact_type, "HTTP_EXCHANGE_V2");
  assert.equal(detail.network.exchanges[0].source, "chrome_devtools_mcp");
  assert.equal(detail.network.exchanges[0].evidence_binding.artifact_id, "ev-http-001");
  assert.equal(detail.network.exchanges[0].request.headers[1].value, "[REDACTED]");
  assert.equal(detail.network.exchanges[0].response.headers[0].value, "[REDACTED]");
  assert.equal(JSON.stringify(detail).includes("must-not-leak"), false);
  assert.equal(sanitizeForWeb({ password: "secret" }).password, "[REDACTED]");
  assert.equal(sanitizeForWeb('{"access_token":"must-not-leak"}').includes("must-not-leak"), false);

  const server = createValidationObservatoryServer({
    runtimeRoot,
    stateRoot: join(temp, "state"),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    const runsResponse = await fetch(`http://127.0.0.1:${address.port}/api/runs`);
    assert.equal(runsResponse.status, 200);
    assert.equal((await runsResponse.json()).count, 1);

    const detailResponse = await fetch(`http://127.0.0.1:${address.port}/api/runs/${encodeURIComponent("audit-001::finding-001")}`);
    assert.equal(detailResponse.status, 200);
    const detailBody = await detailResponse.text();
    assert.equal(detailBody.includes("must-not-leak"), false);

    const indexResponse = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(indexResponse.status, 200);
    const indexHtml = await indexResponse.text();
    assert.match(indexHtml, /DeepHole·JAVA/);
    assert.match(indexHtml, /发包记录/);
    assert.match(indexHtml, /人工发包请使用 Bruno/);
    assert.doesNotMatch(indexHtml, /HTTP 请求工作台/);
    assert.doesNotMatch(indexHtml, /发送请求/);

    const postResponse = await fetch(`http://127.0.0.1:${address.port}/api/runs`, { method: "POST" });
    assert.equal(postResponse.status, 405);

    const exchangeList = await fetch(`http://127.0.0.1:${address.port}/api/v1/http-exchanges`);
    assert.equal(exchangeList.status, 200);
    const exchangeHistory = await exchangeList.json();
    assert.equal(exchangeHistory.count, 1);
    assert.equal(exchangeHistory.items[0].source, "chrome_devtools_mcp");
    assert.equal(exchangeHistory.items[0].audit_id, "audit-001");
    assert.equal(exchangeHistory.items[0].repository_id, "workspace");
    assert.equal(JSON.stringify(exchangeHistory).includes("must-not-leak"), false);
    const recordedExchange = exchangeHistory.items[0];

    const exportResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/http-exchanges/export/bruno`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exchange_ids: [recordedExchange.exchange_id], format: "opencollection" }),
    });
    assert.equal(exportResponse.status, 200);
    assert.equal(exportResponse.headers.get("content-type"), "application/zip");
    assert.match(exportResponse.headers.get("content-disposition"), /dynamic-validation-.*\.zip/);
    const exportedFiles = unzipSync(new Uint8Array(await exportResponse.arrayBuffer()));
    assert(Object.keys(exportedFiles).some(path => path.endsWith("/opencollection.yml")));

    const jsonExport = await fetch(`http://127.0.0.1:${address.port}/api/v1/http-exchanges/export/bruno`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exchange_ids: [recordedExchange.exchange_id] }),
    });
    assert.equal(jsonExport.status, 200);
    assert.match(jsonExport.headers.get("content-type"), /application\/json/);
    assert.equal((await jsonExport.json()).version, "1");

    const harResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/http-exchanges/export/har`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exchange_ids: [recordedExchange.exchange_id] }),
    });
    assert.equal(harResponse.status, 200);
    assert.match(harResponse.headers.get("content-disposition"), /dynamic-validation-.*\.har/);
    const har = await harResponse.json();
    assert.equal(har.log.version, "1.2");
    assert.equal(JSON.stringify(har).includes("must-not-leak"), false);

    const missingExport = await fetch(`http://127.0.0.1:${address.port}/api/v1/http-exchanges/export/bruno`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exchange_ids: ["http_missing"] }),
    });
    assert.equal(missingExport.status, 404);

    const removedSessionApi = await fetch(`http://127.0.0.1:${address.port}/api/v1/request-sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(removedSessionApi.status, 405);
    const removedReplayApi = await fetch(`http://127.0.0.1:${address.port}/api/v1/http-exchanges/${recordedExchange.exchange_id}/replay`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(removedReplayApi.status, 405);
  } finally {
    server.close();
    await once(server, "close");
  }

  process.stdout.write(`${JSON.stringify({ complete: true, service: "dynamic-validation-observatory", cases: 36 })}\n`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
