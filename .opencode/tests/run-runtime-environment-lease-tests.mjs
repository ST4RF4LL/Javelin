import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EnvironmentLeaseStore, environmentLeaseId } from "../lib/runtime-testing/environment-leases.mjs";
import { RuntimeTestingService } from "../lib/runtime-testing/service.mjs";
import { authorize, selection } from "../lib/runtime-testing/contract.mjs";
import { verifyRuntimeEvidenceFiles } from "../lib/runtime-testing/evidence.mjs";

const origin = "http://127.0.0.1:8080";
const id = environmentLeaseId(origin);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "environment-lease-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EnvironmentLeaseStore({ stateRoot: join(root, "runs") });
  const auditId = "audit-old"; const runtimeRoot = join(root, "reports", "runtime-testing", auditId);
  const state = { browser_allocated: true, cleanup_status: "UNKNOWN", status: "QUARANTINED", reason: "runtime-packet-timed-out", active_packet: null };
  await mkdir(runtimeRoot, { recursive: true }); await mkdir(join(store.stateRoot, auditId), { recursive: true }); await mkdir(store.root, { recursive: true });
  const audit = { id: auditId, name: "旧任务", status: "interrupted", paths: { reports_root: join(root, "reports") } };
  const saveAudit = () => writeFile(join(store.stateRoot, auditId, "run.json"), JSON.stringify(audit));
  const saveState = () => writeFile(join(runtimeRoot, "state.json"), JSON.stringify(state));
  await saveAudit(); await saveState();
  await writeFile(join(runtimeRoot, "authorization.json"), JSON.stringify({ origins: [origin] }));
  await writeFile(store.path(id), JSON.stringify({ audit_id: auditId, owner: "private-legacy-owner", reason: "旧环境占用" }));
  return { root, store, auditId, runtimeRoot, audit, state, saveAudit, saveState };
}

test("旧格式未知清理保留占用并显示来源，不因时间经过而自动解除", async t => {
  const f = await fixture(t); const view = await f.store.inspect(id);
  assert.equal(view.audit_name, "旧任务"); assert.equal(view.origin, origin);
  assert.equal(view.can_release, true); assert.equal(view.can_auto_release, false);
  assert.equal(JSON.stringify(view).includes("private-legacy-owner"), false);
  await assert.rejects(f.store.acquire({ origins: [origin], auditId: "audit-new", runtimeRoot: f.root, owner: "new" }), e => e.code === "ENVIRONMENT_LEASE_REQUIRES_REVIEW" && e.environment_lease.audit_id === "audit-old");
  assert.equal((await f.store.list()).items.length, 1);
});

test("没有浏览器操作的旧锁自动回收，并记录来源而不改写旧任务", async t => {
  const f = await fixture(t); f.state.browser_allocated = false; await f.saveState();
  const before = await readFile(join(f.runtimeRoot, "state.json"), "utf8");
  const leases = await f.store.acquire({ origins: [origin], auditId: "audit-new", runtimeRoot: f.root, owner: "new" });
  assert.equal(leases.length, 1); assert.equal((await f.store.inspect(id)).audit_id, "audit-new");
  assert.equal((await f.store.list()).history[0].decision, "automatic");
  assert.equal(await readFile(join(f.runtimeRoot, "state.json"), "utf8"), before);
  await f.store.abandon(leases);
});

test("旧任务仍活动或环境仍由活进程持有时拒绝人工和自动解锁", async t => {
  const f = await fixture(t);
  for (const mode of ["audit", "process"]) {
    f.audit.status = mode === "audit" ? "running" : "cancelled"; await f.saveAudit();
    if (mode === "process") await writeFile(f.store.path(id), JSON.stringify({ audit_id: f.auditId, owner: "live", status: "active", pid: process.pid }));
    const view = await f.store.inspect(id); assert.equal(view.can_release, false);
    await assert.rejects(f.store.release(id, { revision: view.revision, reviewed: true, note: "不能释放活动任务" }), { code: "environment-lease-owner-active" });
    await assert.rejects(f.store.acquire({ origins: [origin], auditId: "audit-new", runtimeRoot: f.root, owner: "new" }), { code: "ENVIRONMENT_ALREADY_LEASED" });
  }
});

