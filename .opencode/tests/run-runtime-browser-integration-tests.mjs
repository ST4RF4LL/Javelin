#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { test } from "node:test";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PROTOCOL, selection, authorize } from "../lib/runtime-testing/contract.mjs";
import { RuntimeTestingService } from "../lib/runtime-testing/service.mjs";
import { verifyRuntimeEvidenceFiles } from "../lib/runtime-testing/evidence.mjs";

// Opt-in integration: the production Chrome DevTools MCP launch and origin gate,
// a host-only fixture created here, and no model calls or external audit targets.
test("真实 Chrome DevTools MCP：环境登记、重定向、HTTP 证据、CONTACT 提交及后续复用", {
  skip: process.env.RUNTIME_BROWSER_INTEGRATION !== "1", timeout: 120_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), "runtime-browser-integration-"));
  const requests = [];
  const target = http.createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    if (request.url === "/") { response.writeHead(302, { Location: "/baseline" }).end(); return; }
    if (request.url === "/navigation-failure") return;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>运行测试基线</title><h1>独立测试页面</h1><p>无账号、无持久写入。</p>");
  });
  await new Promise(resolve => target.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${target.address().port}`;
  const selected = selection({ runtime_testing: { protocol: PROTOCOL, mode: "INTEGRATED_TESTING", budget_minutes: 10,
    explicit_authorization: true, identity_mode: "anonymous", allowed_actions: ["navigate"] } });
  const authorization = authorize({ auditId: "audit-browser-integration", selected, enabled: true,
    context: `仅授权本测试创建的临时页面 ${origin}。匿名正常导航，不写入数据。`, scopeDigest: "a".repeat(64) });
  let pageId; let workerError;
  const service = new RuntimeTestingService({ root: join(root, "reports"), privateRoot: join(root, "state", "audit", "runtime-testing"),
    authorization: authorization.public, privateContext: authorization.private,
    worker: async ({ controller, active }) => {
      try {
        if (active.packet.phase === "CONTACT") await controller.configureEnvironment(active.token, {
          target_url: origin, origins: [origin], identities: [{ id: "anonymous", role: "anonymous" }], sensitive_values: [],
        });
        const tools = await controller.tools(active.token);
        assert.ok(tools.some(tool => tool.name === "new_page"));
        const records = [];
        const call = async (name, args) => {
          const record = await controller.call(active.token, name, { identity_id: "anonymous", ...args });
          records.push(record.evidence_id); return record;
        };
        if (active.packet.phase !== "CONTACT") {
          const failed = await call("navigate_page", { pageId, type: "url", url: `${origin}/navigation-failure`, timeout: 250 });
          assert.equal(failed.isError, true, "失败导航不能把仍在列表中的旧页面当作访问成功");
        }
        const visit = await call(active.packet.phase === "CONTACT" ? "new_page" : "navigate_page",
          { url: origin, ...(pageId ? { pageId, type: "url" } : {}) });
        assert.equal(visit.isError, false);
        const pages = visit.structured_result.structuredContent.pages;
        const page = pages.find(item => item.selected); assert.ok(page);
        assert.equal(page.url, `${origin}/baseline`); pageId = page.id;
        const listing = await call("list_network_requests", { pageId, resourceTypes: ["document"] });
        const requests = listing.structured_result.structuredContent.networkRequests;
        assert.ok(Array.isArray(requests) && requests.length > 0);
        const request = requests.find(item => item.url === `${origin}/baseline`); assert.ok(request);
        const response = await call("get_network_request", { pageId, reqid: request.requestId });
        assert.equal(response.isError, false);
        assert.ok(response.structured_result.structuredContent.networkRequest);
        const accepted = await controller.submit(active.token, { execution_status: "COMPLETED", outcome: "NOT_OBSERVED", cleanup_status: "NOT_REQUIRED",
          summary: "临时测试页面访问成功，完整请求响应已记录。", observations: ["重定向后到达授权页面。"],
          gaps: [], evidence_ids: records, changes: [] });
        assert.equal(accepted.accepted, true);
      } catch (error) { workerError = error; throw error; }
    } });
  try {
    await service.start(); await service.contact(); await service.draining;
    if (workerError) throw workerError;
    assert.equal(service.controller.state.status, "READY");
    assert.equal(service.controller.state.baseline_packet, "contact-1");
    const grant = service.controller.authorization;
    await service.enqueue({ protocol: PROTOCOL, audit_id: grant.audit_id, id: "explore-1", phase: "EXPLORE",
      authorization_digest: grant.artifact_digest, environment_revision: grant.environment_revision, identity_ids: ["anonymous"],
      budget_seconds: 120, actions: ["navigate"], hypothesis_id: "fixture-baseline", focus_area_id: "fixture", scope_digest: grant.scope_digest,
      vulnerability_type_id: "JW-ACCESS-01", question: "受控浏览器是否可以复用？", expected_behavior: "继续访问同一临时页面。",
      steps: ["检查正常导航。"], counterchecks: ["无响应页面必须判为导航失败，再确认正常页面仍可访问。"] });
    await service.draining;
    if (workerError) throw workerError;
    assert.equal(service.controller.state.status, "READY");
    assert.equal(service.controller.state.packets[1].execution_status, "COMPLETED");
    await service.shutdown();
    const evidence = await verifyRuntimeEvidenceFiles(join(root, "reports", "evidence-set.json"));
    assert.equal(evidence.status, "CLOSED"); assert.equal(evidence.cleanup_status, "NOT_REQUIRED");
    assert.equal(evidence.packets.length, 2);
    assert.equal(service.leases.length, 0);
    assert.ok(requests.length > 0 && requests.every(request => request.method === "GET"));
    t.diagnostic(JSON.stringify({ status: evidence.status, packets: evidence.packets.map(row => ({ id: row.id, status: row.execution_status })), evidence_count: evidence.evidence_bindings.length }));
  } finally {
    await service.shutdown(); target.closeAllConnections(); await new Promise(resolve => target.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
