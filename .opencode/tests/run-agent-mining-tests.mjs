import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PROFILE, PROTOCOL, FAMILIES, SURFACES, selection } from "../lib/agent-mining/profile.mjs";
import { inventory, hash, LIMITS } from "../lib/agent-mining/inventory.mjs";
import { prepareMining, analyzeMining, finishMining } from "../lib/agent-mining/service.mjs";
import { normalizeTask, atomicJson } from "../lib/task-board/contract.mjs";
import { createBoard } from "../lib/task-board/store.mjs";
import { TaskBoardService } from "../lib/task-board/service.mjs";

const execute = promisify(execFile), scope = "a".repeat(64), projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const sample = `// Static fixture: it is never imported or executed.\napp.post('/run', dispatch);\nfunction dispatch(request) { return tools[request.tool].execute(request.arguments); }\nfunction shellTool(args) { return exec(args.command); }\nconst policy = { role: 'viewer', allowed_tools: ['read'] };\nconst skills = { command: 'direct-tool-dispatch' };\nconst mcp = new McpServer();\nfunction secureDispatch(request) { if (!authorize(request.user, request.tool)) throw Error('deny'); return tools[request.tool].execute(request.arguments); }\n`;
async function fixture(t, config = { profile: PROFILE }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-mining-"))), source = join(root, "source"), output = join(root, "output");
  await mkdir(source); await writeFile(join(source, "agent.js"), sample);
  t.after(() => rm(root, { recursive: true, force: true }));
  let queries = 0;
  const prepared = await prepareMining({ sourceRoot: source, outputRoot: output, auditId: "audit-fixture", taskId: "agent-boundary", attemptId: "attempt-1", scopeDigest: scope, config,
    knowledgeQuery: async request => { queries++; return { status: "PARTIAL", read_only: true, automatic_vulnerability_verdict: false, warnings: ["案例跨项目效果未评估。"],
      document: { id: request.id, title: "测试案例", source: { path: "cases/fixture.yaml", sha256: "b".repeat(64) }, quality: { status: "draft", validation: "report_only" }, facets: { status: ["draft"] } } }; } });
  const plan = JSON.parse(await readFile(prepared.plan_path)), analysis = JSON.parse(await readFile(prepared.analysis_path));
  const session = { protocol: "task-board.v1", audit_id: plan.audit_id, task_id: plan.task_id, attempt_id: plan.attempt_id, agent_session_id: "session-fixture" };
  const ref = line => ({ path: "agent.js", line, sha256: hash(sample) });
  analysis.agent_session_id = session.agent_session_id;
  analysis.coverage = plan.matrix.map(row => ({ ...row, status: "INSPECTED", reason: "已核对当前任务的分派路径及执行侧策略。", evidence: [ref(3)] }));
  const statement = (reason = "源码显示该分支未实施既有工具权限限制。", line = 3) => ({ reason, evidence: [ref(line)] });
  const claim = (family = "TOOL_AUTHZ", surface = "function_call") => ({ claim_id: `claim-${family}-${surface}`, family, surface,
    title: "工具直调绕过任务权限边界", description: "普通调用者可通过此分派进入权限列表之外的执行分支。", caller: "普通已登录用户，控制工具名称与参数。",
    execution_identity: "服务进程身份。", operation: "执行工具操作。", execution_context: "HOST", severity: "HIGH",
    expected_policy: statement("查看者只能调用读取工具。", 5),
    chain: [{ id: "entry", stage: "entry", ...statement("请求进入接口。", 2) }, { id: "dispatch", stage: "dispatch", ...statement() }, { id: "sink", stage: "execution", ...statement("执行参数进入命令解释器。", 4) }],
    edges: [{ from: "entry", to: "dispatch", ...statement("注册的接口直接调用分派函数。", 2) }, { from: "dispatch", to: "sink", ...statement("工具注册表解析到执行函数。", 3) }],
    facts: Object.fromEntries(FAMILIES[family].facts.map(name => [name, { status: "SUPPORTED", ...statement() }])),
    controls: [{ name: "工具权限检查", status: "BYPASSED", ...statement() }],
    counterchecks: Object.fromEntries(FAMILIES[family].counterchecks.map(name => [name, { status: "DOES_NOT_REFUTE", ...statement("安全分派函数没有覆盖当前入口。", 8) }])),
    impact: "可在超出普通用户授权的范围内执行敏感操作。", remediation: "在每个实际执行点检查最终工具、参数、主体与资源。", knowledge_refs: [] });
  return { root, source, output, prepared, plan, analysis, session, ref, claim, queries,
    analyze: () => analyzeMining({ plan, analysis, session, sourceRoot: source }) };
}