test("核对需说明和版本，解除保留 UNKNOWN 原始证据及复核记录", async t => {
  const f = await fixture(t); const view = await f.store.inspect(id);
  await assert.rejects(f.store.release(id, { revision: view.revision, note: "复核" }), { code: "environment-lease-review-required" });
  await assert.rejects(f.store.release(id, { revision: "stale", reviewed: true, note: "复核" }), { code: "environment-lease-changed" });
  await f.store.release(id, { revision: view.revision, reviewed: true, note: "复核旧任务并完成环境重置" });
  assert.equal(await f.store.inspect(id), null);
  const { history } = await f.store.list(); assert.equal(history[0].cleanup_status, "UNKNOWN"); assert.equal(history[0].decision, "manual_review");
  assert.equal(JSON.parse(await readFile(join(f.runtimeRoot, "state.json"), "utf8")).cleanup_status, "UNKNOWN");
});

test("两个请求并发申请及 loopback 别名只能有一个持有者", async t => {
  const f = await fixture(t); await rm(f.store.path(id));
  const attempts = await Promise.allSettled([origin, "http://localhost:8080"].map((url, i) => f.store.acquire({ origins: [url], auditId: `audit-new-${i}`, runtimeRoot: f.root, owner: randomUUID() })));
  assert.equal(attempts.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(attempts.find(x => x.status === "rejected").reason.code, "ENVIRONMENT_ALREADY_LEASED");
  await f.store.abandon(attempts.find(x => x.status === "fulfilled").value);
});

test("多目标申请失败只回滚本次取得的锁，迟到释放不能删除新持有者", async t => {
  const f = await fixture(t);
  const first = "http://127.0.0.1:8000";
  await assert.rejects(f.store.acquire({ origins: [first, origin], auditId: "audit-new", runtimeRoot: f.root, owner: "new" }), { code: "ENVIRONMENT_LEASE_REQUIRES_REVIEW" });
  assert.equal(await f.store.inspect(environmentLeaseId(first)), null); assert.equal((await f.store.inspect(id)).audit_id, f.auditId);
  const view = await f.store.inspect(id); await f.store.release(id, { revision: view.revision, reviewed: true, note: "复核完成" });
  const next = await f.store.acquire({ origins: [origin], auditId: "audit-next", runtimeRoot: f.root, owner: "next" });
  await f.store.abandon([{ id, owner: "private-legacy-owner" }]);
  assert.equal((await f.store.inspect(id)).audit_id, "audit-next"); await f.store.abandon(next);
});

test("关闭后无需清理会释放，未知清理改为待核对并去掉活动进程占用", async t => {
  const f = await fixture(t); await rm(f.store.path(id));
  for (const browser of [false, true]) {
    const leases = await f.store.acquire({ origins: [origin], auditId: f.auditId, runtimeRoot: f.runtimeRoot, owner: randomUUID() });
    await f.store.finish(leases, { ...f.state, browser_allocated: browser });
    const view = await f.store.inspect(id);
    if (!browser) assert.equal(view, null);
    else { assert.equal(view.status, "needs_review"); assert.equal(view.can_release, true); }
  }
});

test("跨进程更新锁阻止检查和删除交错，进程退出后锁可再次取得", async t => {
  const f = await fixture(t);
  const module = new URL("../lib/runtime-testing/environment-leases.mjs", import.meta.url).href;
  const code = `import { EnvironmentLeaseStore } from ${JSON.stringify(module)};const s=new EnvironmentLeaseStore({stateRoot:process.argv[1]});try{await s.exclusive(async()=>{});process.stdout.write('ok');}catch(e){process.stdout.write(e.code);}`;
  const run = () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, f.store.stateRoot]);
  await f.store.exclusive(async () => { assert.equal((await run()).stdout, "environment-lease-busy"); });
  assert.equal((await run()).stdout, "ok");
});

