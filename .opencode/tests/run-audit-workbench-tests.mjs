#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { execFile, execFileSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AuditRunner as CurrentAuditRunner } from "../web/dynamic-validation-observatory/audit-runner.mjs";
import { DynamicValidationRunner, validateAuthorization } from "../web/dynamic-validation-observatory/validation-runner.mjs";
import { EnvironmentHealthService } from "../web/dynamic-validation-observatory/environment-health.mjs";
import { OpenCodeTmuxMonitor } from "../web/dynamic-validation-observatory/tmux-monitor.mjs";
import { openCodeEventView } from "../web/dynamic-validation-observatory/opencode-event-view.mjs";
import { FindingWorkflowStore } from "../web/dynamic-validation-observatory/finding-workflow.mjs";
import { auditsFromArtifacts, buildWorkspaceSnapshot, findingsFromArtifacts, materializeFinalReportFromModel } from "../web/dynamic-validation-observatory/workspace-model.mjs";
import { createAuditWorkbenchServer, paginateFindings, parseArgs } from "../web/dynamic-validation-observatory/server.mjs";
import { finalReportModelDigest, renderFinalReport } from "../skills/common-subagent/audit-coverage-accounting/scripts/final-report-model-core.mjs";
import { buildWebXssInputEnvelope, buildWebXssRuntimeRequest } from "./fixtures/web-xss-runtime-fixture.mjs";

// Keep the existing workflow regression fixtures pinned to their version.
// task-board.v1 creation, dispatch and finalization have their own tests.
class AuditRunner extends CurrentAuditRunner {
  createAudit(input, key) { return super.createAudit({ task_protocol: "local-todo.v1", ...input }, key); }
  createAuditFromTarget(input, key) { return super.createAuditFromTarget({ task_protocol: "local-todo.v1", ...input }, key); }
}

const OPENCODE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

const toolEventView = openCodeEventView({
  occurred_at: "2026-09-01T00:00:00.000Z",
  source: "stdout",
  message: JSON.stringify({
    type: "tool_use",
    sessionID: "ses_event_view",
    part: { tool: "bash", callID: "call_1", state: { status: "completed", input: { command: "pwd" }, output: "/tmp/project" } },
  }),
});
assert.equal(toolEventView.kind, "tool");
assert.equal(toolEventView.tool, "bash");
assert.equal(toolEventView.status, "completed");
assert.match(toolEventView.detail, /"command": "pwd"/);
assert.equal(toolEventView.body, "/tmp/project");
assert.equal(toolEventView.session_id, "ses_event_view");

const nestedToolOutput = openCodeEventView({
  source: "stdout",
  message: JSON.stringify({ type: "tool_use", part: { tool: "bash", state: { status: "completed", output: JSON.stringify({ output: "clean terminal output", metadata: { exit: 0 } }) } } }),
});
assert.equal(nestedToolOutput.body, "clean terminal output");

const stepEventView = openCodeEventView({
  occurred_at: "2026-09-01T00:00:01.000Z",
  source: "stdout",
  message: JSON.stringify({ type: "step_finish", part: { reason: "stop", tokens: { total: 12, output: 3 }, cost: 0.0001 } }),
});
assert.equal(stepEventView.kind, "step");
assert.match(stepEventView.body, /总计 12/);
assert.match(stepEventView.body, /费用 \$0\.000100/);

const todoCompleteBeforeCorrelation = auditsFromArtifacts([
  { audit_id: "audit-stage-consistency", kind: "coverage", path: "coverage/coverage-plan.audit-stage-consistency.json", modified_at: "2026-09-01T00:00:00.000Z" },
  { audit_id: "audit-stage-consistency", kind: "vulnerability-mining", path: "vulnerability-mining/result.json", modified_at: "2026-09-01T00:00:01.000Z" },
], [], [{
  id: "audit-stage-consistency",
  status: "running",
  stage_delivery_enforcement: "TODO_ENFORCED",
  todo: { total: 4, done: 4, pending: 0, running: 0, failed: 0, progress: 100, complete: true },
}])[0];
assert.equal(todoCompleteBeforeCorrelation.stage, "证据关联");
assert.equal(todoCompleteBeforeCorrelation.stages.find(stage => stage.state === "active")?.label, "证据关联");

const findingPaginationFixture = Array.from({ length: 121 }, (_, index) => ({ id: `F-${String(index + 1).padStart(3, "0")}`, title: `Finding ${index + 1}` }));
const findingSecondPage = paginateFindings(findingPaginationFixture, new URL("http://127.0.0.1/api/v1/findings?page=2"));
assert.equal(findingSecondPage.items.length, 50);
assert.equal(findingSecondPage.items[0].id, "F-051");
assert.equal(findingSecondPage.count, 121);
assert.equal(findingSecondPage.page_size, 50);
assert.equal(findingSecondPage.total_pages, 3);

const anonymousAuthorization = validateAuthorization({
  target_base_url: "http://127.0.0.1:8080/path",
  explicit_authorization: true,
  test_environment: true,
});
assert.equal(anonymousAuthorization.accountMode, "anonymous");
assert.equal(anonymousAuthorization.attacker, null);
assert.equal(anonymousAuthorization.victim, null);
assert.equal(anonymousAuthorization.loginInstructions, "");
assert.equal(anonymousAuthorization.cleanupInstructions, "");
const sharedAuthorization = validateAuthorization({
  target_base_url: "http://localhost:3000",
  attacker_account: { username: "shared-user", password: "shared-password" },
  victim_account: { username: "shared-user", password: "shared-password" },
  explicit_authorization: true,
  test_environment: true,
});
assert.equal(sharedAuthorization.accountMode, "shared");
assert.equal(sharedAuthorization.attacker.username, "shared-user");
assert.equal(sharedAuthorization.victim.username, "shared-user");
const oneAccountAuthorization = validateAuthorization({
  target_base_url: "http://[::1]:8080",
  victim_account: { username: "only-user", password: "only-password" },
  explicit_authorization: true,
  test_environment: true,
});
assert.equal(oneAccountAuthorization.accountMode, "shared");
assert.equal(oneAccountAuthorization.attacker.username, "only-user");
assert.equal(oneAccountAuthorization.victim.username, "only-user");

class FakeChild extends EventEmitter {
  constructor({ closeOnTerminate = true } = {}) {
    super();
    this.pid = 4242;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.signals = [];
    this.closeOnTerminate = closeOnTerminate;
  }

  kill(signal) {
    this.signals.push(signal);
    if (signal === "SIGTERM" && this.closeOnTerminate) queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}

class FakeTerminalMonitor {
  constructor() {
    this.signals = [];
    this.abortCalls = [];
    this.stopCalls = 0;
    this.starts = [];
    this.resizeCalls = [];
    this.output = "OpenCode TUI fixture\nsecurity-audit-orchestrator is running";
  }

  async probe() {
    return { available: true, tmux_version: "tmux 3.test", message: "ready" };
  }

  async start({ audit, repository, environment, executionDirectory, providerSessionId = null, args }) {
    this.starts.push({ audit_id: audit.id, repository, environment, executionDirectory, providerSessionId, args });
    return {
      backend: "tmux",
      transport: "opencode-run+terminal-multiplexer",
      supported: true,
      status: "ready",
      live: true,
      socket_name: "owa-0123456789abcdef",
      target: "audit:tui",
      provider_session_id: providerSessionId ?? `ses_${audit.id}`,
      relay_spec_path: join(temp, `${audit.id}-terminal-output-relay.json`),
      attach_command: "tmux -L owa-0123456789abcdef attach-session -r -t audit:tui",
      message: "fixture terminal ready",
    };
  }

  async capture() {
    return this.output;
  }

  async targetLive() {
    return true;
  }

  async resize(terminal, columns, rows) {
    this.resizeCalls.push({ terminal, columns, rows });
    return { columns, rows };
  }

  async signalRun(_terminal, signal) {
    this.signals.push(signal);
  }

  async abort(terminal, directory) {
    this.abortCalls.push({ terminal, directory });
    return true;
  }

  async stop() {
    this.stopCalls += 1;
  }
}

const temp = await mkdtemp(join(tmpdir(), "audit-workbench-"));
const repositoryRoot = join(temp, "repository");
const operatorSelectedRoot = join(temp, "operator-selected-project");
const platformRoot = join(temp, "platform");
const reportsRoot = join(platformRoot, "reports", "repositories", "fixture");
const stateRoot = join(platformRoot, "reports", "platform", "audit-runs");
const runtimeRoot = join(reportsRoot, "validation-handoff", "runtime");
const globalModelConfig = join(temp, "opencode-global.jsonc");

function finalReportModel(auditId) {
  const model = {
    schema_version: 1,
    audit_id: auditId,
    scope_digest: "a".repeat(64),
    report_kind: "FINAL",
    coverage: {
      summary_digest: "b".repeat(64),
      coverage_status: "COMPLETE",
      seal_state: "FINALIZED_COMPLETE",
      policy_mode: "assurance",
      policy_satisfied: true,
      metrics: [],
    },
    inputs: {
      coverage_summary: "reports/coverage/summary.json",
      adjudication_input: "reports/adjudication/input.json",
      adjudication: "reports/adjudication/decision.json",
      truth_validation_intake: "reports/validation/intake.json",
      quick_dynamic_results: "reports/validation/quick.json",
      affirmative_review: "reports/validation/affirmative.json",
      negative_review: "reports/validation/negative.json",
      moderator_review: "reports/validation/moderator.json",
      validation_routing: "reports/validation/routing.json",
      cvss_assessment: "reports/adjudication/cvss.json",
      attack_chains: "reports/attack-chains/chains.json",
    },
    truth_validation: {
      routing_digest: "c".repeat(64),
      full_dynamic_trigger: "MANUAL_ONLY",
      summary: { total: 0, true_positive: 0, false_positive: 0, inconclusive: 0 },
      source: {
        artifact: "reports/validation/routing.json",
        digest: "c".repeat(64),
        json_pointer: "/summary",
      },
    },
    findings: [],
    excluded_findings: [],
    chains: [],
    rejected_chains: [],
  };
  model.manifest_digest = finalReportModelDigest(model);
  return model;
}

try {
  await mkdir(join(repositoryRoot, ".opencode"), { recursive: true });
  await mkdir(operatorSelectedRoot, { recursive: true });
  await mkdir(join(reportsRoot, "coverage"), { recursive: true });
  await mkdir(join(reportsRoot, "correlation"), { recursive: true });
  await mkdir(join(reportsRoot, "final"), { recursive: true });
  await mkdir(join(reportsRoot, "stage-deliveries", "audit-history", "sets"), { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(join(repositoryRoot, ".opencode", "opencode.json"), `${JSON.stringify({
    model: "project-provider/project-default",
    provider: {
      "project-provider": { models: { "project-default": {}, "project-review": {} } },
      "nested-provider": { models: { "vendor/model-v2": {} } },
    },
  }, null, 2)}\n`, "utf8");
  await writeFile(globalModelConfig, `\uFEFF{
    // JSONC is a supported OpenCode configuration format.
    "provider": {
      "global-provider": { "models": { "global-audit": {} } },
    },
  }
`, "utf8");
  await writeFile(join(repositoryRoot, "README.md"), "fixture\n", "utf8");
  await writeFile(join(operatorSelectedRoot, "README.md"), "operator selected fixture\n", "utf8");
  await writeFile(join(reportsRoot, "coverage", "coverage-plan.audit-history.json"), JSON.stringify({
    audit_id: "audit-history",
    complete: true,
    summary: { required: 3 },
  }), "utf8");
  await writeFile(join(reportsRoot, "correlation", "correlation.audit-history.json"), JSON.stringify({
    audit_id: "audit-history",
    canonical_findings: [{
      canonical_id: "F-001",
      title: "越权读取测试记录",
      description: "服务未校验记录归属。",
      severity: "HIGH",
      dimension: "D1",
      locations: [{ path: "src/api.js", line: 12, detail: "缺少 ownership guard" }],
      remediation: "按当前主体校验记录所有权。",
      residual_uncertainty: ["运行时路由部署状态未确认。"],
      source_findings: [{ finding_id: "SOURCE-001" }],
      contradictions: [],
    }],
  }), "utf8");
  await writeFile(join(reportsRoot, "final", "security-audit-report.audit-history.md"), "# 安全审计报告\n\n| 项目 | 状态 |\n|---|---|\n| 边界 | 通过 |\n\n<script>alert('blocked')</script>\n\n[危险链接](javascript:alert('blocked'))\n", "utf8");
  await writeFile(join(reportsRoot, "stage-deliveries", "audit-history", "sets", "runtime-validation-requests.r1.json"), JSON.stringify({
    schema_version: 1,
    audit_id: "audit-history",
    requests: [],
  }), "utf8");
  const verifiedModel = finalReportModel("audit-sealed");
  await writeFile(join(reportsRoot, "final", "security-audit-report-model.audit-sealed.json"), `${JSON.stringify(verifiedModel, null, 2)}\n`, "utf8");
  await writeFile(join(reportsRoot, "final", "security-audit-report.audit-sealed.md"), renderFinalReport(verifiedModel), "utf8");
  const mismatchedModel = finalReportModel("audit-mismatch");
  await writeFile(join(reportsRoot, "final", "security-audit-report-model.audit-mismatch.json"), `${JSON.stringify(mismatchedModel, null, 2)}\n`, "utf8");
  await writeFile(join(reportsRoot, "final", "security-audit-report.audit-mismatch.md"), `${renderFinalReport(mismatchedModel)}手工篡改\n`, "utf8");

  execFileSync("git", ["init", "-q", repositoryRoot]);
  execFileSync("git", ["-C", repositoryRoot, "config", "user.name", "Audit Test"]);
  execFileSync("git", ["-C", repositoryRoot, "config", "user.email", "audit-test@example.invalid"]);
  execFileSync("git", ["-C", repositoryRoot, "add", "."]);
  execFileSync("git", ["-C", repositoryRoot, "commit", "-qm", "fixture"]);
  execFileSync("git", ["init", "-q", operatorSelectedRoot]);
  execFileSync("git", ["-C", operatorSelectedRoot, "config", "user.name", "Audit Test"]);
  execFileSync("git", ["-C", operatorSelectedRoot, "config", "user.email", "audit-test@example.invalid"]);
  execFileSync("git", ["-C", operatorSelectedRoot, "add", "."]);
  execFileSync("git", ["-C", operatorSelectedRoot, "commit", "-qm", "fixture"]);
  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  const canonicalOperatorSelectedRoot = await realpath(operatorSelectedRoot);
  const fixtureCommit = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  let tmuxInstalled = true;
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); } catch { tmuxInstalled = false; }
  if (tmuxInstalled) {
    const fakeOpenCode = join(temp, "fake-opencode.mjs");
    await writeFile(fakeOpenCode, `#!/usr/bin/env node
import { createServer } from "node:http";
const [mode, ...args] = process.argv.slice(2);
if (mode === "run" && args.includes("--help")) {
  process.stdout.write("--format --session --agent --dir --title\\n");
  process.exit(0);
}
if (mode === "run") {
  const session = args.includes("--session") ? args[args.indexOf("--session") + 1] : "ses_tmux_fixture";
  process.stdout.write(JSON.stringify({ type: "step_start", sessionID: session }) + "\\n");
  setInterval(() => {}, 1000);
} else {
  process.stderr.write("unsupported fake opencode command\\n");
  process.exit(2);
}
`, "utf8");
    await chmod(fakeOpenCode, 0o700);
    const realTmuxMonitor = new OpenCodeTmuxMonitor({ stateRoot: join(temp, "tmux-monitor-state"), command: fakeOpenCode, readyTimeoutMs: 5_000 });
    let terminal;
    try {
      terminal = await realTmuxMonitor.start({
        audit: { id: "audit-tmux-fixture", name: "tmux 集成测试" },
        repository: { path: canonicalRepositoryRoot },
        environment: { OPENCODE_CONFIG: join(canonicalRepositoryRoot, ".opencode", "opencode.json") },
        args: ["run", "--format", "json", "--agent", "security-audit-orchestrator", "--dir", canonicalRepositoryRoot, "--title", "tmux 集成测试", "fixture prompt"],
      });
      assert.equal(terminal.live, true);
      assert.equal(terminal.provider_session_id, "ses_tmux_fixture");
      assert.match(await realTmuxMonitor.capture(terminal), /ses_tmux_fixture/);
      assert.match(terminal.attach_command, /^tmux -L owa-/);
      assert.equal(terminal.opencode_command, "opencode -s ses_tmux_fixture");
      await realTmuxMonitor.stop(terminal);
      terminal = await realTmuxMonitor.start({
        audit: { id: "audit-tmux-fixture", name: "tmux 恢复集成测试" },
        repository: { path: canonicalRepositoryRoot },
        environment: { OPENCODE_CONFIG: join(canonicalRepositoryRoot, ".opencode", "opencode.json") },
        providerSessionId: "ses_existing_fixture",
        args: ["run", "--format", "json", "--session", "ses_existing_fixture", "--agent", "security-audit-orchestrator", "--dir", canonicalRepositoryRoot, "--title", "tmux 恢复集成测试", "fixture recovery prompt"],
      });
      assert.equal(terminal.provider_session_id, "ses_existing_fixture");
      assert.equal(terminal.resumed, true);
    } finally {
      if (terminal) await realTmuxMonitor.stop(terminal);
    }
  }

  const relayOutputPath = join(temp, "terminal-relay-output.jsonl");
  const relayExitPath = join(temp, "terminal-relay-exit.json");
  const relaySpecPath = join(temp, "terminal-relay-spec.json");
  await writeFile(relayOutputPath, '{"type":"step_start","sessionID":"ses_relay_fixture"}\n', "utf8");
  await writeFile(relayExitPath, '{"code":0,"signal":null,"error":null}\n', "utf8");
  await writeFile(relaySpecPath, `${JSON.stringify({ output_path: relayOutputPath, exit_path: relayExitPath })}\n`, "utf8");
  const relayClient = resolve(OPENCODE, "web/dynamic-validation-observatory/terminal-output-relay.mjs");
  const relayResult = await execFileAsync(process.execPath, [relayClient, relaySpecPath], { encoding: "utf8", timeout: 5_000 });
  assert.match(relayResult.stdout, /ses_relay_fixture/);

  const validationAuditId = "web-xss-fixture";
  const validationAuditRoot = join(runtimeRoot, validationAuditId);
  await mkdir(validationAuditRoot, { recursive: true });
  const validationRequest = buildWebXssRuntimeRequest(fixtureCommit, { auditId: validationAuditId });
  const requestPath = join(validationAuditRoot, "request.json");
  const requestBytes = `${JSON.stringify(validationRequest, null, 2)}\n`;
  await writeFile(requestPath, requestBytes, "utf8");
  const validationEnvelope = buildWebXssInputEnvelope({ request: validationRequest, requestPath, requestBytes });
  await writeFile(join(validationAuditRoot, "envelope-input.json"), `${JSON.stringify(validationEnvelope, null, 2)}\n`, "utf8");

  const snapshot = await buildWorkspaceSnapshot({ reportsRoot });
  assert.equal(snapshot.summary.audit_count, 4);
  assert.equal(snapshot.summary.finding_count, 1);
  assert.equal(snapshot.summary.report_count, 3);
  assert(snapshot.reports.every(report => !Object.hasOwn(report, "sha256") && !Object.hasOwn(report, "integrity_state")));
  assert.equal(snapshot.audits.find(audit => audit.id === "audit-history").progress, 63);
  assert.equal(snapshot.audits.find(audit => audit.id === "audit-history").stage, "制品不连续");
  assert.equal(snapshot.audits.find(audit => audit.id === "audit-history").progress_source, "legacy-artifact-heuristic");
  assert.ok(snapshot.reports.find(report => report.audit_id === "audit-history"));
  assert.ok(snapshot.reports.find(report => report.audit_id === "audit-sealed"));
  assert.ok(snapshot.reports.find(report => report.audit_id === "audit-mismatch"));
  const localTodoSnapshot = await buildWorkspaceSnapshot({
    reportsRoot,
    runnerAudits: [{
      id: "audit-local-todo",
      name: "本地任务进度测试",
      status: "running",
      repository_id: "fixture",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      stage_delivery_enforcement: "TODO_ENFORCED",
      todo: { total: 4, done: 1, gap: 1, pending: 1, running: 1, failed: 0, progress: 50, complete: false },
    }],
  });
  const localTodoAudit = localTodoSnapshot.audits.find(audit => audit.id === "audit-local-todo");
  assert.equal(localTodoAudit.progress, 50);
  assert.equal(localTodoAudit.progress_source, "local-audit-todo");
  assert.equal(localTodoAudit.stage, "多维漏洞审计 · 1/4");
  // Display snapshots do not run completion-time integrity verification.
  assert.equal(Object.hasOwn(snapshot.reports.find(report => report.audit_id === "audit-mismatch"), "integrity_issues"), false);
  assert.equal(snapshot.findings[0].id, "F-001");
  assert.equal(snapshot.findings[0].description, "服务未校验记录归属。");
  assert.equal(snapshot.findings[0].remediation, "按当前主体校验记录所有权。");
  assert.equal(snapshot.findings[0].residual_uncertainty, "运行时路由部署状态未确认。");
  assert.deepEqual(snapshot.findings[0].source_finding_ids, ["SOURCE-001"]);
  assert.equal(snapshot.findings[0].locations[0].detail, "缺少 ownership guard");

  // The OpenCode process can end after it has sealed the deterministic model but
  // before the Markdown renderer writes its output.  The workbench must repair
  // that exact artifact locally instead of requiring an audit retry.
  const repairModel = finalReportModel("audit-report-repair");
  await writeFile(join(reportsRoot, "final", "security-audit-report-model.audit-report-repair.json"), `${JSON.stringify(repairModel, null, 2)}\n`, "utf8");
  const reportRepair = await materializeFinalReportFromModel({ reportsRoot, auditId: "audit-report-repair" });
  assert.equal(reportRepair.available, true);
  assert.equal(reportRepair.materialized, true);
  assert.equal(reportRepair.artifact.path, "final/security-audit-report.audit-report-repair.md");
  const repairedSnapshot = await buildWorkspaceSnapshot({ reportsRoot });
  assert.ok(repairedSnapshot.reports.find(report => report.audit_id === "audit-report-repair"));

  const v2Findings = findingsFromArtifacts([{
    kind: "correlation",
    audit_id: "audit-finding-v2",
    path: "correlation/finding-v2.json",
    data: {
      canonical_findings: [{
        finding_schema_version: 2,
        finding_id: "FIND-V2-001",
        state: "SUPPORTED_STATIC",
        classification: {
          vulnerability_type_id: "JW-AUTHN-01",
          dimension_claims: [{ dimension: "D2", rationale: "认证边界受影响。" }],
        },
        locations: {
          primary: { file: "src/Auth.java", line_start: 42, line_end: 44, source_digest: "a".repeat(64) },
        },
        evidence: {
          facts: [
            { kind: "source", claim: "认证头由攻击者控制。", locator: { file: "src/Auth.java", line_start: 42, source_digest: "a".repeat(64) } },
            { kind: "sink", claim: "令牌解析器在认证边界使用该值。", locator: { file: "src/Auth.java", line_start: 44, source_digest: "a".repeat(64) } },
          ],
        },
        attack_surface: { impact: { outcome: "伪造令牌可能建立攻击者选择的身份。" } },
        reachability: { state: "static-reachable" },
        attacker_influence: { state: "direct" },
        severity: { rationale: "认证边界可达且输入可控。" },
        remediation: { summary: "在使用声明前校验令牌。" },
        uncertainty: { assumptions: ["尚未进行运行时部署验证。"] },
        source_findings: [{ finding_id: "SOURCE-V2-001" }],
        contradictions: [],
      }],
    },
  }]);
  assert.equal(v2Findings.length, 1);
  assert.equal(v2Findings[0].title, "漏洞类型：JW-AUTHN-01");
  assert.equal(v2Findings[0].location.path, "src/Auth.java");
  assert.equal(v2Findings[0].location.line, 42);
  assert.equal(v2Findings[0].location_complete, true);
  assert.equal(v2Findings[0].locations[1].line, 44);
  assert.equal(v2Findings[0].description, "伪造令牌可能建立攻击者选择的身份。");
  assert.equal(v2Findings[0].evidence.length, 2);
  assert.equal(v2Findings[0].remediation, "在使用声明前校验令牌。");
  assert.equal(v2Findings[0].residual_uncertainty, "尚未进行运行时部署验证。");
  assert.equal(v2Findings[0].status, "supported_static");

  const malformedReportsRoot = join(temp, "malformed-workspace-reports");
  const malformedAuditId = "audit-malformed-artifact";
  await mkdir(join(malformedReportsRoot, "vulnerability-mining"), { recursive: true });
  await mkdir(join(malformedReportsRoot, "stage-deliveries", malformedAuditId), { recursive: true });
  await writeFile(join(malformedReportsRoot, "vulnerability-mining", "malformed.json"), `${JSON.stringify({ audit_id: malformedAuditId, findings: {} })}\n`, "utf8");
  await writeFile(join(malformedReportsRoot, "stage-deliveries", malformedAuditId, "scope.r1.json"), `${JSON.stringify({
    schema_version: 1,
    audit_id: malformedAuditId,
    stage_id: "scope",
    round: 1,
    status: "PARTIAL",
    input_artifacts: {},
    output_artifacts: {},
    predecessor_manifests: {},
    validation_results: {},
  })}\n`, "utf8");
  const malformedSnapshot = await buildWorkspaceSnapshot({
    reportsRoot: malformedReportsRoot,
    runnerAudits: [{ id: malformedAuditId, name: "畸形制品隔离测试", status: "running", repository_id: "fixture", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), stage_delivery_enforcement: "ENFORCED" }],
  });
  assert.equal(malformedSnapshot.audits.some(audit => audit.id === malformedAuditId), true);
  assert.equal(malformedSnapshot.summary.active_audits, 1);
  assert.equal(Array.isArray(malformedSnapshot.findings), true);