for (const family of Object.keys(FAMILIES)) for (const surface of SURFACES) test(`静态证据链支持 ${family}/${surface}，不调用目标也不确认漏洞`, async t => {
  const f = await fixture(t); f.analysis.claims.push(f.claim(family, surface));
  const report = await f.analyze();
  assert.equal(report.findings.length, 1); assert.equal(report.findings[0].state, "CANDIDATE");
  assert.equal(report.findings[0].execution_status, "NOT_RUN"); assert.equal(report.findings[0].verdict, "NOT_ASSESSED");
  assert.equal(report.runtime_requests, undefined); assert.equal(report.agent_mining.validation, "DEFERRED");
  assert.equal(await readFile(join(f.source, "agent.js"), "utf8"), sample);
});

test("定位器只输出线索；无分析不会因 exec、skill 或 MCP 命中而自动报告漏洞", async t => {
  const f = await fixture(t), report = await f.analyze();
  assert.ok(f.plan.inventory.cues.some(row => row.tags.includes("execution")));
  for (const surface of SURFACES) assert.ok(f.plan.inventory.cues.some(row => row.tags.includes(surface)));
  assert.equal(report.findings.length, 0); assert.equal(report.agent_mining.coverage.length, 12);
  assert.equal(f.plan.inventory.automatic_vulnerability_verdict, false);
});

test("已生效安全控制反证和未知外层授权均保留为线索", async t => {
  const f = await fixture(t);
  const unknown = f.claim(); unknown.facts.authority_violation = { status: "UNKNOWN", reason: "尚未确定外层中间件是否执行授权。", evidence: [] };
  const safe = f.claim("FRAMEWORK_ACCESS", "api_call"); safe.counterchecks.outer_authorization.status = "REFUTES";
  const sandbox = f.claim("TOOL_RCE", "mcp"); sandbox.execution_context = "UNKNOWN";
  f.analysis.claims = [unknown, safe, sandbox]; const result = await f.analyze();
  assert.equal(result.findings.length, 0); assert.equal(result.agent_mining.leads.length, 3);
  assert.ok(result.gaps.some(gap => gap.includes("必要事实")));
});

test("拒绝缺少策略、断裂调用边、伪造源码行和其他任务会话", async t => {
  const f = await fixture(t), valid = f.claim();
  for (const mutate of [c => { delete c.expected_policy; }, c => { c.edges[0].to = "sink"; }, c => { c.chain[0].evidence[0].line = 999; }, c => { c.chain[0].evidence[0].sha256 = "c".repeat(64); }, c => { delete c.counterchecks.execution_side_policy; }, c => { c.controls[0].evidence = []; }]) {
    const claim = structuredClone(valid); mutate(claim); f.analysis.claims = [claim]; await assert.rejects(f.analyze());
  }
  f.analysis.claims = [valid]; f.session.attempt_id = "other"; await assert.rejects(f.analyze(), /会话/);
});

test("覆盖矩阵不得遗漏、重复、无证据关闭或与候选冲突", async t => {
  const f = await fixture(t), original = structuredClone(f.analysis.coverage);
  f.analysis.coverage.pop(); await assert.rejects(f.analyze(), /覆盖矩阵/);
  f.analysis.coverage = structuredClone(original); f.analysis.coverage[1] = f.analysis.coverage[0]; await assert.rejects(f.analyze(), /重复/);
  f.analysis.coverage = structuredClone(original); f.analysis.coverage[0].evidence = []; await assert.rejects(f.analyze(), /证据/);
  f.analysis.coverage = structuredClone(original); f.analysis.claims = [f.claim()];
  f.analysis.coverage.find(row => row.family === "TOOL_AUTHZ" && row.surface === "function_call").status = "NOT_APPLICABLE";
  await assert.rejects(f.analyze(), /矛盾/);
});