test("工作台 API 提供脱敏占用清单，拒绝跨站、旧版本及无核对说明的解除", async t => {
  const f = await fixture(t);
  await rm(join(f.store.stateRoot, f.auditId, "run.json"));
  const { createAuditWorkbenchServer } = await import("../web/dynamic-validation-observatory/server.mjs");
  const server = createAuditWorkbenchServer({ stateRoot: f.store.stateRoot, runtimeRoot: join(f.root, "runtime"), runnerEnabled: true });
  await server.auditRunner.ready; await server.productCatalogReady;
  await f.saveAudit();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = base + `/api/v1/runtime-environment-leases/${id}/release`;
  const post = (body, originHeader = base) => fetch(route, { method: "POST", headers: { "Content-Type": "application/json", Origin: originHeader }, body: JSON.stringify(body) });
  try {
    const data = await (await fetch(base + "/api/v1/runtime-environment-leases")).json();
    assert.equal(data.items[0].audit_id, f.auditId); assert.equal(JSON.stringify(data).includes("private-legacy-owner"), false);
    const body = { revision: data.items[0].revision, reviewed: true, note: "复核历史只读操作，允许新任务使用环境" };
    assert.equal((await post(body, "https://unrelated.invalid")).status, 403);
    assert.equal((await post({ ...body, reviewed: false })).status, 422);
    assert.equal((await post({ ...body, revision: "stale" })).status, 412);
    assert.equal((await post(body)).status, 200);
    const after = await (await fetch(base + "/api/v1/runtime-environment-leases")).json();
    assert.equal(after.items.length, 0); assert.equal(after.history[0].note, body.note);
    assert.equal(server.auditRunner.health().active_processes, 0);
  } finally { await server.shutdownRunners(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("环境占用在 CONTACT 记为 BLOCKED，复核释放后新任务能完成基线", async t => {
  const f = await fixture(t); let browsers = 0; let requests = 0;
  const selected = selection({ runtime_testing: { protocol: "runtime-testing.v1", mode: "INTEGRATED_TESTING", budget_minutes: 60, explicit_authorization: true, identity_mode: "anonymous", allowed_actions: ["navigate"] } });
  const make = auditId => {
    const auth = authorize({ auditId, selected, enabled: true, context: "授权测试环境 " + origin, scopeDigest: "a".repeat(64) });
    return new RuntimeTestingService({ root: join(f.root, auditId), privateRoot: join(f.store.stateRoot, auditId, "runtime-testing"), authorization: auth.public, privateContext: auth.private,
      browserFactory: async () => { browsers++; return { tools: async () => [], close: async () => {}, call: async () => { requests++; return { structuredContent: { pages: [{ id: 1, url: origin, selected: true }] } }; } }; },
      worker: async ({ controller, active }) => {
        await controller.configureEnvironment(active.token, { target_url: origin, origins: [origin], identities: [{ id: "anonymous", role: "anonymous" }], sensitive_values: [] });
        const evidence = await controller.call(active.token, "navigate_page", { identity_id: "anonymous", url: origin, pageId: 1 });
        await controller.submit(active.token, { execution_status: "COMPLETED", outcome: "NOT_OBSERVED", cleanup_status: "NOT_REQUIRED", summary: "基线检查完成", observations: [], evidence_ids: [evidence.evidence_id], changes: [], gaps: [] });
      } });
  };
  const blocked = make("audit-blocked");
  try {
    await blocked.start(); await blocked.contact(); await blocked.draining;
    assert.equal(blocked.controller.state.status, "BLOCKED", blocked.controller.state.reason); assert.equal(blocked.controller.state.stages.CONTACT, "BLOCKED");
    assert.equal(blocked.controller.state.environment_lease.audit_id, f.auditId); assert.equal(browsers, 0); assert.equal(requests, 0);
    await verifyRuntimeEvidenceFiles(join(f.root, "audit-blocked", "evidence-set.json"));
  } finally { await blocked.shutdown(); }
  const view = await f.store.inspect(id); await f.store.release(id, { revision: view.revision, reviewed: true, note: "受控测试：复核完成" });
  const next = make("audit-success");
  try { await next.start(); await next.contact(); await next.draining; assert.equal(next.controller.state.status, "READY"); assert.equal(requests, 1); }
  finally { await next.shutdown(); }
  assert.equal(await f.store.inspect(id), null);
});