  const objectRegistryStateRoot = join(temp, "object-registry-state");
  await mkdir(objectRegistryStateRoot, { recursive: true });
  await writeFile(join(objectRegistryStateRoot, "repositories.json"), `${JSON.stringify({
    schema_version: 1,
    repositories: { fixture: { name: "对象形态仓库", path: canonicalRepositoryRoot } },
  })}\n`, "utf8");
  const objectRegistryRunner = new AuditRunner({ stateRoot: objectRegistryStateRoot, platformRoot, configPath: join(repositoryRoot, ".opencode", "opencode.json") });
  await objectRegistryRunner.ready;
  assert.equal((await objectRegistryRunner.listRepositories()).some(repository => repository.id === "fixture"), true);
  assert.equal(Array.isArray(JSON.parse(await readFile(join(objectRegistryStateRoot, "repositories.json"), "utf8")).repositories), false, "只读 Runner 不迁移仓库登记文件");
  await objectRegistryRunner.shutdown();

  let spawnCall = null;
  const child = new FakeChild();
  const terminalMonitor = new FakeTerminalMonitor();
  const dynamicChild = new FakeChild();
  let dynamicSpawnCall = null;
  const runner = new AuditRunner({
    stateRoot,
    platformRoot,
    repositories: [{ id: "fixture", name: "测试仓库", path: repositoryRoot }],
    configPath: join(repositoryRoot, ".opencode", "opencode.json"),
    enabled: true,
    environment: { ...process.env, AUDIT_KNOWLEDGE_ROOT: "../KnowledgeWorkFlow", http_proxy: "http://proxy-fixture.test:8080", HTTPS_PROXY: "http://secure-proxy-fixture.test:8443" },
    terminalMonitor,
    spawnProcess(command, args, options) {
      spawnCall = { command, args, options };
      return child;
    },
  });
  await runner.ready;
  let fallbackSpawnCall = null;
  const fallbackChild = new FakeChild();
  const fallbackRunner = new AuditRunner({
    stateRoot: join(temp, "fallback-state"),
    platformRoot,
    repositories: [{ id: "fixture", name: "测试仓库", path: repositoryRoot }],
    configPath: join(repositoryRoot, ".opencode", "opencode.json"),
    enabled: true,
    terminalMonitor: {
      async probe() { return { available: false, message: "未找到 tmux。", opencode_command: "C:\\tools\\opencode.exe" }; },
      async stop() {},
    },
    stageDeliveryVerifier: async ({ auditId }) => ({
      enforcement: "ENFORCED",
      audit_id: auditId,
      complete: true,
      completed_count: 8,
      stages: [],
      errors: [],
    }),
    todoCompletionVerifier: async () => ({ complete: true, errors: [], summary: { total: 1, done: 1, gap: 0, pending: 0, running: 0, failed: 0, progress: 100, complete: true }, final_report_path: "final/security-audit-report.audit-fallback-001.md" }),
    spawnProcess(command, args, options) {
      fallbackSpawnCall = { command, args, options };
      return fallbackChild;
    },
  });
  await fallbackRunner.ready;
  const fallbackAudit = await fallbackRunner.createAudit({ audit_id: "audit-fallback-001", repository_id: "fixture", ref: "HEAD", allow_dirty: true }, "fallback-request-001");
  for (let attempt = 0; attempt < 100 && !["running", "failed"].includes(fallbackRunner.getAudit(fallbackAudit.id)?.status); attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(fallbackRunner.getAudit(fallbackAudit.id).status, "running", String(fallbackRunner.getAudit(fallbackAudit.id).error ?? "fallback runner 未进入运行状态"));
  assert.equal(fallbackSpawnCall.command, "C:\\tools\\opencode.exe");
  assert.equal(fallbackSpawnCall.options.windowsHide, true);
  assert.deepEqual(fallbackSpawnCall.args.slice(0, 6), ["run", "--format", "json", "--agent", "security-audit-orchestrator", "--dir"]);
  assert.equal(fallbackSpawnCall.args[6], join(platformRoot, "workspace", "audit-runs", "audit-fallback-001"));
  assert.equal(fallbackSpawnCall.options.cwd, join(platformRoot, "workspace", "audit-runs", "audit-fallback-001"));
  assert.equal(fallbackAudit.bac_analysis.mode, "auto");
  assert.equal(fallbackSpawnCall.options.env.AUDIT_BAC_MODE, "auto");
  assert.equal(fallbackRunner.getAudit(fallbackAudit.id).terminal.status, "unavailable");
  fallbackChild.stdout.write('{"type":"step_start","sessionID":"ses_fallback_fixture"}\n');
  for (let attempt = 0; attempt < 50 && !fallbackRunner.getAudit(fallbackAudit.id).provider_session_id; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(fallbackRunner.getAudit(fallbackAudit.id).provider_session_id, "ses_fallback_fixture");
  fallbackChild.emit("close", 0, null);
  for (let attempt = 0; attempt < 50 && !(await fallbackRunner.eventsSince(fallbackAudit.id)).some(event => event.type === "audit.completed"); attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(fallbackRunner.getAudit(fallbackAudit.id).status, "completed");
  assert.equal(fallbackRunner.getAudit(fallbackAudit.id).todo_completion.complete, true);
  const sourceBinding = JSON.parse(await readFile(join(platformRoot, "reports", "repositories", "fixture", "platform", "audit-runs", fallbackAudit.id, "source-binding.json"), "utf8"));
  assert.equal(sourceBinding.audit_id, fallbackAudit.id);
  assert.equal(sourceBinding.task_context.quick_dynamic_opt_in, false);
  assert.equal(sourceBinding.task_context.bac_analysis.mode, "auto");
  assert.match(sourceBinding.binding_digest, /^[a-f0-9]{64}$/);
  await fallbackRunner.shutdown();

  // Queued tasks retain their model even when the global default changes.
  let queuedModelSelection = "global-provider/global-audit";
  const queuedChild = new FakeChild();
  const queuedTerminalMonitor = new FakeTerminalMonitor();
  const queuedRunner = new AuditRunner({
    stateRoot: join(temp, "queued-model-state"),
    platformRoot: join(temp, "queued-model-platform"),
    repositories: [{ id: "fixture", name: "测试仓库", path: repositoryRoot }],
    configPath: join(repositoryRoot, ".opencode", "opencode.json"),
    enabled: true,
    modelResolver: async () => queuedModelSelection,
    terminalMonitor: queuedTerminalMonitor,
    spawnProcess() { return queuedChild; },
  });
  queuedRunner.setQueueScheduler({ async enqueueNewAudit() { return true; } });
  await queuedRunner.ready;
  const queuedAudit = await queuedRunner.createAudit({
    audit_id: "audit-queued-model-001",
    repository_id: "fixture",
    ref: "HEAD",
    allow_dirty: true,
    model: queuedModelSelection,
    bac_analysis: "off",
  }, "queued-model-request-001");
  assert.equal(queuedRunner.getAudit(queuedAudit.id).status, "queued");
  assert.equal(queuedRunner.getAudit(queuedAudit.id).bac_analysis.mode, "off");
  assert.equal(queuedRunner.getAudit(queuedAudit.id).model, "global-provider/global-audit");
  queuedModelSelection = "project-provider/project-default";
  assert.equal(queuedRunner.getAudit(queuedAudit.id).model, "global-provider/global-audit");
  assert.equal(await queuedRunner.modelForLaunch({ model: null }), null, "显式默认不得被全局模型覆盖");
  const originalContexts = {
    memory_mode: 'full',
    additional_instructions_enabled: true,
    additional_instructions: "只验证指定入口。\n\n保留这段说明的分行与中文。",
    test_environment_enabled: true,
    test_environment_context: "测试入口：http://test.example:8080\n测试账号：retry-fixture/retry-fixture-secret\n只操作指定测试记录。",
  };
  const retrySource = await queuedRunner.createAudit({ repository_id: "fixture", allow_dirty: true,
    audit_id: "audit-retry-context-source", ...originalContexts }, "retry-context-source");
  const retryDraft = await queuedRunner.retryDraft(retrySource.id);
  assert.deepEqual(retryDraft, originalContexts);
  const retryCopy = await queuedRunner.createAudit({ repository_id: "fixture", allow_dirty: true,
    audit_id: "audit-retry-context-copy", ...retryDraft }, "retry-context-copy");
  assert.deepEqual(await queuedRunner.retryDraft(retryCopy.id), originalContexts);
  const editedRetry = await queuedRunner.createAudit({ repository_id: "fixture", allow_dirty: true,
    audit_id: "audit-retry-context-edited", ...retryDraft, additional_instructions: "重试时修改的关注点。",
    test_environment_enabled: false }, "retry-context-edited");
  assert.deepEqual(await queuedRunner.retryDraft(editedRetry.id), {
    memory_mode: 'full',
    additional_instructions_enabled: true, additional_instructions: "重试时修改的关注点。",
    test_environment_enabled: false, test_environment_context: "",
  });
  assert.deepEqual(await queuedRunner.retryDraft(retrySource.id), originalContexts);
  assert.equal(JSON.stringify(queuedRunner.listAudits()).includes("retry-fixture-secret"), false);
  assert.equal(JSON.stringify(await queuedRunner.eventsSince(retryCopy.id)).includes("retry-fixture-secret"), false);
  queuedModelSelection = "project-provider/project-review";
  await queuedRunner.dispatchQueuedAudit(queuedAudit.id);
  assert.equal(queuedTerminalMonitor.starts[0].args[queuedTerminalMonitor.starts[0].args.indexOf("--model") + 1], "global-provider/global-audit");
  assert.equal(queuedTerminalMonitor.starts[0].environment.AUDIT_BAC_MODE, "off");
  await queuedRunner.shutdown();

  const gatedChild = new FakeChild();
  const gatedRunner = new AuditRunner({
    stateRoot: join(temp, "gated-state"),
    platformRoot,
    repositories: [{ id: "fixture", name: "测试仓库", path: repositoryRoot }],
    configPath: join(repositoryRoot, ".opencode", "opencode.json"),
    enabled: true,
    terminalMonitor: {
      async probe() { return { available: false, message: "未找到 tmux。" }; },
      async stop() {},
    },
    stageDeliveryVerifier: async ({ auditId }) => ({
      enforcement: "ENFORCED",
      audit_id: auditId,
      complete: false,
      completed_count: 6,
      stages: [],
      errors: ["validation:artifact-missing"],
    }),
    todoCompletionVerifier: async () => ({ complete: false, errors: ["仍有 2 项 PENDING。"], summary: { total: 2, done: 0, gap: 0, pending: 2, running: 0, failed: 0, progress: 0, complete: false }, final_report_path: null }),
    spawnProcess() { return gatedChild; },
  });
  await gatedRunner.ready;
  const gatedAudit = await gatedRunner.createAudit({ audit_id: "audit-gated-001", repository_id: "fixture", ref: "HEAD", allow_dirty: true }, "gated-request-001");
  for (let attempt = 0; attempt < 100 && !["running", "failed"].includes(gatedRunner.getAudit(gatedAudit.id)?.status); attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(gatedRunner.getAudit(gatedAudit.id).status, "running", String(gatedRunner.getAudit(gatedAudit.id).error ?? "stage gate runner 未进入运行状态"));
  gatedChild.emit("close", 0, null);
  for (let attempt = 0; attempt < 100 && gatedRunner.getAudit(gatedAudit.id)?.status === "running"; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(gatedRunner.getAudit(gatedAudit.id).status, "interrupted");
  assert.equal(gatedRunner.getAudit(gatedAudit.id).interruption_reason, "local-audit-todo-incomplete");
  assert.match(gatedRunner.getAudit(gatedAudit.id).error, /2 项 PENDING/);
  await gatedRunner.shutdown();

  // A live OpenCode run can enter its own wait/continue loop after all durable
  // work is complete. The watchdog must use only the local todo plus final
  // report gate, accept a terminal GAP, and terminate that runner itself.
  const terminalGapChild = new FakeChild();
  const terminalGapMonitor = new FakeTerminalMonitor();
  const terminalGapRunner = new AuditRunner({
    stateRoot: join(temp, "terminal-gap-watchdog-state"),
    platformRoot,
    repositories: [{ id: "fixture", name: "测试仓库", path: repositoryRoot }],
    configPath: join(repositoryRoot, ".opencode", "opencode.json"),
    enabled: true,
    terminalMonitor: terminalGapMonitor,
    completionWatchdogIntervalMs: 3_600_000,
    todoCompletionVerifier: async () => ({
      complete: true,
      errors: [],
      summary: { total: 2, done: 1, gap: 1, pending: 0, running: 0, failed: 0, progress: 100, complete: true, next_action: "FINALIZE_WITH_RESIDUAL_GAPS" },
      final_report_path: "final/security-audit-report.audit-terminal-gap-watchdog.md",
    }),
    spawnProcess() { return terminalGapChild; },
  });
  await terminalGapRunner.ready;
  const terminalGapAudit = await terminalGapRunner.createAudit({ audit_id: "audit-terminal-gap-watchdog", repository_id: "fixture", ref: "HEAD", allow_dirty: true }, "terminal-gap-watchdog-request");
  for (let attempt = 0; attempt < 100 && terminalGapRunner.getAudit(terminalGapAudit.id)?.status !== "running"; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(terminalGapRunner.getAudit(terminalGapAudit.id).status, "running");
  assert.match(terminalGapMonitor.starts[0].args.at(-1), /FINALIZE_WITH_RESIDUAL_GAPS/);
  assert.match(terminalGapMonitor.starts[0].args.at(-1), /不得输出“继续”“等待”“下一步”/);
  assert.equal(await terminalGapRunner.runCompletionWatchdog("test-terminal-gap-watchdog"), 1);
  for (let attempt = 0; attempt < 100 && !(await terminalGapRunner.eventsSince(terminalGapAudit.id)).some(event => event.type === "audit.runner.stopped"); attempt += 1) await new Promise(resolve => setImmediate(resolve));
  const terminalGapResult = terminalGapRunner.getAudit(terminalGapAudit.id);
  assert.equal(terminalGapResult.status, "completed");
  assert.equal(terminalGapResult.completion_source, "todo-artifact-watchdog");
  assert.equal(terminalGapResult.todo_summary.gap, 1, "展示用 GAP 不得阻止任务收尾");
  assert.deepEqual(terminalGapChild.signals, ["SIGTERM"]);
  assert.equal(terminalGapMonitor.abortCalls.length, 1);
  assert.equal(terminalGapMonitor.stopCalls, 1);
  assert.equal((await terminalGapRunner.eventsSince(terminalGapAudit.id)).some(event => event.type === "audit.runner.stopped"), true);
  await terminalGapRunner.shutdown();

  // A known OpenCode timeout is recoverable.  The watchdog must interrupt the
  // stale run, retain its provider session and artifacts, then launch exactly
  // one automatic checkpoint recovery.
  const timeoutFirstChild = new FakeChild();
  const timeoutRecoveredChild = new FakeChild();
  const timeoutMonitor = new FakeTerminalMonitor();
  let timeoutSpawnCount = 0;
  const timeoutRunner = new AuditRunner({
    stateRoot: join(temp, "timeout-recovery-state"),
    platformRoot,
    repositories: [{ id: "fixture", name: "测试仓库", path: repositoryRoot }],
    configPath: join(repositoryRoot, ".opencode", "opencode.json"),
    enabled: true,
    terminalMonitor: timeoutMonitor,
    completionWatchdogIntervalMs: 3_600_000,
    todoCompletionVerifier: async () => ({
      complete: false,
      errors: ["仍有 1 项 PENDING。"],
      summary: { total: 1, done: 0, gap: 0, pending: 1, running: 0, failed: 0, progress: 0, complete: false, next_action: "CLAIM" },
      final_report_path: null,
    }),
    spawnProcess() { timeoutSpawnCount += 1; return timeoutSpawnCount === 1 ? timeoutFirstChild : timeoutRecoveredChild; },
  });
  await timeoutRunner.ready;
  const timeoutAudit = await timeoutRunner.createAudit({ audit_id: "audit-timeout-recovery", repository_id: "fixture", ref: "HEAD", allow_dirty: true }, "timeout-recovery-request");
  for (let attempt = 0; attempt < 100 && timeoutRunner.getAudit(timeoutAudit.id)?.status !== "running"; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  timeoutFirstChild.stdout.write("Error: The operation timed out\n");
  for (let attempt = 0; attempt < 1_000 && (timeoutSpawnCount !== 2 || timeoutRunner.getAudit(timeoutAudit.id)?.status !== "running" || timeoutRunner.getAudit(timeoutAudit.id)?.recovery_count !== 1 || timeoutRunner.getAudit(timeoutAudit.id)?.timeout_recovery?.state !== "restarted"); attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  const timeoutResult = timeoutRunner.getAudit(timeoutAudit.id);
  assert.equal(timeoutSpawnCount, 2, "超时 watchdog 必须只启动一次断点恢复");
  assert.equal(timeoutResult.status, "running");
  assert.equal(timeoutResult.recovery_count, 1);
  assert.equal(timeoutResult.timeout_recovery.state, "restarted");
  assert.equal(timeoutResult.timeout_recovery.attempts, 1);
  assert.deepEqual(timeoutFirstChild.signals, ["SIGTERM"]);
  assert.equal(timeoutMonitor.abortCalls.length, 1);
  let timeoutEvents = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    timeoutEvents = await timeoutRunner.eventsSince(timeoutAudit.id);
    if (timeoutEvents.some(event => event.type === "audit.timeout.recovery.started")) break;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(timeoutEvents.some(event => event.type === "audit.timeout.detected"), true);
  assert.equal(timeoutEvents.some(event => event.type === "audit.timeout.recovery.started"), true);
  await timeoutRunner.shutdown();

  // Enterprise deployments may expose only a 128K model context.  When
  // OpenCode reports that exact context-window failure, the watchdog must run
  // the built-in compact command on the same provider session before recovery.
  const contextFirstChild = new FakeChild();
  const contextRecoveredChild = new FakeChild();
  const contextMonitor = new FakeTerminalMonitor();
  const compactCalls = [];
  let contextSpawnCount = 0;
  const contextRunner = new AuditRunner({
    stateRoot: join(temp, "context-window-recovery-state"),
    platformRoot: join(temp, "context-window-platform"),
    repositories: [{ id: "fixture", name: "测试仓库", path: repositoryRoot }],
    configPath: join(repositoryRoot, ".opencode", "opencode.json"),
    enabled: true,
    terminalMonitor: contextMonitor,
    completionWatchdogIntervalMs: 3_600_000,
    compactSessionRunner: async (command, args, options) => {
      compactCalls.push({ command, args, options });
      return { stdout: '{"type":"text","part":{"text":"compacted"}}\n', stderr: "" };
    },
    spawnProcess() { contextSpawnCount += 1; return contextSpawnCount === 1 ? contextFirstChild : contextRecoveredChild; },
  });
  await contextRunner.ready;
  const contextAudit = await contextRunner.createAudit({ audit_id: "audit-context-window-recovery", repository_id: "fixture", ref: "HEAD", allow_dirty: true }, "context-window-recovery-request");
  for (let attempt = 0; attempt < 100 && contextRunner.getAudit(contextAudit.id)?.status !== "running"; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  contextFirstChild.stderr.write("Error: This model's maximum input length is 131072 tokens. However, your messages resulted in 140000 tokens.\n");
  for (let attempt = 0; attempt < 1_000 && (contextSpawnCount !== 2 || contextRunner.getAudit(contextAudit.id)?.status !== "running" || contextRunner.getAudit(contextAudit.id)?.context_window_recovery?.state !== "restarted"); attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  const contextResult = contextRunner.getAudit(contextAudit.id);
  assert.equal(contextSpawnCount, 2, "上下文 watchdog 应在压缩后只启动一次断点恢复");
  assert.equal(compactCalls.length, 1, "上下文溢出必须只触发一次 compact");
  assert.equal(compactCalls[0].command, "opencode");
  assert.deepEqual(compactCalls[0].args.slice(0, 7), ["run", "--format", "json", "--session", `ses_${contextAudit.id}`, "--command", "compact"]);
  assert.equal(compactCalls[0].args.includes("/compact"), false, "必须调用内置 command，而不是发送普通文本提示");
  assert.equal(contextResult.status, "running");
  assert.equal(contextResult.recovery_count, 1);
  assert.equal(contextResult.context_window_recovery.attempts, 1);
  assert.equal(contextResult.context_window_recovery.state, "restarted");
  assert.deepEqual(contextFirstChild.signals, ["SIGTERM"]);
  let contextEvents = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    contextEvents = await contextRunner.eventsSince(contextAudit.id);
    if (contextEvents.some(event => event.type === "audit.context-window.recovery.started")) break;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(contextEvents.some(event => event.type === "audit.context-window.detected"), true);
  assert.equal(contextEvents.some(event => event.type === "audit.context-window.compaction.completed"), true);
  assert.equal(contextEvents.some(event => event.type === "audit.context-window.recovery.started"), true);
  await contextRunner.shutdown();

  // psmux/Windows can acknowledge SIGTERM while leaving the output relay alive.
  // That stale child must not occupy the concurrency slot forever or overwrite
  // the newer recovery Runner when it eventually exits.
  const stuckTimeoutChild = new FakeChild({ closeOnTerminate: false });
  const forcedRecoveryChild = new FakeChild();
  const stuckTimeoutMonitor = new FakeTerminalMonitor();
  let stuckTimeoutSpawnCount = 0;
  const stuckTimeoutRunner = new AuditRunner({
    stateRoot: join(temp, "stuck-timeout-recovery-state"),
    platformRoot: join(temp, "stuck-timeout-platform"),
    repositories: [{ id: "fixture", name: "测试仓库", path: repositoryRoot }],
    configPath: join(repositoryRoot, ".opencode", "opencode.json"),
    enabled: true,
    environment: { PATH: process.env.PATH ?? "" },
    terminalMonitor: stuckTimeoutMonitor,
    operationTimeoutTerminationGraceMs: 100,
    spawnProcess() { stuckTimeoutSpawnCount += 1; return stuckTimeoutSpawnCount === 1 ? stuckTimeoutChild : forcedRecoveryChild; },
  });
  await stuckTimeoutRunner.ready;
  const stuckTimeoutAudit = await stuckTimeoutRunner.createAudit({ audit_id: "audit-stuck-timeout-recovery", repository_id: "fixture", ref: "HEAD", allow_dirty: true }, "stuck-timeout-recovery-request");
  for (let attempt = 0; attempt < 100 && stuckTimeoutRunner.getAudit(stuckTimeoutAudit.id)?.status !== "running"; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  stuckTimeoutChild.stdout.write("Error: The operation timed out\n");
  for (let attempt = 0; attempt < 1_000 && (stuckTimeoutSpawnCount !== 2 || stuckTimeoutRunner.getAudit(stuckTimeoutAudit.id)?.status !== "running" || stuckTimeoutRunner.getAudit(stuckTimeoutAudit.id)?.timeout_recovery?.state !== "restarted"); attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(stuckTimeoutSpawnCount, 2, "未 close 的超时中继必须在宽限期后恢复");
  assert.deepEqual(stuckTimeoutChild.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(stuckTimeoutRunner.getAudit(stuckTimeoutAudit.id).status, "running");
  await stuckTimeoutRunner.shutdown();

  // When all scheduled work is terminal but report sealing is malformed, the
  // watchdog must identify the required name, format and location instead of
  // presenting a generic retry-only failure.
  const deliveryDiagnosticChild = new FakeChild();
  const deliveryDiagnosticRunner = new AuditRunner({
    stateRoot: join(temp, "delivery-diagnostic-state"),
    platformRoot,
    repositories: [{ id: "fixture", name: "测试仓库", path: repositoryRoot }],
    configPath: join(repositoryRoot, ".opencode", "opencode.json"),
    enabled: true,
    terminalMonitor: {
      async probe() { return { available: false, message: "未找到 tmux。" }; },
      async stop() {},
    },
    spawnProcess() { return deliveryDiagnosticChild; },
  });
  await deliveryDiagnosticRunner.ready;
  const deliveryDiagnosticAudit = await deliveryDiagnosticRunner.createAudit({ audit_id: "audit-delivery-diagnostic", repository_id: "fixture", ref: "HEAD", allow_dirty: true }, "delivery-diagnostic-request");
  for (let attempt = 0; attempt < 100 && deliveryDiagnosticRunner.getAudit(deliveryDiagnosticAudit.id)?.status !== "running"; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  await writeFile(join(temp, "delivery-diagnostic-state", deliveryDiagnosticAudit.id, "audit-todo.json"), `${JSON.stringify({
    schema_version: 1,
    audit_id: deliveryDiagnosticAudit.id,
    items: [{ item_id: "todo:delivery-diagnostic", status: "DONE", agent_name: "fixture" }],
    packets: [],
  }, null, 2)}\n`, "utf8");
  await writeFile(join(reportsRoot, "final", "security-audit-report.audit-delivery-diagnostic-draft.md"), "# 错误名称的草稿\n", "utf8");
  await writeFile(join(reportsRoot, "final", "security-audit-report-model.audit-delivery-diagnostic.json"), "{\n", "utf8");
  deliveryDiagnosticChild.emit("close", 0, null);
  for (let attempt = 0; attempt < 500 && !deliveryDiagnosticRunner.getAudit(deliveryDiagnosticAudit.id)?.todo_completion; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  const deliveryDiagnosticResult = deliveryDiagnosticRunner.getAudit(deliveryDiagnosticAudit.id);
  assert.ok(deliveryDiagnosticResult.todo_completion, JSON.stringify(deliveryDiagnosticResult));
  const deliveryDiagnosticErrors = deliveryDiagnosticResult.todo_completion.errors.join("\n");
  assert.equal(deliveryDiagnosticResult.status, "interrupted");
  assert.match(deliveryDiagnosticErrors, /reports\/final\/security-audit-report\.audit-delivery-diagnostic\.md/);
  assert.match(deliveryDiagnosticErrors, /Markdown 候选/);
  assert.match(deliveryDiagnosticErrors, /不是有效 JSON/);
  await deliveryDiagnosticRunner.shutdown();

  // A server restart loses the child-process handle.  If the task's durable
  // completion evidence is already valid, startup must converge it to completed
  // before the UI offers a meaningless retry.
  const reconciledStateRoot = join(temp, "reconciled-state");
  const reconciledAuditId = "audit-reconciled-001";
  const reconciledTodoPath = join(reconciledStateRoot, reconciledAuditId, "audit-todo.json");
  await mkdir(join(reconciledStateRoot, reconciledAuditId), { recursive: true });
  await writeFile(join(reconciledStateRoot, reconciledAuditId, "run.json"), `${JSON.stringify({
    id: reconciledAuditId,
    name: "重启收敛测试",
    repository_id: "fixture",
    repository_name: "测试仓库",
    status: "interrupted",
    version: 1,
    event_sequence: 0,
    created_at: "2026-08-15T00:00:00.000Z",
    updated_at: "2026-08-15T00:00:00.000Z",
    started_at: "2026-08-15T00:00:00.000Z",
    finished_at: "2026-08-15T00:01:00.000Z",
    todo_path: reconciledTodoPath,
    stage_delivery_enforcement: "TODO_ENFORCED",
    interruption_reason: "workbench-restarted",
    error: "工作台服务已重启，原 Runner 连接已中断。",
  }, null, 2)}\n`, "utf8");
  const reconciledRunner = new AuditRunner({
    enabled: true,
    stateRoot: reconciledStateRoot,
    platformRoot,
    repositories: [{ id: "fixture", name: "测试仓库", path: repositoryRoot }],
    configPath: join(repositoryRoot, ".opencode", "opencode.json"),
    terminalMonitor: { async stop() {} },
    todoCompletionVerifier: async () => ({
      complete: true,
      errors: [],
      summary: { total: 1, done: 1, gap: 0, pending: 0, running: 0, failed: 0, progress: 100, complete: true },
      final_report_path: "final/security-audit-report.audit-reconciled-001.md",
    }),
  });
  await reconciledRunner.ready;
  assert.equal(reconciledRunner.getAudit(reconciledAuditId).status, "completed");
  assert.equal(reconciledRunner.getAudit(reconciledAuditId).completion_source, "todo-artifact-verification");
  assert.equal((await reconciledRunner.eventsSince(reconciledAuditId)).some(event => event.type === "audit.completed"), true);
  await reconciledRunner.shutdown();

  const dynamicStateRoot = join(temp, "dynamic-state");
  const dynamicRunner = new DynamicValidationRunner({
    stateRoot: dynamicStateRoot,
    enabled: true,
    registryPath: join(OPENCODE, "skills/common-subagent/audit-artifact-management/contracts/stage-agent-contracts.json"),
    rolesPath: join(OPENCODE, "agent-manifest/roles.json"),
    authSourceRoot: join(temp, "empty-opencode-auth"),
    resultValidator: async () => {},
    spawnProcess(command, args, options) {
      dynamicSpawnCall = { command, args, options };
      return dynamicChild;
    },
  });
  const repositories = await runner.listRepositories();
  assert.equal(repositories[0].configured, true);
  assert.equal(repositories[0].config_valid, true);
  assert.equal(repositories[0].git_repository, true);
  assert.equal(repositories[0].ready, true);
  assert.equal(repositories[0].readiness, "ready");
  assert.equal(repositories[0].dirty, false);
  assert.equal(repositories[0].audit_count, 0);
  assert.equal(repositories[0].removable, false);
  assert.equal(repositories[0].directory, canonicalRepositoryRoot);

  const fakeBin = join(temp, "fake-bin");
  const healthConfig = join(temp, "health-opencode.json");
  await writeFile(healthConfig, `${JSON.stringify({
    mcp: { "chrome-devtools": { enabled: true, command: ["npx", "chrome-devtools-mcp"] } },
  })}\n`, "utf8");
  let versionProbeCount = 0;
  const environmentService = new EnvironmentHealthService({
    projectRoot: resolve(OPENCODE, ".."),
    configPaths: [healthConfig],
    environment: { PATH: fakeBin, OPENCODE_BIN: join(fakeBin, "opencode"), JOERN_BIN: join(fakeBin, "joern"), JOERN_PARSE_BIN: join(fakeBin, "joern-parse"), OPENGREP_BIN: join(fakeBin, "opengrep"), JOERN_JAVA_BIN: fakeBin },
    platform: "linux",
    architecture: "x64",
    nodeVersion: "22.12.0",
    async resolveCommand(command) { return command; },
    async execute(command) {
      versionProbeCount += 1;
      return { stdout: `${basename(command)} 1.0.0\n`, stderr: "" };
    },
  });
  const health = await environmentService.snapshot();
  assert.equal(health.platform.os, "linux");
  assert.equal(health.configuration.valid, 1);
  assert(health.capabilities.every(item => item.status === "ready"));
  assert.equal(health.components.some(item => item.id === "coverage_ledger"), false);
  assert.equal(health.components.find(item => item.id === "chrome_devtools_mcp").status, "ready");
  const cachedProbeCount = versionProbeCount;
  await environmentService.snapshot();
  assert.equal(versionProbeCount, cachedProbeCount);

  for (const chromeLocation of ["system", "user", null]) {
    const chromeCandidates = []; let macChromeLaunches = 0;
    const macHealthService = new EnvironmentHealthService({
      projectRoot: resolve(OPENCODE, ".."), configPaths: [healthConfig],
      environment: { PATH: fakeBin, OPENCODE_BIN: join(fakeBin, "opencode") },
      platform: "darwin", architecture: "arm64", nodeVersion: "22.12.0",
      async resolveCommand(command) {
        if (/chrome|chromium/i.test(command)) {
          chromeCandidates.push(command);
          return (command === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ? chromeLocation === "system" : chromeLocation === "user") ? command : null;
        }
        return command;
      },
      async execute(command) {
        if (/chrome|chromium/i.test(command)) { macChromeLaunches++; throw new Error("环境自检不得启动 Chrome"); }
        return { stdout: `${basename(command)} 1.0.0\n`, stderr: "" };
      },
    });
    const macHealth = await macHealthService.snapshot();
    assert.equal(macChromeLaunches, 0); assert.equal(chromeCandidates.length, chromeLocation === "system" ? 1 : 2);
    assert.equal(macHealth.components.find(item => item.id === "chrome").status, chromeLocation ? "ready" : "unavailable");
    const dynamic = macHealth.capabilities.find(item => item.id === "dynamic");
    assert.equal(dynamic.status, chromeLocation ? "ready" : "blocked");
    assert.deepEqual(dynamic.blockers, chromeLocation ? [] : ["chrome"]);
    assert.equal(macHealth.capabilities.find(item => item.id === "static").status, "ready");
  }

  let windowsChromeLaunches = 0;
  const windowsHealthService = new EnvironmentHealthService({
    projectRoot: resolve(OPENCODE, ".."),
    configPaths: [healthConfig],
    environment: { PATH: "C:\\tools", PATHEXT: ".EXE;.CMD", PROGRAMFILES: "C:\\Program Files" },
    platform: "win32",
    architecture: "x64",
    nodeVersion: "22.12.0",
    async resolveCommand(command) {
      const value = String(command).toLowerCase();
      if (value.includes("chrome.exe")) return command;
      if (value === "tmux.exe" || value === "tmux") return null;
      if (value === "psmux.exe") return "C:\\tools\\psmux.exe";
      if (value === "opencode.exe") return "C:\\tools\\opencode.exe";
      return command;
    },
    async execute(command) {
      if (/chrome\.exe/i.test(command)) {
        windowsChromeLaunches += 1;
        throw new Error("Windows Chrome probe must not launch the browser");
      }
      return { stdout: /psmux/i.test(command) ? "psmux 3.test\n" : `${basename(command)} 1.0.0\n`, stderr: "" };
    },
  });
  const windowsHealth = await windowsHealthService.snapshot();
  assert.equal(windowsChromeLaunches, 0);
  assert.equal(windowsHealth.components.find(item => item.id === "chrome").status, "ready");
  assert.equal(windowsHealth.components.find(item => item.id === "ttyd").status, "ready");
  assert.equal(windowsHealth.components.some(item => item.id === "tmux"), false);

  const noJoernHealthService = new EnvironmentHealthService({
    projectRoot: resolve(OPENCODE, ".."),
    configPaths: [healthConfig],
    environment: { PATH: fakeBin, OPENCODE_BIN: join(fakeBin, "opencode"), OPENGREP_BIN: join(fakeBin, "opengrep") },
    platform: "win32",
    architecture: "x64",
    nodeVersion: "22.12.0",
    async resolveCommand(command) {
      const value = String(command).toLowerCase();
      if (value.includes("joern") || value.endsWith("java") || value.endsWith("java.exe") || value.includes("gitleaks") || value.includes("osv-scanner")) return null;
      return command;
    },
    async execute(command) { return { stdout: `${basename(command)} 1.0.0\n`, stderr: "" }; },
  });
  const noJoernHealth = await noJoernHealthService.snapshot();
  assert.equal(noJoernHealth.capabilities.find(item => item.id === "static").status, "ready");
  assert.equal(noJoernHealth.capabilities.find(item => item.id === "deep_dataflow").status, "skipped");
  assert.equal(noJoernHealth.capabilities.find(item => item.id === "secret_scan").status, "skipped");

  const windowsMonitorCalls = [];
  const windowsMonitor = new OpenCodeTmuxMonitor({
    stateRoot: join(temp, "windows-psmux-state"),
    platform: "win32",
    environment: { PATH: "C:\\tools", PATHEXT: ".EXE" },
    async resolveCommand(command) {
      const value = String(command).toLowerCase();
      if (value === "opencode.exe") return "C:\\tools\\opencode.exe";
      if (value === "psmux.exe") return "C:\\tools\\psmux.exe";
      return null;
    },
    async execute(command, args) {
      windowsMonitorCalls.push({ command, args });
      if (/opencode\.exe$/i.test(command)) return { stdout: "--format --session --agent --dir --title\n", stderr: "" };
      if (/psmux\.exe$/i.test(command) && args[0] === "-V") return { stdout: "psmux 3.test\n", stderr: "" };
      throw new Error(`unexpected command: ${command}`);
    },
  });
  const windowsMonitorProbe = await windowsMonitor.probe();
  assert.equal(windowsMonitorProbe.available, true);
  assert.equal(windowsMonitorProbe.backend, "psmux");
  assert.equal(windowsMonitorProbe.opencode_command, "C:\\tools\\opencode.exe");
  assert.equal(windowsMonitorProbe.multiplexer_command, "C:\\tools\\psmux.exe");
  assert(windowsMonitorCalls.every(call => call.command !== "opencode" && call.command !== "tmux"));

  // A freshly restarted workbench may need to clean up persisted terminal
  // metadata before start() has populated the executable cache.  This must
  // probe lazily instead of calling execFile(null, ...).
  const lazyMonitorCalls = [];
  const lazyRestartMonitor = new OpenCodeTmuxMonitor({
    stateRoot: join(temp, "windows-psmux-lazy-restart-state"),
    platform: "win32",
    environment: { PATH: "C:\\tools", PATHEXT: ".EXE" },
    async resolveCommand(command) {
      const value = String(command).toLowerCase();
      if (value === "opencode.exe") return "C:\\tools\\opencode.exe";
      if (value === "psmux.exe") return "C:\\tools\\psmux.exe";
      return null;
    },
    async execute(command, args) {
      lazyMonitorCalls.push({ command, args });
      if (/opencode\.exe$/i.test(command)) return { stdout: "--format --session --agent --dir --title\n", stderr: "" };
      if (/psmux\.exe$/i.test(command) && args[0] === "-V") return { stdout: "psmux 3.test\n", stderr: "" };
      if (/psmux\.exe$/i.test(command) && args[2] === "kill-server") return { stdout: "", stderr: "" };
      throw new Error(`unexpected lazy restart command: ${command}`);
    },
  });
  await lazyRestartMonitor.stop({ socket_name: lazyRestartMonitor.socketName("audit-lazy-restart"), target: "audit:tui" });
  assert.equal(lazyRestartMonitor.tmuxCommand, "C:\\tools\\psmux.exe");
  assert.equal(lazyMonitorCalls.at(-1).command, "C:\\tools\\psmux.exe");
  assert.equal(lazyMonitorCalls.at(-1).args[2], "kill-server");

  const windowsStartCalls = [];
  const windowsStartMonitor = new OpenCodeTmuxMonitor({
    stateRoot: join(temp, "windows-psmux-start-state"),
    platform: "win32",
    environment: { PATH: "C:\\tools", PATHEXT: ".EXE" },
    async execute(command, args) {
      windowsStartCalls.push({ command, args });
      const operation = args[2];
      if (operation === "kill-server") return { stdout: "", stderr: "" };
      if (operation === "new-session") {
        const boundary = args.indexOf("--");
        assert(boundary > 0, `psmux ${operation} 缺少命令边界 --`);
        assert.equal(args[boundary + 1], process.execPath);
        return { stdout: "", stderr: "" };
      }
      if (operation === "capture-pane") return { stdout: "Windows psmux OpenCode TUI\n", stderr: "" };
      throw new Error(`unexpected psmux operation: ${operation}`);
    },
  });
  windowsStartMonitor.probeResult = {
    available: true,
    backend: "psmux",
    opencode_command: "C:\\tools\\opencode.exe",
    multiplexer_command: "C:\\tools\\psmux.exe",
  };
  windowsStartMonitor.command = "C:\\tools\\opencode.exe";
  windowsStartMonitor.tmuxCommand = "C:\\tools\\psmux.exe";
  windowsStartMonitor.multiplexerBackend = "psmux";
  const windowsTerminal = await windowsStartMonitor.start({
    audit: { id: "audit-windows-psmux", name: "Windows psmux 集成测试" },
    repository: { path: canonicalRepositoryRoot },
    executionDirectory: canonicalRepositoryRoot,
    environment: { http_proxy: "http://proxy-fixture.test:8080", HTTPS_PROXY: "http://secure-proxy-fixture.test:8443" },
    args: ["run", "--format", "json", "--agent", "security-audit-orchestrator", "--dir", canonicalRepositoryRoot, "--title", "Windows psmux 集成测试", "fixture prompt"],
  });
  assert.equal(windowsTerminal.backend, "psmux");
  assert.equal(windowsTerminal.provider_session_id, null);
  assert.equal(windowsStartCalls.filter(call => call.args[2] === "new-session").length, 1);
  const windowsRunSpec = JSON.parse(await readFile(join(temp, "windows-psmux-start-state", "audit-windows-psmux", "tmux-run.json"), "utf8"));
  assert.equal(windowsRunSpec.command, "C:\\tools\\opencode.exe");
  assert.equal(windowsRunSpec.args[0], "run");
  assert.equal(windowsRunSpec.args.includes("serve"), false);
  assert.equal(windowsRunSpec.environment.http_proxy, "http://proxy-fixture.test:8080");
  assert.equal(windowsRunSpec.environment.HTTPS_PROXY, "http://secure-proxy-fixture.test:8443");

  // psmux may create a valid OpenCode process before its pane exposes any
  // output.  That is not a launch failure and must not trigger the old 60-second
  // fallback to the unmonitored runner.
  const silentPsmuxMonitor = new OpenCodeTmuxMonitor({
    stateRoot: join(temp, "windows-psmux-silent-state"),
    platform: "win32",
    environment: { PATH: "C:\\tools", PATHEXT: ".EXE" },
    async execute(_command, args) {
      const operation = args[2];
      if (operation === "kill-server" || operation === "new-session") return { stdout: "", stderr: "" };
      if (operation === "capture-pane") return { stdout: "", stderr: "" };
      throw new Error(`unexpected silent psmux operation: ${operation}`);
    },
  });
  silentPsmuxMonitor.probeResult = { available: true, backend: "psmux", opencode_command: "C:\\tools\\opencode.exe", multiplexer_command: "C:\\tools\\psmux.exe" };
  silentPsmuxMonitor.command = "C:\\tools\\opencode.exe";
  silentPsmuxMonitor.tmuxCommand = "C:\\tools\\psmux.exe";
  silentPsmuxMonitor.multiplexerBackend = "psmux";
  const silentPsmuxTerminal = await Promise.race([
    silentPsmuxMonitor.start({
      audit: { id: "audit-windows-psmux-silent", name: "Windows psmux 静默启动测试" },
      repository: { path: canonicalRepositoryRoot },
      executionDirectory: canonicalRepositoryRoot,
      environment: {},
      args: ["run", "--format", "json", "--agent", "security-audit-orchestrator", "--dir", canonicalRepositoryRoot, "--title", "Windows psmux 静默启动测试", "fixture prompt"],
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("psmux 静默启动被输出门禁阻塞。")), 500)),
  ]);
  assert.equal(silentPsmuxTerminal.backend, "psmux");
  assert.match(silentPsmuxTerminal.message, /异步输出/);

  // Some psmux versions can report a successful but temporarily empty pane
  // capture. The launcher diagnostic stream remains the reliable fallback.
  const psmuxDiagnosticOutputPath = join(temp, "windows-psmux-diagnostic-output.jsonl");
  await writeFile(psmuxDiagnosticOutputPath, '{"type":"step_start","sessionID":"ses_psmux_diagnostic"}\n', "utf8");
  const psmuxDiagnosticMonitor = new OpenCodeTmuxMonitor({
    stateRoot: join(temp, "windows-psmux-diagnostic-state"),
    platform: "win32",
    async execute(_command, args) {
      assert.equal(args[2], "capture-pane");
      return { stdout: "", stderr: "" };
    },
  });
  psmuxDiagnosticMonitor.tmuxCommand = "C:\\tools\\psmux.exe";
  const psmuxDiagnosticOutput = await psmuxDiagnosticMonitor.capture({
    socket_name: "owa-0123456789abcdef",
    target: "audit:tui",
    output_path: psmuxDiagnosticOutputPath,
  });
  assert.match(psmuxDiagnosticOutput, /ses_psmux_diagnostic/);

  const findingWorkflowRoot = join(temp, "finding-workflow");
  const findingWorkflow = new FindingWorkflowStore({ stateRoot: findingWorkflowRoot });
  await findingWorkflow.ready;
  let findingResourceId;

  const server = createAuditWorkbenchServer({
    stateRoot,
    runtimeRoot,
    runner,
    dynamicRunner,
    environmentService,
    findingWorkflow,
    modelConfigPaths: [join(repositoryRoot, ".opencode", "opencode.json"), globalModelConfig],
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const workspaceResponse = await fetch(`${base}/api/v1/workspace`);
    assert.equal(workspaceResponse.status, 200);
    const workspace = await workspaceResponse.json();
    assert.equal(workspace.summary.finding_count, 1);
    assert.equal(workspace.audits[0].repository_id, "fixture");
    assert.equal(workspace.findings, undefined);
    const auditPage = await (await fetch(`${base}/api/v1/audits?tab=all`)).json();
    assert.equal(auditPage.page_size, 20);
    assert.equal(auditPage.count, workspace.audits.length);
    assert.equal(auditPage.items[0].stages, undefined);
    const compactWorkspace = await (await fetch(`${base}/api/v1/workspace?audits=compact`)).json();
    assert.equal(compactWorkspace.summary.audit_count, workspace.summary.audit_count);
    assert.ok(compactWorkspace.audits.length <= 6);
    assert.equal(compactWorkspace.audits[0].stages, undefined);
    const liveWorkspace = await (await fetch(`${base}/api/v1/workspace?audits=compact&live=1`)).json();
    assert.equal(liveWorkspace.summary.audit_count, compactWorkspace.summary.audit_count);
    const liveList = await (await fetch(`${base}/api/v1/audits?tab=all&live=1`)).json();
    assert.equal(liveList.count, auditPage.count);
    const auditDetail = await (await fetch(`${base}/api/v1/audits/${encodeURIComponent(auditPage.items[0].id)}`)).json();
    assert.ok(Array.isArray(auditDetail.stages));
    const matchingAudits = await (await fetch(`${base}/api/v1/audits?tab=all&q=${encodeURIComponent(auditDetail.id)}`)).json();
    assert.ok(matchingAudits.items.some(item => item.id === auditDetail.id));
    assert.equal((await fetch(`${base}/api/v1/audits?page_size=21`)).status, 422);
    const findingsResponse = await fetch(`${base}/api/v1/findings?page=1`);
    assert.equal(findingsResponse.status, 200);
    const findingsPage = await findingsResponse.json();
    assert.equal(findingsPage.page, 1);
    assert.equal(findingsPage.page_size, 50);
    assert.equal(findingsPage.total_pages, 1);
    assert.equal(findingsPage.count, 1);
    assert.match(findingsPage.items[0].resource_id, /^[a-f0-9]{24}$/);
    assert.equal(findingsPage.items[0].repository_id, "fixture");
    assert.equal(findingsPage.items[0].repository_name, "测试仓库");
    assert.equal(findingsPage.items[0].workflow.status, "unreviewed");
    assert.equal(findingsPage.items[0].workflow.version, 0);
    const repositoryResponse = await fetch(`${base}/api/v1/repositories`);
    assert.equal(repositoryResponse.status, 200);
    const repositoryPayload = await repositoryResponse.json();
    assert.equal(repositoryPayload.items[0].audit_count, 11);
    assert.equal(repositoryPayload.items[0].active_audit_count, 0);
    const relativeProjectResponse = await fetch(`${base}/api/v1/repositories`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "project-relative" },
      body: JSON.stringify({ path: "../relative-project" }),
    });
    assert.equal(relativeProjectResponse.status, 422);
    const projectResponse = await fetch(`${base}/api/v1/repositories`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "project-001" },
      body: JSON.stringify({ path: operatorSelectedRoot, name: "操作员指定项目" }),
    });
    assert.equal(projectResponse.status, 201);
    const selectedProject = await projectResponse.json();
    assert.match(selectedProject.id, /^project-[a-f0-9]{12}$/);
    assert.equal(selectedProject.name, "操作员指定项目");
    assert.equal(selectedProject.directory, canonicalOperatorSelectedRoot);
    assert.equal(selectedProject.configured, true);
    assert.equal(selectedProject.ready, true);
    assert.equal(selectedProject.removable, true);
    const duplicateProjectResponse = await fetch(`${base}/api/v1/repositories`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "project-002" },
      body: JSON.stringify({ path: operatorSelectedRoot, name: "另一个名称" }),
    });
    assert.equal(duplicateProjectResponse.status, 201);
    assert.equal((await duplicateProjectResponse.json()).id, selectedProject.id);
    const projectsAfterRegistration = await (await fetch(`${base}/api/v1/repositories`)).json();
    assert.equal(projectsAfterRegistration.count, 2);
    const invalidProjectDelete = await fetch(`${base}/api/v1/repositories/${selectedProject.id}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: "wrong-project" }),
    });
    assert.equal(invalidProjectDelete.status, 422);
    const projectDelete = await fetch(`${base}/api/v1/repositories/${selectedProject.id}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: selectedProject.id }),
    });
    assert.equal(projectDelete.status, 200);
    assert.deepEqual(await projectDelete.json(), { repository_id: selectedProject.id, deleted: true, source_directory_deleted: false, artifacts_deleted: false });
    assert.equal((await stat(operatorSelectedRoot)).isDirectory(), true);
    assert.equal((await (await fetch(`${base}/api/v1/repositories`)).json()).count, 1);
    const startupProjectDelete = await fetch(`${base}/api/v1/repositories/fixture`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: "fixture" }),
    });
    assert.equal(startupProjectDelete.status, 409);
    const restoredProjectResponse = await fetch(`${base}/api/v1/repositories`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "project-003" },
      body: JSON.stringify({ path: operatorSelectedRoot, name: "操作员指定项目" }),
    });
    assert.equal(restoredProjectResponse.status, 201);
    assert.equal((await restoredProjectResponse.json()).id, selectedProject.id);
    const historyReport = workspace.reports.find(item => item.audit_id === "audit-history");
    assert.match(historyReport.id, /^[a-f0-9]{24}$/);
    assert.notEqual(historyReport.id, snapshot.reports.find(item => item.audit_id === "audit-history").id);

    const environmentResponse = await fetch(`${base}/api/v1/environment`);
    assert.equal(environmentResponse.status, 200);
    const environment = await environmentResponse.json();
    assert.equal(environment.capabilities.find(item => item.id === "static").status, "ready");
    assert.equal(environment.components.find(item => item.id === "chrome").status, "ready");

    const modelSettingsResponse = await fetch(`${base}/api/v1/settings/model`);
    assert.equal(modelSettingsResponse.status, 200);
    const initialModelSettings = (await modelSettingsResponse.json()).model;
    assert.equal(initialModelSettings.selected_model, "default");
    assert.deepEqual(initialModelSettings.options.map(option => option.value), ["default", "global-provider/global-audit", "nested-provider/vendor/model-v2", "project-provider/project-default", "project-provider/project-review"]);
    const invalidModelSelection = await fetch(`${base}/api/v1/settings/model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "unconfigured/provider" }),
    });
    assert.equal(invalidModelSelection.status, 422);
    const saveModelSelection = await fetch(`${base}/api/v1/settings/model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "global-provider/global-audit" }),
    });
    assert.equal(saveModelSelection.status, 200);
    assert.equal((await saveModelSelection.json()).model.selected_model, "global-provider/global-audit");

    findingResourceId = findingsPage.items[0].resource_id;
    const workflowResponse = await fetch(`${base}/api/v1/findings/${findingResourceId}/workflow`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "If-Match": '"0"', "Idempotency-Key": "finding-workflow-001" },
      body: JSON.stringify({ status: "confirmed", note: "Owner 已确认该权限校验缺失。" }),
    });
    assert.equal(workflowResponse.status, 200, await workflowResponse.clone().text());
    const workflow = await workflowResponse.json();
    assert.equal(workflow.status, "confirmed");
    assert.equal(workflow.note, "Owner 已确认该权限校验缺失。");
    assert.equal(workflow.version, 1);
    assert.equal(workflow.idempotency_records, undefined);
    assert.equal(workflowResponse.headers.get("etag"), '"1"');
    const findingsAfterWorkflow = await (await fetch(`${base}/api/v1/findings?page=1`)).json();
    assert.equal(findingsAfterWorkflow.items[0].workflow.status, "confirmed");
    const staleWorkflowResponse = await fetch(`${base}/api/v1/findings/${findingResourceId}/workflow`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "If-Match": '"0"', "Idempotency-Key": "finding-workflow-stale" },
      body: JSON.stringify({ status: "rejected", note: "stale" }),
    });
    assert.equal(staleWorkflowResponse.status, 412);
    const conflictingWorkflowResponse = await fetch(`${base}/api/v1/findings/${findingResourceId}/workflow`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "If-Match": '"1"', "Idempotency-Key": "finding-workflow-001" },
      body: JSON.stringify({ status: "rejected", note: "同一幂等键不得改变操作。" }),
    });
    assert.equal(conflictingWorkflowResponse.status, 409);
    const invalidWorkflowResponse = await fetch(`${base}/api/v1/findings/${findingResourceId}/workflow`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "If-Match": '"1"', "Idempotency-Key": "finding-workflow-invalid" },
      body: JSON.stringify({ status: "arbitrary", note: "invalid" }),
    });
    assert.equal(invalidWorkflowResponse.status, 422);

    const reportResponse = await fetch(`${base}/api/v1/reports/${historyReport.id}`);
    assert.equal(reportResponse.status, 200);
    const report = await reportResponse.json();
    assert.match(report.body, /^# 安全审计报告/);
    assert.equal(report.rendering, "markdown-it-html-disabled");
    assert.match(report.rendered_html, /<h1>安全审计报告<\/h1>/);
    assert.match(report.rendered_html, /<table>/);
    assert.doesNotMatch(report.rendered_html, /<script>/i);
    assert.doesNotMatch(report.rendered_html, /href=["']javascript:/i);
    assert.equal(Object.hasOwn(report, "sha256"), false);
    assert.equal(Object.hasOwn(report, "integrity_state"), false);
    const reportDownload = await fetch(`${base}/api/v1/reports/${historyReport.id}/download`);
    assert.equal(reportDownload.status, 200);
    assert.match(reportDownload.headers.get("content-disposition"), /security-audit-report\.audit-history\.md/);
    assert.equal(await reportDownload.text(), report.body);
    const updatedReportBody = `${report.body}\n报告读取回归标记\n`;
    const historyReportPath = join(reportsRoot, historyReport.path);
    await writeFile(historyReportPath, updatedReportBody, "utf8");
    try {
      const updatedPreview = await fetch(`${base}/api/v1/reports/${historyReport.id}`);
      assert.equal(updatedPreview.status, 200);
      assert.equal((await updatedPreview.json()).body, updatedReportBody);
      const updatedDownload = await fetch(`${base}/api/v1/reports/${historyReport.id}/download`);
      assert.equal(updatedDownload.status, 200);
      assert.equal(await updatedDownload.text(), updatedReportBody);
    } finally {
      await writeFile(historyReportPath, report.body, "utf8");
    }
    assert.equal((await fetch(`${base}/api/v1/reports/not-found`)).status, 404);

    const originalCreateAudit = runner.createAudit;
    try {
      runner.createAudit = async input => ({ id: "model-selection-probe", version: 1, model: input.model });
      for (const [input, expected] of [
        [{}, "global-provider/global-audit"],
        [{ model: "default" }, null],
        [{ model: null }, null],
        [{ model: "project-provider/project-review" }, "project-provider/project-review"],
      ]) {
        const selected = await fetch(`${base}/api/v1/audits`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": "model-selection-probe" },
          body: JSON.stringify(input),
        });
        assert.equal(selected.status, 202);
        assert.equal((await selected.json()).model, expected);
      }
    } finally {
      runner.createAudit = originalCreateAudit;
    }

    for (const model of ["unconfigured/provider", "--model injected"]) {
      const rejected = await fetch(`${base}/api/v1/audits`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": `invalid-model-${model}` },
        body: JSON.stringify({ repository_id: "fixture", model }),
      });
      assert.equal(rejected.status, 422);
    }

    const createResponse = await fetch(`${base}/api/v1/audits`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "request-001" },
      body: JSON.stringify({
        audit_id: "audit-live-001",
        name: "发布前安全审计; touch /tmp/never",
        repository_id: "fixture",
        ref: "HEAD",
        allow_dirty: true,
        model: "project-provider/project-review",
        additional_instructions_enabled: true,
        additional_instructions: "只验证 XSS 漏洞；其他类型只记录静态证据。",
        test_environment_enabled: true,
        test_environment_context: "URL: http://127.0.0.1:8080\nAttacker: attacker-fixture / context-attacker-secret\nVictim: victim-fixture / context-victim-secret",
      }),
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    assert.equal(created.id, "audit-live-001");
    assert.equal(created.model, "project-provider/project-review");
    assert.equal(created.idempotency_digest, undefined);
    assert.equal(created.private_context, undefined);
    assert.equal(created.task_context.additional_instructions_enabled, true);
    assert.equal(created.task_context.test_environment_enabled, true);
    assert.equal(created.task_context.dynamic_validation_enabled, true);
    assert.equal(JSON.stringify(created).includes("context-attacker-secret"), false);
    assert.equal(JSON.stringify(created).includes("proxy-fixture.test"), false);

    for (let attempt = 0; attempt < 100 && runner.getAudit(created.id)?.status !== "running"; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(runner.getAudit(created.id).status, "running");
    assert.equal(spawnCall.command, process.execPath);
    assert.equal(spawnCall.options.shell, false);
    const executionWorkspace = join(platformRoot, "workspace", "audit-runs", created.id);
    assert.equal(spawnCall.options.cwd, executionWorkspace);
    assert.equal(spawnCall.options.env.OPENCODE_CONFIG, join(canonicalRepositoryRoot, ".opencode", "opencode.json"));
    assert.equal(spawnCall.options.env.OPENCODE_CONFIG_DIR, join(canonicalRepositoryRoot, ".opencode"));
    assert.equal(spawnCall.options.env.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
    assert.equal(spawnCall.options.env.AUDIT_KNOWLEDGE_ROOT, resolve(platformRoot, "../KnowledgeWorkFlow"));
    assert.equal(spawnCall.options.env.AUDIT_KNOWLEDGE_CLI, join(executionWorkspace, ".opencode/scripts/knowledge-query.mjs"));
    assert.equal(typeof spawnCall.options.env.OPENCODE_CONFIG_CONTENT, "string");
    const runtimeOpenCodeConfig = JSON.parse(spawnCall.options.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(Object.hasOwn(runtimeOpenCodeConfig.mcp, "coverage_ledger"), false);
    assert.equal(runtimeOpenCodeConfig.subagent_depth, 2);
    assert.ok(runtimeOpenCodeConfig.plugin.some(entry => typeof entry === "string" && entry.endsWith("/lib/focus-area-watchdog-plugin.mjs")), "禁用项目配置时仍须加载 Focus Area watchdog 工具结果钩子");
    assert.match(spawnCall.args[0], /terminal-output-relay\.mjs$/);
    const monitoredRunArgs = terminalMonitor.starts[0].args;
    assert.deepEqual(monitoredRunArgs.slice(0, 3), ["run", "--format", "json"]);
    assert.equal(monitoredRunArgs[monitoredRunArgs.indexOf("--model") + 1], "project-provider/project-review");
    assert.equal(monitoredRunArgs[monitoredRunArgs.indexOf("--agent") + 1], "security-audit-orchestrator");
    assert.equal(monitoredRunArgs[monitoredRunArgs.indexOf("--dir") + 1], executionWorkspace);
    const monitoredPrompt = monitoredRunArgs.at(-1);
    assert.match(monitoredPrompt, /audit-live-001/);
    assert.match(monitoredPrompt, new RegExp(canonicalRepositoryRoot.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(monitoredPrompt, /源码根目录必须只读/);
    assert.match(monitoredPrompt, /AUDIT_KNOWLEDGE_CLI/);
    assert.match(monitoredPrompt, /blind 轨道不查询、不接收知识种子/);
    assert.match(monitoredPrompt, /唯一的持久交付根目录/);
    assert.equal(monitoredPrompt.includes(reportsRoot), true);
    assert.equal(monitoredPrompt.includes(join(reportsRoot, "final", `security-audit-report.${created.id}.md`)), true);
    assert.match(monitoredPrompt, /每报告 180 秒快速动态确认/);
    assert.match(monitoredPrompt, /完整动态验证仍只允许用户在工作台手动点击/);
    assert.match(monitoredPrompt, /不得调用 question 工具/);
    assert.match(monitoredPrompt, /additional-instructions\.txt/);
    assert.match(monitoredPrompt, /test-environment\.txt/);
    assert.equal(monitoredPrompt.includes("context-attacker-secret"), false);
    assert.equal(spawnCall.options.env.AUDIT_QUICK_DYNAMIC_ENABLED, "true");
    assert.equal(spawnCall.options.env.AUDIT_QUICK_DYNAMIC_DEADLINE_SECONDS, "180");
    assert.equal(spawnCall.options.env.AUDIT_QUICK_DYNAMIC_SETUP_SECONDS, "240");
    assert.equal(spawnCall.options.env.AUDIT_FULL_DYNAMIC_TRIGGER, "MANUAL_ONLY");
    assert.equal(spawnCall.options.env.http_proxy, "http://proxy-fixture.test:8080");
    assert.equal(spawnCall.options.env.HTTPS_PROXY, "http://secure-proxy-fixture.test:8443");
    assert.equal(terminalMonitor.starts[0].environment.http_proxy, "http://proxy-fixture.test:8080");
    assert.equal(terminalMonitor.starts[0].environment.HTTPS_PROXY, "http://secure-proxy-fixture.test:8443");
    assert.match(spawnCall.options.env.AUDIT_TEST_ENVIRONMENT_CONTEXT_SHA256, /^[a-f0-9]{64}$/);
    const additionalContextPath = join(stateRoot, created.id, "additional-instructions.txt");
    const testEnvironmentContextPath = join(stateRoot, created.id, "test-environment.txt");
    assert.match(await readFile(additionalContextPath, "utf8"), /只验证 XSS 漏洞/);
    assert.match(await readFile(testEnvironmentContextPath, "utf8"), /context-attacker-secret/);
    assert.equal((await stat(additionalContextPath)).mode & 0o077, 0);
    assert.equal((await stat(testEnvironmentContextPath)).mode & 0o077, 0);
    const originalEnvironmentContext = await readFile(testEnvironmentContextPath);
    await writeFile(testEnvironmentContextPath, "tampered-context\n", "utf8");
    assert.equal((await runner.dynamicValidationPolicy(created.id, "fixture")).enabled, false);
    await writeFile(testEnvironmentContextPath, originalEnvironmentContext);
    assert.equal((await runner.dynamicValidationPolicy(created.id, "fixture")).enabled, true);
    const persistedAuditState = await readFile(join(stateRoot, created.id, "run.json"), "utf8");
    assert.equal(persistedAuditState.includes("context-attacker-secret"), false);
    assert.equal(persistedAuditState.includes("context-victim-secret"), false);
    assert.equal(persistedAuditState.includes("proxy-fixture.test"), false);
    const proxyEnvironmentPath = join(stateRoot, created.id, "proxy-environment.json");
    assert.match(await readFile(proxyEnvironmentPath, "utf8"), /proxy-fixture\.test/);
    assert.equal((await stat(proxyEnvironmentPath)).mode & 0o077, 0);
    assert.equal(spawnCall.options.env.AUDIT_SOURCE_ROOT, canonicalRepositoryRoot);
    assert.equal(spawnCall.options.env.AUDIT_WORKSPACE_ROOT, executionWorkspace);
    assert.equal(spawnCall.options.env.AUDIT_REPORTS_ROOT, reportsRoot);
    assert.equal(spawnCall.options.env.AUDIT_TMP_ROOT, join(platformRoot, "tmp", "repositories", "fixture"));
    assert.equal(terminalMonitor.starts[0].executionDirectory, executionWorkspace);
    await assert.rejects(stat(join(executionWorkspace, "source")), error => error.code === "ENOENT");
    assert.equal(await realpath(join(executionWorkspace, "reports")), await realpath(reportsRoot));
    assert.equal(await realpath(join(executionWorkspace, "tmp")), await realpath(join(platformRoot, "tmp", "repositories", "fixture")));
    await assert.rejects(stat(join(canonicalRepositoryRoot, "reports")), error => error.code === "ENOENT");
    await assert.rejects(stat(join(canonicalRepositoryRoot, "tmp")), error => error.code === "ENOENT");
    assert.equal(runner.getAudit(created.id).execution_transport, "opencode-run+terminal-multiplexer");
    assert.equal(runner.getAudit(created.id).terminal.live, true);

    const productPage = await (await fetch(`${base}/api/v2/products/product-undefined/audits?tab=all&live=1`)).json();
    assert.ok(productPage.items.some(item => item.id === created.id));
    for (const item of productPage.items) {
      assert.equal(typeof item.stage, "string");
      assert.ok(Number.isFinite(item.progress));
      assert.ok(Number.isFinite(item.finding_count));
    }
    const productDetail = await (await fetch(`${base}/api/v2/products/product-undefined/audits/${encodeURIComponent(created.id)}?live=1`)).json();
    const productSummary = await (await fetch(`${base}/api/v1/audits/${encodeURIComponent(created.id)}?live=1`)).json();
    assert.deepEqual(productDetail.stages, productSummary.stages);
    assert.equal(productDetail.progress, productSummary.progress);
    assert.equal(productDetail.finding_count, productSummary.finding_count);

    const activeDeleteResponse = await fetch(`${base}/api/v1/audits/${created.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "If-Match": `"${runner.getAudit(created.id).version}"` },
      body: JSON.stringify({ confirmation: created.id }),
    });
    assert.equal(activeDeleteResponse.status, 409);
    assert.equal((await activeDeleteResponse.json()).error, "audit-delete-active");

    terminalMonitor.output += "\ncontext-attacker-secret";
    const terminalResponse = await fetch(`${base}/api/v1/audits/${created.id}/terminal`);
    assert.equal(terminalResponse.status, 200);
    const terminalPayload = await terminalResponse.json();
    assert.equal(terminalPayload.live, true);
    assert.equal(terminalPayload.target, "audit:tui");
    assert.match(terminalPayload.output, /OpenCode TUI fixture/);
    assert.equal(terminalPayload.output.includes("context-attacker-secret"), false);
    assert.match(terminalPayload.output, /PRIVATE_CONTEXT_REDACTED/);
    assert.match(terminalPayload.attach_command, /^tmux -L owa-/);
    assert.match(terminalPayload.attach_command, /attach-session -r -t audit:tui$/);
    assert.equal(terminalPayload.provider_session_id, `ses_${created.id}`);
    assert.equal(terminalPayload.opencode_command, `opencode -s ses_${created.id}`);
    const resizeResponse = await fetch(`${base}/api/v1/audits/${created.id}/terminal/resize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns: 164, rows: 40 }),
    });
    assert.equal(resizeResponse.status, 200);
    const resizedTerminal = await resizeResponse.json();
    assert.equal(resizedTerminal.columns, 164);
    assert.equal(resizedTerminal.rows, 40);
    assert.deepEqual(terminalMonitor.resizeCalls.map(({ columns, rows }) => ({ columns, rows })), [{ columns: 164, rows: 40 }]);
    const invalidResizeResponse = await fetch(`${base}/api/v1/audits/${created.id}/terminal/resize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns: 9999, rows: 1 }),
    });
    assert.equal(invalidResizeResponse.status, 422);
    assert.equal((await invalidResizeResponse.json()).error, "terminal-size-invalid");

    child.stdout.write('{"type":"agent.progress","token":"must-not-leak"}\n');
    child.stdout.write('{"type":"agent.progress","message":"context-attacker-secret"}\n');
    for (let attempt = 0; attempt < 20 && (await runner.eventsSince(created.id)).length < 4; attempt += 1) await new Promise(resolve => setImmediate(resolve));
    const events = await runner.eventsSince(created.id);
    assert.equal(events.some(event => JSON.stringify(event).includes("must-not-leak")), false);
    assert.equal(events.some(event => JSON.stringify(event).includes("context-attacker-secret")), false);
    assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1));
    const logResponse = await fetch(`${base}/api/v1/audits/${created.id}/logs?limit=20`);
    assert.equal(logResponse.status, 200);
    const parsedLogPayload = await logResponse.json();
    const logPayload = JSON.stringify(parsedLogPayload);
    assert.equal(logPayload.includes("must-not-leak"), false);
    assert.equal(logPayload.includes("context-attacker-secret"), false);
    assert.match(logPayload, /PRIVATE_CONTEXT_REDACTED/);
    assert.equal(parsedLogPayload.items.every(item => typeof item.kind === "string" && typeof item.label === "string"), true);
    assert.equal(parsedLogPayload.items.every(item => item.message === undefined), true);

    const retryDraftPath = `/api/v2/products/product-undefined/audits/${created.id}/retry-draft`;
    const readRetryDraft = (headers = {}) => fetch(`${base}${retryDraftPath}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}",
    });
    const retryDraftResponse = await readRetryDraft();
    assert.equal(retryDraftResponse.status, 200);
    assert.equal(retryDraftResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await retryDraftResponse.json(), {
      memory_mode: 'full',
      additional_instructions_enabled: true,
      additional_instructions: "只验证 XSS 漏洞；其他类型只记录静态证据。",
      test_environment_enabled: true,
      test_environment_context: "URL: http://127.0.0.1:8080\nAttacker: attacker-fixture / context-attacker-secret\nVictim: victim-fixture / context-victim-secret",
    });
    assert.equal((await fetch(`${base}${retryDraftPath}`)).status, 404);
    assert.equal((await readRetryDraft({ Origin: "https://unrelated.example" })).status, 403);
    assert.equal((await readRetryDraft({ "Content-Type": "text/plain" })).status, 415);
    const unrelatedProduct = await server.productStore.createProduct({ name: "重试上下文隔离测试" });
    assert.equal((await fetch(`${base}/api/v2/products/${unrelatedProduct.id}/audits/${created.id}/retry-draft`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    })).status, 404);
    const privateEnvironment = runner.audits.get(created.id).private_context.test_environment;
    const originalDigest = privateEnvironment.sha256;
    try {
      privateEnvironment.sha256 = "0".repeat(64);
      const invalidDraft = await readRetryDraft();
      assert.equal(invalidDraft.status, 409);
      assert.equal((await invalidDraft.text()).includes("context-attacker-secret"), false);
    } finally { privateEnvironment.sha256 = originalDigest; }
    const environmentFile = join(stateRoot, created.id, privateEnvironment.file_name);
    const environmentBytes = await readFile(environmentFile);
    try {
      await rm(environmentFile);
      assert.equal((await readRetryDraft()).status, 409);
    } finally { await writeFile(environmentFile, environmentBytes, { mode: 0o600 }); }
    const publicDetail = await (await fetch(`${base}/api/v2/products/product-undefined/audits/${created.id}`)).text();
    assert.equal(publicDetail.includes("context-attacker-secret"), false);

    const duplicateResponse = await fetch(`${base}/api/v1/audits`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "request-001" },
      body: JSON.stringify({ audit_id: "audit-other-id", repository_id: "fixture", ref: "HEAD" }),
    });
    assert.equal(duplicateResponse.status, 202);
    assert.equal((await duplicateResponse.json()).id, "audit-live-001");

    const requestListResponse = await fetch(`${base}/api/v1/validation-requests`);
    assert.equal(requestListResponse.status, 200);
    const requestList = await requestListResponse.json();
    assert.equal(requestList.count, 1);
    assert.equal(requestList.items[0].dispatch_ready, false);
    assert.equal(requestList.items[0].audit_managed, false);
    assert.equal(requestList.items[0].task_test_environment_preconfigured, false);
    assert.equal(requestList.items[0].artifact_dispatch_ready, true);

    const enabledValidationAuditRoot = join(runtimeRoot, created.id);
    await mkdir(enabledValidationAuditRoot, { recursive: true });
    const enabledValidationRequest = buildWebXssRuntimeRequest(fixtureCommit, { auditId: created.id });
    const enabledRequestPath = join(enabledValidationAuditRoot, "request.json");
    const enabledRequestBytes = `${JSON.stringify(enabledValidationRequest, null, 2)}\n`;
    await writeFile(enabledRequestPath, enabledRequestBytes, "utf8");
    const initialEnvironmentMetadata = runner.audits.get(created.id).private_context.test_environment;
    runner.audits.get(created.id).private_context.test_environment = {
      enabled: false, file_name: null, sha256: null, byte_length: 0, character_length: 0,
    };
    const enabledValidationRequestId = `${created.id}::FIND-WEB-XSS-001`;
    const enabledRequestList = await (await fetch(`${base}/api/v1/validation-requests`)).json();
    const enabledDescriptor = enabledRequestList.items.find(item => item.id === enabledValidationRequestId);
    assert.equal(enabledRequestList.count, 2);
    assert.equal(enabledDescriptor.dispatch_ready, true);
    assert.equal(enabledDescriptor.envelope_path, null);
    assert.equal(enabledDescriptor.audit_managed, true);
    assert.equal(enabledDescriptor.task_test_environment_preconfigured, false);
    runner.audits.get(created.id).private_context.test_environment = initialEnvironmentMetadata;

    const remoteValidationResponse = await fetch(`${base}/api/v1/validations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "dynamic-remote" },
      body: JSON.stringify({
        validation_request_id: enabledValidationRequestId,
        repository_id: "fixture",
        target_base_url: "https://example.com",
        attacker_account: { username: "attacker", password: "secret-a" },
        victim_account: { username: "victim", password: "secret-b" },
        login_instructions: "测试登录。",
        cleanup_instructions: "删除测试数据。",
        explicit_authorization: true,
        test_environment: true,
      }),
    });
    const remoteValidationBody = await remoteValidationResponse.clone().json();
    assert.equal(remoteValidationResponse.status, 422, JSON.stringify(remoteValidationBody));
    assert.equal(dynamicSpawnCall, null);

    const validationResponse = await fetch(`${base}/api/v1/validations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "dynamic-001" },
      body: JSON.stringify({
        validation_request_id: enabledValidationRequestId,
        repository_id: "fixture",
        target_base_url: "http://127.0.0.1:8080/profile",
        attacker_account: { username: "attacker-fixture", password: "attacker-secret-value" },
        victim_account: { username: "victim-fixture", password: "victim-secret-value" },
        login_instructions: "通过测试登录页输入账号密码并确认进入 profile 页面。",
        cleanup_instructions: "通过 profile 页面清空测试 display name 并刷新确认。",
        explicit_authorization: true,
        test_environment: true,
      }),
    });
    assert.equal(validationResponse.status, 202, JSON.stringify(await validationResponse.clone().json()));
    const startedValidation = await validationResponse.clone().json();
    const dynamicJobId = startedValidation.id;
    assert.equal(startedValidation.idempotency_digest, undefined);
    assert.match(dynamicJobId, /^[a-f0-9]{24}$/);
    assert.notEqual(dynamicJobId, enabledValidationRequestId);
    for (let attempt = 0; attempt < 100 && dynamicRunner.getRun(dynamicJobId)?.status !== "running"; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(dynamicRunner.getRun(dynamicJobId).status, "running");
    const activeValidationRequests = await (await fetch(`${base}/api/v1/validation-requests`)).json();
    const activeValidationDescriptor = activeValidationRequests.items.find(item => item.id === enabledValidationRequestId);
    assert.equal(activeValidationDescriptor.job_id, dynamicJobId);
    assert.equal(activeValidationDescriptor.job.id, dynamicJobId);
    assert.equal(dynamicSpawnCall.command, "opencode");
    assert.equal(dynamicSpawnCall.options.shell, false);
    assert.equal(dynamicSpawnCall.args[1], "请读取所附授权说明并严格按 dynamic-vulnerability-validator 契约执行。");
    assert.equal(dynamicSpawnCall.args[dynamicSpawnCall.args.indexOf("--agent") + 1], "dynamic-vulnerability-validator");
    assert.equal(dynamicSpawnCall.args[dynamicSpawnCall.args.indexOf("--model") + 1], "project-provider/project-review");
    const dynamicExecutionWorkspace = join(platformRoot, "workspace", "audit-runs", created.id);
    assert.equal(dynamicSpawnCall.options.cwd, dynamicExecutionWorkspace);
    assert.equal(dynamicSpawnCall.args[dynamicSpawnCall.args.indexOf("--dir") + 1], dynamicExecutionWorkspace);
    assert.equal(dynamicSpawnCall.options.env.AUDIT_SOURCE_ROOT, canonicalRepositoryRoot);
    assert.equal(dynamicSpawnCall.options.env.AUDIT_REPORTS_ROOT, reportsRoot);
    assert.equal(dynamicSpawnCall.options.env.XDG_DATA_HOME, process.env.XDG_DATA_HOME);
    assert.equal(dynamicSpawnCall.options.env.XDG_STATE_HOME, process.env.XDG_STATE_HOME);
    assert.equal(JSON.stringify(dynamicSpawnCall.args).includes("attacker-secret-value"), false);
    assert.equal(JSON.stringify(dynamicSpawnCall.args).includes("victim-secret-value"), false);
    const authorizationFile = dynamicSpawnCall.args[dynamicSpawnCall.args.indexOf("--file") + 1];
    assert.equal(dynamicSpawnCall.args.at(-1), authorizationFile);
    assert.match(await readFile(authorizationFile, "utf8"), /attacker-secret-value/);
    assert.equal((await stat(authorizationFile)).mode & 0o077, 0);
    const materializedEnvelope = JSON.parse(await readFile(join(enabledValidationAuditRoot, "FIND-WEB-XSS-001.envelope-input.json"), "utf8"));
    assert.equal(materializedEnvelope.payload.explicit_user_request, true);
    assert.equal(materializedEnvelope.payload.attacker_account_supplied, true);
    assert.equal(materializedEnvelope.payload.victim_account_supplied, true);
    assert.equal(materializedEnvelope.payload.localhost_target, "http://127.0.0.1:8080");
    dynamicChild.stdout.write('{"type":"step_start","sessionID":"ses_dynamicfixture001","part":{"sessionID":"ses_dynamicfixture001"}}\n');
    dynamicChild.stdout.write('{"password":"attacker-secret-value","token":"victim-secret-value"}\n');
    await writeFile(join(enabledValidationAuditRoot, "FIND-WEB-XSS-001.result.json"), "{}\n", "utf8");
    dynamicChild.emit("close", 0, null);
    const cleanupDeadline = Date.now() + 5000;
    while (dynamicRunner.getRun(dynamicJobId)?.ephemeral_cleanup !== "SUCCEEDED" && Date.now() < cleanupDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(dynamicRunner.getRun(dynamicJobId).status, "completed");
    assert.equal(dynamicRunner.getRun(dynamicJobId).ephemeral_cleanup, "SUCCEEDED");
    assert.equal(dynamicRunner.getRun(dynamicJobId).result_validation, "PASSED");
    assert.equal(dynamicRunner.getRun(dynamicJobId).provider_session_id, "ses_dynamicfixture001");
    const dynamicLog = await readFile(join(dynamicRunner.directory(dynamicJobId), "runner.log.jsonl"), "utf8");
    assert.equal(dynamicLog.includes("attacker-secret-value"), false);
    assert.equal(dynamicLog.includes("victim-secret-value"), false);
    assert.equal(dynamicRunner.health().persistent_opencode_sessions, true);
    assert.equal(dynamicRunner.health().ephemeral_authorization_files, true);
    const validationRunsResponse = await fetch(`${base}/api/runs`);
    assert.equal(validationRunsResponse.status, 200);
    const validationRuns = await validationRunsResponse.json();
    assert.equal(validationRuns.count, 1);
    assert.match(validationRuns.runs[0].resource_id, /^[a-f0-9]{24}$/);
    assert.equal(validationRuns.runs[0].repository_id, "fixture");
    const validationDetailResponse = await fetch(`${base}/api/runs/${validationRuns.runs[0].resource_id}`);
    assert.equal(validationDetailResponse.status, 200);
    const validationDetail = await validationDetailResponse.json();
    assert.equal(validationDetail.run.repository_id, "fixture");
    assert.equal(validationDetail.run.id, enabledValidationRequestId);
    await assert.rejects(stat(join(canonicalRepositoryRoot, "reports")), error => error.code === "ENOENT");
    await assert.rejects(stat(join(canonicalRepositoryRoot, "tmp")), error => error.code === "ENOENT");
    assert.equal((await runner.listRepositories())[0].dirty, false);

    const crossOriginResponse = await fetch(`${base}/api/v1/audits`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "cross-origin", Origin: "https://attacker.invalid" },
      body: JSON.stringify({ audit_id: "audit-cross-origin", repository_id: "fixture", ref: "HEAD" }),
    });
    assert.equal(crossOriginResponse.status, 403);

    const running = runner.getAudit(created.id);
    const pauseResponse = await fetch(`${base}/api/v1/audits/${created.id}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "If-Match": `"${running.version}"`, "Idempotency-Key": "pause-001" },
      body: JSON.stringify({ action: "pause" }),
    });
    assert.equal(pauseResponse.status, 202);
    assert.equal(child.signals.at(-1), "SIGSTOP");
    assert.equal(terminalMonitor.signals.at(-1), "SIGSTOP");

    const paused = runner.getAudit(created.id);
    const resumeResponse = await fetch(`${base}/api/v1/audits/${created.id}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "If-Match": `"${paused.version}"`, "Idempotency-Key": "resume-001" },
      body: JSON.stringify({ action: "resume" }),
    });
    assert.equal(resumeResponse.status, 202);
    assert.equal(child.signals.at(-1), "SIGCONT");
    assert.equal(terminalMonitor.signals.at(-1), "SIGCONT");

    const resumed = runner.getAudit(created.id);
    const cancelResponse = await fetch(`${base}/api/v1/audits/${created.id}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "If-Match": `"${resumed.version}"`, "Idempotency-Key": "cancel-001" },
      body: JSON.stringify({ action: "cancel" }),
    });
    assert.equal(cancelResponse.status, 202);
    assert.equal(child.signals.at(-1), "SIGTERM");
    assert.equal(terminalMonitor.abortCalls.length, 1);
    for (let attempt = 0; attempt < 50 && runner.getAudit(created.id)?.status !== "cancelled"; attempt += 1) await new Promise(resolve => setImmediate(resolve));
    assert.equal(runner.getAudit(created.id).status, "cancelled");
    const liveCancelled = await (await fetch(`${base}/api/v1/audits/${created.id}?live=1`)).json();
    assert.equal(liveCancelled.status, "cancelled");
    assert.equal(liveCancelled.version, runner.getAudit(created.id).version);
    assert.equal(runner.getAudit(created.id).terminal.status, "archived");
    assert.equal(terminalMonitor.stopCalls, 1);
    const archivedTerminal = await (await fetch(`${base}/api/v1/audits/${created.id}/terminal`)).json();
    assert.equal(archivedTerminal.live, false);
    assert.equal(archivedTerminal.available, true);
    assert.equal(archivedTerminal.attach_command, null);
    assert.equal(archivedTerminal.provider_session_id, `ses_${created.id}`);
    assert.equal(archivedTerminal.opencode_command, `opencode -s ses_${created.id}`);
    assert.match(archivedTerminal.output, /security-audit-orchestrator is running/);

    const auditTmpRoot = join(platformRoot, "tmp", "repositories", "fixture", created.id);
    const ownedArtifact = join(reportsRoot, "coverage", `coverage-summary.${created.id}.json`);
    const unrelatedArtifact = join(reportsRoot, "coverage", "coverage-summary.audit-keep.json");
    await mkdir(auditTmpRoot, { recursive: true });
    await writeFile(join(auditTmpRoot, "scanner-output.json"), "{}\n", "utf8");
    await writeFile(ownedArtifact, `${JSON.stringify({ audit_id: created.id, coverage_status: "INCOMPLETE" })}\n`, "utf8");
    await writeFile(unrelatedArtifact, `${JSON.stringify({ audit_id: "audit-keep", coverage_status: "INCOMPLETE" })}\n`, "utf8");
    const ownedArtifacts = (await buildWorkspaceSnapshot({ reportsRoot })).artifacts.filter(artifact => artifact.audit_id === created.id);
    assert(ownedArtifacts.some(artifact => join(reportsRoot, artifact.path) === ownedArtifact));
    const cancelledAudit = runner.getAudit(created.id);
    const invalidDeleteResponse = await fetch(`${base}/api/v1/audits/${created.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "If-Match": `"${cancelledAudit.version}"` },
      body: JSON.stringify({ confirmation: "wrong-audit-id" }),
    });
    assert.equal(invalidDeleteResponse.status, 422);
    const deleteResponse = await fetch(`${base}/api/v1/audits/${created.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "If-Match": `"${cancelledAudit.version}"` },
      body: JSON.stringify({ confirmation: created.id }),
    });
    assert.equal(deleteResponse.status, 200, JSON.stringify(await deleteResponse.clone().json()));
    const deletedAudit = await deleteResponse.json();
    assert.equal(deletedAudit.deleted, true);
    assert.equal(deletedAudit.removed_artifact_files, ownedArtifacts.length);
    for (const artifact of ownedArtifacts) await assert.rejects(stat(join(reportsRoot, artifact.path)), error => error.code === "ENOENT");
    assert.equal(deletedAudit.removed_runner_state, true);
    assert.equal(runner.getAudit(created.id), null);
    await assert.rejects(stat(join(stateRoot, created.id)), error => error.code === "ENOENT");
    await assert.rejects(stat(executionWorkspace), error => error.code === "ENOENT");
    await assert.rejects(stat(auditTmpRoot), error => error.code === "ENOENT");
    await assert.rejects(stat(ownedArtifact), error => error.code === "ENOENT");
    assert.equal((await stat(unrelatedArtifact)).isFile(), true);
    assert.equal((await fetch(`${base}/api/v1/audits/${created.id}`)).status, 404);

    const artifactOnlyAudit = (await (await fetch(`${base}/api/v1/workspace`)).json()).audits.find(item => item.id === "audit-history");
    const artifactOnlyDeleteResponse = await fetch(`${base}/api/v1/audits/audit-history`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "If-Match": `"${artifactOnlyAudit.version}"` },
      body: JSON.stringify({ confirmation: "audit-history" }),
    });
    assert.equal(artifactOnlyDeleteResponse.status, 200, JSON.stringify(await artifactOnlyDeleteResponse.clone().json()));
    const artifactOnlyDeletion = await artifactOnlyDeleteResponse.json();
    assert.equal(artifactOnlyDeletion.removed_runner_state, false);
    assert.equal(artifactOnlyDeletion.removed_artifact_files, 4);
    assert.equal(artifactOnlyDeletion.removed_finding_workflows, 1);
    await assert.rejects(stat(findingWorkflow.directory(findingResourceId)), error => error.code === "ENOENT");
    assert.equal((await stat(join(reportsRoot, "final", "security-audit-report.audit-sealed.md"))).isFile(), true);
    const findingsAfterAuditDeletion = await (await fetch(`${base}/api/v1/findings?page=1`)).json();
    assert.equal(findingsAfterAuditDeletion.items.some(item => item.audit_id === "audit-history"), false);

    const queueDefaultsResponse = await fetch(`${base}/api/v1/settings/queue`);
    assert.equal(queueDefaultsResponse.status, 200);
    assert.deepEqual((await queueDefaultsResponse.json()).queue.enabled, false);
    const queueInvalidResponse = await fetch(`${base}/api/v1/settings/queue`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interval_hours: 0 }),
    });
    assert.equal(queueInvalidResponse.status, 422);
    const queueUpdateResponse = await fetch(`${base}/api/v1/settings/queue`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interval_hours: 0.5, concurrency: 2 }),
    });
    assert.equal(queueUpdateResponse.status, 200);
    assert.equal((await queueUpdateResponse.json()).queue.interval_hours, 0.5);
    const queueActivateResponse = await fetch(`${base}/api/v1/settings/queue/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(queueActivateResponse.status, 200);
    assert.equal((await queueActivateResponse.json()).queue.enabled, true);
    const queuedAuditResponse = await fetch(`${base}/api/v1/audits`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "queue-audit-request" },
      body: JSON.stringify({
        audit_id: "audit-queued-001",
        repository_id: "fixture",
        ref: "HEAD",
        allow_dirty: true,
      }),
    });
    assert.equal(queuedAuditResponse.status, 202);
    const queuedAudit = await queuedAuditResponse.json();
    assert.equal(queuedAudit.status, "queued");
    assert.equal(runner.getAudit(queuedAudit.id).status, "queued");
    assert.equal((await (await fetch(`${base}/api/v1/workspace`)).json()).queue.queued_count, 1);
    const queuedDispatchResponse = await fetch(`${base}/api/v1/audits/${queuedAudit.id}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "If-Match": `"${runner.getAudit(queuedAudit.id).version}"`, "Idempotency-Key": "queue-audit-dispatch" },
      body: JSON.stringify({ action: "dispatch" }),
    });
    assert.equal(queuedDispatchResponse.status, 202, JSON.stringify(await queuedDispatchResponse.clone().json()));
    assert.equal((await queuedDispatchResponse.json()).status, "running");
    assert.equal(runner.getAudit(queuedAudit.id).status, "running");
    const queuedCancelResponse = await fetch(`${base}/api/v1/audits/${queuedAudit.id}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "If-Match": `"${runner.getAudit(queuedAudit.id).version}"`, "Idempotency-Key": "queue-audit-cancel" },
      body: JSON.stringify({ action: "cancel" }),
    });
    assert.equal(queuedCancelResponse.status, 202);
    for (let attempt = 0; attempt < 50 && runner.getAudit(queuedAudit.id)?.status !== "cancelled"; attempt += 1) await new Promise(resolve => setImmediate(resolve));
    assert.equal(runner.getAudit(queuedAudit.id).status, "cancelled");
    const queuedDeleteResponse = await fetch(`${base}/api/v1/audits/${queuedAudit.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "If-Match": `"${runner.getAudit(queuedAudit.id).version}"` },
      body: JSON.stringify({ confirmation: queuedAudit.id }),
    });
    assert.equal(queuedDeleteResponse.status, 200);
    assert.equal(runner.getAudit(queuedAudit.id), null);
    const queuedFifoAuditResponse = await fetch(`${base}/api/v1/audits`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "queue-audit-fifo-request" },
      body: JSON.stringify({ audit_id: "audit-queued-002", repository_id: "fixture", ref: "HEAD", allow_dirty: true }),
    });
    assert.equal(queuedFifoAuditResponse.status, 202);
    const queuedFifoAudit = await queuedFifoAuditResponse.json();
    assert.equal(queuedFifoAudit.status, "queued");
    const queueDispatchResponse = await fetch(`${base}/api/v1/settings/queue/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(queueDispatchResponse.status, 202, JSON.stringify(await queueDispatchResponse.clone().json()));
    assert.equal((await queueDispatchResponse.json()).queue.queued_count, 0);
    assert.equal(runner.getAudit(queuedFifoAudit.id).status, "running");
    const queuedFifoCancelResponse = await fetch(`${base}/api/v1/audits/${queuedFifoAudit.id}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "If-Match": `"${runner.getAudit(queuedFifoAudit.id).version}"`, "Idempotency-Key": "queue-audit-fifo-cancel" },
      body: JSON.stringify({ action: "cancel" }),
    });
    assert.equal(queuedFifoCancelResponse.status, 202);
    for (let attempt = 0; attempt < 50 && runner.getAudit(queuedFifoAudit.id)?.status !== "cancelled"; attempt += 1) await new Promise(resolve => setImmediate(resolve));
    assert.equal(runner.getAudit(queuedFifoAudit.id).status, "cancelled");
    const queuedFifoDeleteResponse = await fetch(`${base}/api/v1/audits/${queuedFifoAudit.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "If-Match": `"${runner.getAudit(queuedFifoAudit.id).version}"` },
      body: JSON.stringify({ confirmation: queuedFifoAudit.id }),
    });
    assert.equal(queuedFifoDeleteResponse.status, 200);
    const queueDeactivateResponse = await fetch(`${base}/api/v1/settings/queue/deactivate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(queueDeactivateResponse.status, 200);
    assert.equal((await queueDeactivateResponse.json()).queue.enabled, false);

    const indexResponse = await fetch(`${base}/`);
    assert.equal(indexResponse.status, 200);
    const indexHtml = await indexResponse.text();
    assert.match(indexHtml, /DeepHole·JAVA/);
    assert.match(indexHtml, /id="report-dialog"/);
    assert.match(indexHtml, /class="report-preview markdown-body"/);
    assert.match(indexHtml, /id="finding-dialog"/);
    assert.match(indexHtml, /id="terminal-dialog"/);
    assert.match(indexHtml, /data-view="settings"/);
    assert.match(indexHtml, /id="queue-settings-form"/);
    assert.match(indexHtml, /id="model-settings-form"/);
    assert.match(indexHtml, /使用模型<select name="model" id="audit-model-select" required>/);
    assert.match(indexHtml, /使用模型/);
    assert.match(indexHtml, /队列间隔/);
    assert.match(indexHtml, /激活排队机制/);
    assert.match(indexHtml, /id="opencode-session-id"/);
    assert.match(indexHtml, />OpenCode 会话直连</);
    assert.match(indexHtml, /id="delete-audit-dialog"/);
    assert.match(indexHtml, />确认删除</);
    assert.match(indexHtml, /id="delete-project-dialog"/);
    assert.match(indexHtml, />确认删除项目</);
    assert.match(indexHtml, /name="additional_instructions_enabled"/);
    assert.match(indexHtml, /name="additional_instructions"/);
    assert.match(indexHtml, /name="test_environment_enabled"/);
    assert.match(indexHtml, /name="test_environment_context"/);
    assert.match(indexHtml, /不要求固定账号字段、分行格式或 JSON/);
    assert.match(indexHtml, /确实缺少信息时说明具体缺口，静态审计继续/);
    assert.match(indexHtml, /环境接触 \+ 中期探索 \+ 按需确认/);
    assert.match(indexHtml, /未启用或未填写时自动跳过/);
    assert.match(indexHtml, /验证动作/);
    assert.match(indexHtml, /人工补充验证需逐次授权并保存独立结果/);
    assert.doesNotMatch(indexHtml, /共享环境准备 240 秒、每报告 180 秒快速动态/);
    assert.match(indexHtml, /id="export-selected-bruno"/);
    assert.match(indexHtml, /导出 Bruno 集合（JSON）/);
    assert.match(indexHtml, /运行前补全凭据变量，并确认目标仍在授权范围内/);
    assert.doesNotMatch(indexHtml, /HTTP 请求工作台/);
    assert.doesNotMatch(indexHtml, />发送请求</);
    assert.doesNotMatch(indexHtml, /输入完整 audit_id/);
    assert.doesNotMatch(indexHtml, /<script(?![^>]+src=)[^>]*>/i);
    const appResponse = await fetch(`${base}/app.js`);
    const stylesResponse = await fetch(`${base}/styles.css`);
    assert.equal(appResponse.status, 200);
    assert.equal(stylesResponse.status, 200);
    const appSource = await appResponse.text();
    const stylesSource = await stylesResponse.text();
    assert.match(appSource, /npm --prefix \.opencode run start:audit-workbench:runner/);
    assert.match(appSource, /monitor-event-viewport/);
    assert.match(appSource, /renderAgentEvent/);
    assert.match(appSource, /createAuditMonitor/);
    assert.match(stylesSource, /agent-event\.historical/);
    assert.match(stylesSource, /agent-event\.recent/);
    assert.match(stylesSource, /agent-event\.tool/);
    assert.match(appSource, /删除任务/);
    assert.match(appSource, /已移除审计项目/);
    assert.match(appSource, /\/api\/v1\/repositories\//);
    assert.match(appSource, /submitDeleteProject/);
    assert.match(appSource, /断点恢复/);
    assert.match(appSource, /ResizeObserver/);
    assert.match(appSource, /ttyd/);
    assert.match(appSource, /syncAuditContextControls/);
    assert.match(appSource, /submitModelSettings/);
    assert.match(appSource, /task_test_environment_preconfigured/);
    assert.match(appSource, /opencode -s/);
    assert.match(appSource, /\/api\/v1\/http-exchanges\/export\/bruno/);
    assert.match(appSource, /selectedRequestExchangeIds/);
    assert.doesNotMatch(appSource, /\/api\/v1\/request-sessions/);
    assert.doesNotMatch(appSource, /\/replay/);
    assert.match(appSource, /progress_source/);
    assert.match(appSource, /排队中/);
    assert.match(appSource, /立即调度/);
    assert.match(appSource, /立即开始/);
    assert.match(indexHtml, /立即调度队列/);
    assert.match(appSource, /\/api\/v1\/settings\/queue/);
    assert.match(appSource, /markdown-it-html-disabled/);
    assert.match(appSource, /关联 Repo/);
    assert.match(appSource, /finding\.repository_name/);
    assert.match(appSource, /invalidateFindings/);
    assert.doesNotMatch(appSource, /window\.confirm/);
    const referencedIds = [...appSource.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map(match => match[1]);
    assert.match(appSource, /\[runtimePanel, "audit-runtime-section",/);
    assert.deepEqual([...new Set(referencedIds)].filter(id => id !== 'audit-runtime-section' && !indexHtml.includes(`id="${id}"`)), []);
    assert.match(stylesSource, /@media \(max-width: 1080px\)/);
    assert.match(stylesSource, /@media \(max-width: 760px\)/);
  } finally {
    server.close();
    await once(server, "close");
  }

  assert.equal(parseArgs(["--host", "0.0.0.0"]).host, "0.0.0.0");
  assert.throws(() => parseArgs(["--host", "192.168.1.10"]), /0\.0\.0\.0/);
  assert.throws(() => parseArgs(["--repo", "bad-format"]), /id=\/absolute\/path/);
  assert.throws(() => parseArgs(["--repo", "fixture=relative/path"]), /id=\/absolute\/path/);
  assert.equal(parseArgs([]).repositories.length, 0);
  const options = parseArgs(["--enable-runner", "--enable-dynamic-validation", "--repo", `fixture=${repositoryRoot}`, "--port", "0"]);
  assert.equal(options.runnerEnabled, true);
  assert.equal(options.dynamicRunnerEnabled, true);
  assert.equal(options.repositories[0].id, "fixture");
  const reloadedRunner = new AuditRunner({ stateRoot, platformRoot, configPath: join(repositoryRoot, ".opencode", "opencode.json") });
  await reloadedRunner.ready;
  assert.equal(reloadedRunner.runtimeRepositories().some(repository => repository.path === canonicalOperatorSelectedRoot), true);

  const resumableStateRoot = join(temp, "resumable-audit-state");
  const resumableAuditId = "audit-resume-001";
  const resumableAuditDirectory = join(resumableStateRoot, resumableAuditId);
  const resumableWorkspace = join(platformRoot, "workspace", "audit-runs", resumableAuditId);
  await mkdir(resumableAuditDirectory, { recursive: true });
  const resumedProxyEnvironment = { http_proxy: "http://resume-proxy-fixture.test:8080", HTTPS_PROXY: "http://resume-secure-proxy-fixture.test:8443" };
  const resumedProxyDocument = `${JSON.stringify({ schema_version: 1, environment: resumedProxyEnvironment }, null, 2)}\n`;
  await writeFile(join(resumableAuditDirectory, "proxy-environment.json"), resumedProxyDocument, { encoding: "utf8", mode: 0o600 });
  await writeFile(join(resumableAuditDirectory, "run.json"), `${JSON.stringify({
    id: resumableAuditId,
    name: "中断恢复测试",
    repository_id: "fixture",
    repository_name: "测试仓库",
    commit: fixtureCommit,
    branch: "main",
    status: "running",
    version: 3,
    event_sequence: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    exit_code: null,
    error: null,
    allow_dirty: false,
    model: "global-provider/global-audit",
    provider_session_id: "ses_resume_fixture",
    recovery_count: 0,
    private_runtime: {
      proxy_environment: {
        enabled: true,
        file_name: "proxy-environment.json",
        sha256: createHash("sha256").update(resumedProxyDocument).digest("hex"),
        variable_names: Object.keys(resumedProxyEnvironment).sort(),
      },
    },
    paths: {
      source_root: canonicalRepositoryRoot,
      workspace_root: resumableWorkspace,
      reports_root: reportsRoot,
      tmp_root: join(platformRoot, "tmp", "repositories", "fixture"),
    },
    terminal: {
      backend: "tmux",
      supported: true,
      status: "ready",
      live: true,
      socket_name: "owa-0123456789abcdef",
      target: "audit:tui",
      server_url: "http://127.0.0.1:41234",
      provider_session_id: "ses_resume_fixture",
    },
  }, null, 2)}\n`, "utf8");
  const resumeTerminalMonitor = new FakeTerminalMonitor();
  const resumedChild = new FakeChild();
  let resumedSpawnCall = null;
  let recoveryModelSelection = "global-provider/global-audit";
  const resumableRunner = new AuditRunner({
    stateRoot: resumableStateRoot,
    platformRoot,
    repositories: [{ id: "fixture", name: "测试仓库", path: repositoryRoot }],
    configPath: join(repositoryRoot, ".opencode", "opencode.json"),
    enabled: true,
    environment: { PATH: process.env.PATH ?? "" },
    modelResolver: async () => recoveryModelSelection,
    terminalMonitor: resumeTerminalMonitor,
    spawnProcess(command, args, options) {
      resumedSpawnCall = { command, args, options };
      return resumedChild;
    },
  });
  await resumableRunner.ready;
  const interruptedAudit = resumableRunner.getAudit(resumableAuditId);
  assert.equal(interruptedAudit.status, "interrupted");
  assert.equal(interruptedAudit.interruption_reason, "workbench-restarted");
  assert.equal(interruptedAudit.terminal.live, true);
  assert.equal(resumeTerminalMonitor.stopCalls, 0, "服务重载不应擅自终止仍可查看的精确 tmux 会话");
  recoveryModelSelection = "project-provider/project-review";
  const resumedAudit = await resumableRunner.action(resumableAuditId, "recover", interruptedAudit.version, "resume-action-001");
  assert.equal(resumedAudit.status, "running");
  assert.equal(resumedAudit.recovery_count, 1);
  assert.equal(resumedAudit.model, "global-provider/global-audit");
  assert.equal(resumedAudit.provider_session_id, "ses_resume_fixture");
  assert.equal(resumeTerminalMonitor.abortCalls.length, 1);
  assert.equal(resumeTerminalMonitor.starts[0].providerSessionId, "ses_resume_fixture");
  assert.equal(resumeTerminalMonitor.starts[0].environment.http_proxy, resumedProxyEnvironment.http_proxy);
  assert.equal(resumeTerminalMonitor.starts[0].environment.HTTPS_PROXY, resumedProxyEnvironment.HTTPS_PROXY);
  assert.equal(resumedSpawnCall.command, process.execPath);
  assert.match(resumedSpawnCall.args[0], /terminal-output-relay\.mjs$/);
  assert.equal(resumedSpawnCall.options.env.http_proxy, resumedProxyEnvironment.http_proxy);
  assert.equal(resumedSpawnCall.options.env.HTTPS_PROXY, resumedProxyEnvironment.HTTPS_PROXY);
  assert.equal(resumedSpawnCall.options.env.AUDIT_BAC_MODE, "off", "历史任务恢复不得追加越权专项要求");
  assert.equal(JSON.stringify(resumedAudit).includes("resume-proxy-fixture.test"), false);
  const resumeRunArgs = resumeTerminalMonitor.starts[0].args;
  assert.equal(resumeRunArgs[resumeRunArgs.indexOf("--session") + 1], "ses_resume_fixture");
  assert.equal(resumeRunArgs[resumeRunArgs.indexOf("--model") + 1], "global-provider/global-audit");
  assert.match(resumeRunArgs.at(-1), /第 1 次断点恢复/);
  assert.match(resumeRunArgs.at(-1), /不得删除有效制品/);
  assert.match(resumeRunArgs.at(-1), /不得调用 question 工具/);
  const duplicateResume = await resumableRunner.action(resumableAuditId, "recover", interruptedAudit.version, "resume-action-001");
  assert.equal(duplicateResume.status, "running");
  assert.equal(resumeTerminalMonitor.starts.length, 1, "同一幂等键不得重复启动恢复 Runner");
  resumedChild.emit("close", 0, null);
  for (let attempt = 0; attempt < 50 && resumableRunner.getAudit(resumableAuditId)?.status !== "completed"; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumableRunner.getAudit(resumableAuditId).status, "completed");
  await resumableRunner.shutdown();

  const legacyWatchdogStateRoot = join(temp, "legacy-watchdog-state");
  const legacyWatchdogReportsRoot = join(temp, "legacy-watchdog-reports");
  const legacyWatchdogId = "audit-legacy-watchdog";
  const legacyWatchdogDirectory = join(legacyWatchdogStateRoot, legacyWatchdogId);
  for (const directory of ["coverage", "vulnerability-mining", "correlation", "adjudication", "validation", "final"]) {
    await mkdir(join(legacyWatchdogReportsRoot, directory), { recursive: true });
  }
  await writeFile(join(legacyWatchdogReportsRoot, "coverage", `coverage-plan.${legacyWatchdogId}.json`), JSON.stringify({ audit_id: legacyWatchdogId }), "utf8");
  for (const directory of ["vulnerability-mining", "correlation", "adjudication", "validation"]) {
    await writeFile(join(legacyWatchdogReportsRoot, directory, `${directory}.${legacyWatchdogId}.json`), JSON.stringify({ audit_id: legacyWatchdogId }), "utf8");
  }
  await writeFile(join(legacyWatchdogReportsRoot, "final", `security-audit-report.${legacyWatchdogId}.md`), "# 历史审计报告\n", "utf8");
  await mkdir(legacyWatchdogDirectory, { recursive: true });
  await writeFile(join(legacyWatchdogDirectory, "run.json"), `${JSON.stringify({
    id: legacyWatchdogId,
    name: "历史任务完成性 watchdog 测试",
    repository_id: "fixture",
    repository_name: "测试仓库",
    commit: fixtureCommit,
    branch: "main",
    status: "interrupted",
    version: 2,
    event_sequence: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    exit_code: null,
    error: "workbench restarted",
    allow_dirty: false,
    paths: { source_root: canonicalRepositoryRoot, workspace_root: join(platformRoot, "workspace", "audit-runs", legacyWatchdogId), reports_root: legacyWatchdogReportsRoot, tmp_root: join(platformRoot, "tmp", "repositories", "fixture") },
    terminal: { backend: "tmux", supported: true, status: "disconnected", live: true, socket_name: "owa-legacy-watchdog", target: "audit:tui" },
  }, null, 2)}\n`, "utf8");
  const legacyWatchdogTerminal = new FakeTerminalMonitor();
  let legacyWatchdogSpawned = false;
  const legacyWatchdogRunner = new AuditRunner({
    stateRoot: legacyWatchdogStateRoot,
    platformRoot,
    repositories: [{ id: "fixture", name: "测试仓库", path: repositoryRoot }],
    configPath: join(repositoryRoot, ".opencode", "opencode.json"),
    enabled: true,
    terminalMonitor: legacyWatchdogTerminal,
    spawnProcess() { legacyWatchdogSpawned = true; return new FakeChild(); },
  });
  await legacyWatchdogRunner.ready;
  const watchdogCompletedAudit = legacyWatchdogRunner.getAudit(legacyWatchdogId);
  assert.equal(watchdogCompletedAudit.status, "completed");
  assert.equal(watchdogCompletedAudit.completion_source, "legacy-artifact-heuristic");
  assert.equal(watchdogCompletedAudit.error, null);
  assert.equal(legacyWatchdogTerminal.abortCalls.length, 1);
  assert.equal(legacyWatchdogTerminal.stopCalls, 1);
  await assert.rejects(
    legacyWatchdogRunner.action(legacyWatchdogId, "recover", watchdogCompletedAudit.version, "legacy-watchdog-recover"),
    error => error.code === "audit-not-recoverable",
  );
  assert.equal(legacyWatchdogSpawned, false);
  await legacyWatchdogRunner.shutdown();

  const orphanSession = await mkdtemp(join(tmpdir(), "opencode-dynval-"));
  const recoveryState = join(temp, "recovery-state");
  const recoveryId = "recovery::FIND-WEB-XSS-002";
  const recoveryDirectory = join(recoveryState, createHash("sha256").update(recoveryId).digest("hex").slice(0, 32));
  await mkdir(recoveryDirectory, { recursive: true });
  await writeFile(join(recoveryDirectory, "run.json"), `${JSON.stringify({
    id: recoveryId,
    audit_id: "recovery",
    finding_id: "FIND-WEB-XSS-002",
    repository_id: "fixture",
    status: "running",
    version: 2,
    event_sequence: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ephemeral_cleanup: "PENDING",
    ephemeral_session_root: orphanSession,
  })}\n`, "utf8");
  const recoveredRunner = new DynamicValidationRunner({
    stateRoot: recoveryState,
    registryPath: join(OPENCODE, "skills/common-subagent/audit-artifact-management/contracts/stage-agent-contracts.json"),
    rolesPath: join(OPENCODE, "agent-manifest/roles.json"),
    authSourceRoot: join(temp, "empty-opencode-auth"),
  });
  await recoveredRunner.ready;
  assert.equal(recoveredRunner.getRun(recoveryId).status, "failed");
  assert.equal(recoveredRunner.getRun(recoveryId).ephemeral_cleanup, "SUCCEEDED");
  await assert.rejects(stat(orphanSession), error => error.code === "ENOENT");

  const reloadedFindingWorkflow = new FindingWorkflowStore({ stateRoot: findingWorkflowRoot });
  await reloadedFindingWorkflow.ready;
  const deletedWorkflow = reloadedFindingWorkflow.get(findingResourceId);
  assert.equal(deletedWorkflow.status, "unreviewed");
  assert.equal(deletedWorkflow.version, 0);

  process.stdout.write(`${JSON.stringify({ complete: true, service: "opencode-audit-workbench", cases: tmuxInstalled ? 201 : 196 })}\n`);
} finally {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(temp, { recursive: true, force: true });
      break;
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" || attempt === 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}