test("知识草稿和 PARTIAL 警告保留；不存在或摘要不同的案例不能充当引用", async t => {
  const f = await fixture(t); assert.equal(f.queries, 3);
  assert.equal(f.plan.knowledge[0].reference.quality.validation, "report_only");
  f.analysis.claims = [f.claim()]; f.analysis.claims[0].knowledge_refs = [{ id: "invented-case", sha256: "b".repeat(64) }];
  await assert.rejects(f.analyze(), /知识引用/);
  f.analysis.claims[0].knowledge_refs = [{ id: f.plan.knowledge[0].reference.id, sha256: "b".repeat(64) }];
  assert.equal((await f.analyze()).agent_mining.knowledge[0].reference.quality.status, "draft");
});

test("盲测在检索前隔离，无案例 ID 泄露；库不可用也能准备静态任务", async t => {
  const f = await fixture(t, { profile: PROFILE, track: "blind" });
  assert.equal(f.queries, 0); assert.deepEqual(f.plan.knowledge, []); assert.ok(!JSON.stringify(f.plan).includes("CVE-"));
  f.analysis.claims = [f.claim()]; f.analysis.claims[0].knowledge_refs = [{ id: "CVE-2026-53845", sha256: "b".repeat(64) }];
  await assert.rejects(f.analyze(), /盲测隔离/);
  const unavailable = await prepareMining({ sourceRoot: f.source, outputRoot: join(f.root, "missing-kb"), auditId: "audit-1", taskId: "task-1", attemptId: "attempt-1", scopeDigest: scope,
    knowledgeQuery: async () => ({ status: "UNAVAILABLE", reason: "测试库缺失。" }) });
  const plan = JSON.parse(await readFile(unavailable.plan_path)); assert.ok(plan.inventory.files.length); assert.ok(plan.knowledge.every(row => row.reference === null));
});

test("摘要漂移、证据路径越界及源目录写入被拒绝", async t => {
  const f = await fixture(t); f.analysis.claims = [f.claim()];
  f.analysis.claims[0].chain[0].evidence[0].path = "../outside.js"; await assert.rejects(f.analyze(), /证据/);
  f.analysis.claims = [];
  await writeFile(join(f.source, "agent.js"), sample + "// changed\n"); await assert.rejects(f.analyze(), /源码摘要/);
  await assert.rejects(prepareMining({ sourceRoot: f.source, outputRoot: join(f.source, "generated"), auditId: "audit", taskId: "task", attemptId: "attempt", scopeDigest: scope, config: { profile: PROFILE, track: "blind" } }), /只读源码/);
  await symlink(f.source, join(f.root, "alias"));
  await assert.rejects(prepareMining({ sourceRoot: f.source, outputRoot: join(f.root, "alias/generated"), auditId: "audit", taskId: "task", attemptId: "attempt", scopeDigest: scope, config: { profile: PROFILE, track: "blind" } }), /只读源码/);
});

test("符号链接、文件大小和数量限制显式记录且不跟随外部源码", async t => {
  const f = await fixture(t); await writeFile(join(f.root, "outside.js"), "exec(untrusted)");
  await symlink(join(f.root, "outside.js"), join(f.source, "linked.js"));
  await writeFile(join(f.source, "large.js"), "x".repeat(LIMITS.file_bytes + 1));
  const result = await inventory(f.source);
  assert.equal(result.files.length, 1); assert.ok(result.skipped.some(row => row.reason === "SYMLINK")); assert.ok(result.skipped.some(row => row.reason === "FILE_SIZE_LIMIT"));
  const limited = await inventory(f.source, { ...LIMITS, files: 1 }); assert.ok(limited.skipped.some(row => row.reason === "INVENTORY_LIMIT"));
});

test("finish 一次生成报告与回执，拒绝被替换的知识快照", async t => {
  const f = await fixture(t); f.analysis.claims = [f.claim()];
  const sessionPath = join(f.output, "session.json"); await atomicJson(sessionPath, f.session); await atomicJson(f.prepared.analysis_path, f.analysis);
  const args = { planPath: f.prepared.plan_path, analysisPath: f.prepared.analysis_path, sessionPath };
  const result = await finishMining(args); assert.equal(result.findings, 1);
  const receipt = JSON.parse(await readFile(result.receipt_path)); assert.equal(receipt.outcome, "REPORTED"); assert.equal(receipt.attempt_id, "attempt-1");
  await writeFile(join(f.output, f.plan.knowledge[0].path), "{}"); await assert.rejects(finishMining(args), /知识查询快照/);
});

test("CLI 以只读静态数据完成 prepare/finish，非法参数失败", async t => {
  const f = await fixture(t), cli = join(projectRoot, ".opencode/scripts/agent-mining.mjs"), output = join(f.root, "cli");
  const run = await execute(process.execPath, [cli, "prepare", "--source-root", f.source, "--output-root", output, "--audit", "audit-fixture", "--task", "agent-boundary", "--attempt", "attempt-1", "--scope-digest", scope, "--track", "blind"]);
  const prepared = JSON.parse(run.stdout), analysis = JSON.parse(await readFile(prepared.analysis_path)); analysis.agent_session_id = f.session.agent_session_id;
  await atomicJson(prepared.analysis_path, analysis); await atomicJson(join(output, "session.json"), f.session);
  const finished = await execute(process.execPath, [cli, "finish", "--plan", prepared.plan_path, "--analysis", prepared.analysis_path, "--session", join(output, "session.json")]);
  assert.equal(JSON.parse(finished.stdout).findings, 0);
  await assert.rejects(execute(process.execPath, [cli, "prepare", "--exec", "unexpected"]));
});

test("发布保留配置与风险族；非法域和未来验证开关拒绝混入", () => {
  const task = { task_id: "agent", kind: "focus_area", domain: "ai", title: "工具边界", prompt: "检查工具执行路径。", source_ref: "threat:agent", agent_mining: { profile: PROFILE, families: ["TOOL_AUTHZ"] } };
  assert.deepEqual(normalizeTask(task, { scope_digest: scope }).agent_mining.families, ["TOOL_AUTHZ"]);
  assert.throws(() => normalizeTask({ ...task, domain: "web" }, {}), /ai 领域/);
  assert.throws(() => selection({ profile: PROFILE, dynamic: true }), /无效/);
});

test("原生任务执行器注入挖掘计划并接收静态报告，未启用的任务不改变", async t => {
  const f = await fixture(t), boardPath = join(f.root, "board.json"), reportsRoot = join(f.root, "reports");
  await createBoard({ path: boardPath, auditId: "audit-fixture", scopeDigest: scope, miningStrategy: "focus_area" });
  let sawPlan = false;
  const service = new TaskBoardService({ path: boardPath, reportsRoot, privateRoot: join(f.root, "service"), workspaceRoot: projectRoot, sourceRoot: f.source,
    auditId: "audit-fixture", scopeDigest: scope, environment: { AUDIT_KNOWLEDGE_ENABLED: "false" },
    worker: async ({ input }) => {
      if (input.task.agent_mining) {
        sawPlan = true; assert.equal(input.agent_mining_gap, undefined);
        const analysis = JSON.parse(await readFile(input.agent_mining.analysis_path)); analysis.agent_session_id = "session-fixture";
        await atomicJson(input.session_path, { ...f.session, attempt_id: input.attempt_id }); await atomicJson(input.agent_mining.analysis_path, analysis);
        await finishMining({ planPath: input.agent_mining.plan_path, analysisPath: input.agent_mining.analysis_path, sessionPath: input.session_path });
      } else {
        assert.equal(input.agent_mining, undefined);
        await atomicJson(input.report_path, { summary: "普通静态分析。", findings: [], gaps: [] });
        await atomicJson(input.receipt_path, { protocol: "task-board.v1", audit_id: "audit-fixture", task_id: input.task.task_id, attempt_id: input.attempt_id, outcome: "REPORTED", report_path: "report.json" });
      }
      return { session_id: "session-fixture" };
    } });
  await service.store.open(); t.after(() => service.store.close());
  for (const [name, config] of [["agent-boundary", { profile: PROFILE }], ["ordinary", null]]) {
    await service.store.publish({ tasks: [{ task_id: name, kind: "focus_area", domain: "ai", title: "工具边界", prompt: "检查工具执行路径。", source_ref: "threat:agent", ...(config ? { agent_mining: config } : {}) }] });
    const job = await service.store.claim("ai", 10_000); await service.execute({ job, controller: new AbortController() });
  }
  assert.equal(sawPlan, true); assert.equal(service.store.summary().reported, 2);
  assert.equal(service.store.summary().validation.status, "NOT_STARTED");
});
