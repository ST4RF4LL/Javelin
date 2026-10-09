import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, lstat, realpath } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { PROTOCOL, PHASES, seal, digest, check, text, httpUrl, validatePacket, validateSubmission, redact, redactStructured, fail } from "./contract.mjs";
import { environmentTools, resolveEnvironment } from "./environment-prompt.mjs";

export async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
export async function checkedJson(root, path, expected = null) {
  const base = await realpath(root); const target = resolve(root, path);
  const info = await lstat(target); const actual = await realpath(target); const rel = relative(base, actual);
  check(rel && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel) && info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024, "runtime-artifact-path-invalid");
  const bytes = await readFile(actual);
  if (expected) check(createHash("sha256").update(bytes).digest("hex") === expected, "runtime-evidence-changed");
  return JSON.parse(bytes.toString("utf8"));
}

function observedAuthorizedNavigation(name, args, result, authorization) {
  if (!["navigate_page", "new_page"].includes(name) || result?.isError) return false;
  const pages = result?.structuredContent?.pages;
  if (!Array.isArray(pages)) return false;
  // MCP returns all pages. For routed navigation only the requested page can
  // prove contact; new_page selects its newly created page in MCP 1.8.0.
  const observed = pages.filter(page => name === "navigate_page" && args.pageId != null ? page.id === args.pageId : page.selected === true);
  if (observed.length !== 1) return false;
  const url = httpUrl(observed[0].url);
  return Boolean(url && authorization.origins.includes(url.origin));
}

export class RuntimeTestingController {
  constructor({ root, authorization, privateContext, browserFactory, worker, prepareEnvironment = async () => async () => {}, persistEnvironment = async () => {}, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.root = resolve(root); this.authorization = authorization; this.privateContext = privateContext ?? {};
    this.browserFactory = browserFactory; this.worker = worker; this.now = now;
    this.prepareEnvironment = prepareEnvironment; this.persistEnvironment = persistEnvironment;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.active = null; this.browser = null; this.closed = false; this.serial = Promise.resolve();
    this.ready = this.initialize();
  }
  async initialize() {
    await mkdir(join(this.root, "packets"), { recursive: true });
    await mkdir(join(this.root, "evidence"), { recursive: true });
    let recoveredState = false;
    try {
      const prior = await checkedJson(this.root, "state.json");
      recoveredState = true;
      if (this.authorization.environment_ready === false && prior.authorization_digest !== this.authorization.artifact_digest) {
        const prepared = await checkedJson(this.root, "authorization.json");
        check(prepared.artifact_digest === digest(prepared) && prepared.input_authorization_digest === this.authorization.artifact_digest,
          "runtime-authorization-changed-new-run-required");
        this.authorization = prepared;
      }
      check(prior.authorization_digest === this.authorization.artifact_digest, "runtime-authorization-changed-new-run-required");
      this.state = prior;
      if (prior.active_packet || prior.browser_allocated && !["CLOSED", "SKIPPED", "QUARANTINED"].includes(prior.status)) {
        this.state.status = "QUARANTINED"; this.state.reason = "PROCESS_RECOVERY_ENVIRONMENT_UNKNOWN";
        this.state.active_packet = null; this.state.cleanup_status = "UNKNOWN";
        for (const packet of this.state.packets.filter(packet => packet.execution_status === "RUNNING")) {
          if (packet.phase === "CLEANUP") this.state.cleanup_elapsed_ms += packet.budget_ms ?? 0;
          else this.state.elapsed_ms += packet.budget_ms ?? 0;
          packet.elapsed_ms = packet.budget_ms ?? 0;
          packet.execution_status = "FAILED"; packet.outcome = "INCONCLUSIVE"; packet.cleanup_status = "UNKNOWN";
          packet.reason = "PROCESS_RECOVERY_ENVIRONMENT_UNKNOWN";
        }
      }
      if (prior.queued_packets?.length) {
        for (const packet of prior.queued_packets) this.state.packets.push({ id: packet.id, phase: packet.phase, hypothesis_id: packet.hypothesis_id ?? null,
          finding_id: packet.finding_id ?? null, finding_object_digest: packet.finding_object_digest ?? null, scope_digest: packet.scope_digest ?? null,
          execution_status: "SKIPPED", outcome: "INCONCLUSIVE", cleanup_status: "NOT_REQUIRED", reason: "PROCESS_RECOVERY_QUEUE_INTERRUPTED" });
        this.state.queued_packets = [];
        if (this.state.status !== "QUARANTINED") { this.state.status = "BLOCKED"; this.state.reason = "PROCESS_RECOVERY_QUEUE_INTERRUPTED"; }
      }
    } catch (error) {
      if (error.code !== "ENOENT" || recoveredState) throw error;
      this.state = { protocol: PROTOCOL, audit_id: this.authorization.audit_id, authorization_digest: this.authorization.artifact_digest,
        environment_revision: this.authorization.environment_revision, status: this.authorization.status === "SKIPPED" ? "SKIPPED" : "AUTHORIZED",
        reason: this.authorization.reason, environment_ready: this.authorization.environment_ready ?? true,
        started_at: new Date().toISOString(), elapsed_ms: 0, cleanup_elapsed_ms: 0,
        budget_ms: this.authorization.budget_ms, cleanup_reserve_ms: this.authorization.cleanup_reserve_ms,
        browser_allocated: false, active_packet: null, baseline_packet: null, cleanup_status: "NOT_REQUIRED", packets: [], queued_packets: [], evidence: [],
        stages: Object.fromEntries(PHASES.map(phase => [phase, this.authorization.status === "SKIPPED" ? "SKIPPED" : "NOT_SCHEDULED"])) };
    }
    await atomicJson(join(this.root, "authorization.json"), this.authorization); await this.save();
    if (this.state.status === "SKIPPED") await this.writeEvidenceSet();
  }
  async exclusive(operation) {
    const prior = this.serial; let release;
    this.serial = new Promise(resolve => { release = resolve; }); await prior;
    try { return await operation(); } finally { release(); }
  }
  snapshot() {
    const snapshot = structuredClone(this.state);
    if (this.active) snapshot[this.active.packet.phase === "CLEANUP" ? "cleanup_elapsed_ms" : "elapsed_ms"] += Math.max(0, Math.floor(this.now() - this.active.start));
    return snapshot;
  }
  async save() {
    this.persistence = (this.persistence ?? Promise.resolve()).catch(() => {}).then(() => atomicJson(join(this.root, "state.json"), this.state));
    await this.persistence;
  }
  async evidence(name, value, active) {
    const safe = redact(value, this.privateContext);
    // Text stays text after redaction: never reparse a potentially altered JSON string.
    const record = seal({ protocol: PROTOCOL, audit_id: this.authorization.audit_id, content: safe,
      structured_content: redactStructured(value, this.privateContext), recorded_at: new Date().toISOString() });
    const path = `evidence/${name}.json`;
    await atomicJson(join(this.root, path), record);
    const bytes = await readFile(join(this.root, path));
    // A timed-out call may finish writing after the bundle was sealed. It must
    // never mutate that bundle's admitted evidence list.
    this.requireActive(active.token);
    const binding = { id: name, path, sha256: createHash("sha256").update(bytes).digest("hex") };
    this.state.evidence.push(binding); return binding;
  }
  async start(packet) {
    await this.ready;
    return this.exclusive(async () => {
      if (this.state.status === "SKIPPED") return null;
      check(!this.closed && !["CLOSED", "QUARANTINED", "BLOCKED"].includes(this.state.status), "runtime-environment-unavailable");
      check(!this.active, "runtime-environment-busy");
      validatePacket(packet, this.authorization);
      check(!this.state.packets.some(row => row.id === packet.id), "runtime-packet-already-executed");
      if (["EXPLORE", "CONFIRM"].includes(packet.phase)) check(this.state.baseline_packet, "runtime-baseline-required");
      const attempts = this.state.packets.filter(row => row.hypothesis_id && row.hypothesis_id === packet.hypothesis_id);
      check(attempts.length < 2, "runtime-hypothesis-attempt-limit");
      if (attempts.length) check(text(packet.new_evidence_reason), "runtime-retry-needs-new-evidence");
      const elapsedWall = Date.now() - Date.parse(this.state.started_at);
      check(elapsedWall < Math.max(this.authorization.budget_ms * 4, 3_600_000), "runtime-max-elapsed-exceeded");
      const available = packet.phase === "CLEANUP"
        ? this.authorization.cleanup_reserve_ms - this.state.cleanup_elapsed_ms
        : this.authorization.budget_ms - this.authorization.cleanup_reserve_ms - this.state.elapsed_ms;
      if (available < 10_000) {
        this.state.stages[packet.phase] = "SKIPPED";
        this.state.packets.push({ id: packet.id, phase: packet.phase, hypothesis_id: packet.hypothesis_id ?? null,
          finding_id: packet.finding_id ?? null, finding_object_digest: packet.finding_object_digest ?? null, scope_digest: packet.scope_digest ?? null,
          execution_status: "SKIPPED", reason: "BUDGET_EXHAUSTED", cleanup_status: "NOT_REQUIRED", outcome: "INCONCLUSIVE" });
        await this.save(); return null;
      }
      const duration = Math.min(packet.budget_seconds * 1000, available);
      const row = { id: packet.id, phase: packet.phase, hypothesis_id: packet.hypothesis_id ?? null,
        finding_id: packet.finding_id ?? null, finding_object_digest: packet.finding_object_digest ?? null,
        vulnerability_type_id: packet.vulnerability_type_id ?? null,
        focus_area_id: packet.focus_area_id ?? null, scope_digest: packet.scope_digest ?? null,
        input_digest: digest(packet), execution_status: "RUNNING", started_at: new Date().toISOString(),
        budget_ms: duration, outcome: "INCONCLUSIVE", cleanup_status: "UNKNOWN", evidence_ids: [] };
      this.state.packets.push(row); this.state.active_packet = packet.id; this.state.status = "IN_USE"; this.state.stages[packet.phase] = "RUNNING";
      const active = { packet: structuredClone(packet), row, token: randomUUID(), start: this.now(), duration, actionIds: new Set(),
        actionSequence: 0, identitiesUsed: new Set(), submitting: false, operation: Promise.resolve(), stopWorker: null, submission: null, expired: false };
      active.accepted = new Promise(resolve => { active.resolveAccepted = resolve; });
      this.active = active;
      await atomicJson(join(this.root, "packets", `${packet.id}.input.json`), seal(packet)); await this.save();
      return active;
    });
  }
  async run(packet) {
    const active = await this.start(packet);
    if (!active) return this.snapshot();
    let timer; let result;
    try {
      this.requireActive(active.token);
      const deadline = new Promise((_, reject) => { timer = this.setTimer(() => {
        active.expired = true; reject(fail("runtime-packet-timed-out"));
      }, Math.max(1, active.duration - (this.now() - active.start))); });
      await Promise.race([this.worker({ controller: this, active, privateContext: this.privateContext }), active.accepted, deadline]);
      check(active.submission, "runtime-no-submission");
      result = active.submission;
    } catch (error) {
      error = active.preparationError ?? error;
      const terminationReason = error.code ?? "RUNTIME_EXECUTION_FAILED";
      if (["runtime-no-submission", "RUNTIME_WORKER_FAILED"].includes(error.code)) {
        const rejected = active.row.last_submission_error?.code ?? active.browserError;
        if (rejected) error = fail(rejected);
      }
      if (this.active === active) active.stopWorker?.();
      const leaseBlocked = ["ENVIRONMENT_ALREADY_LEASED", "ENVIRONMENT_LEASE_REQUIRES_REVIEW"].includes(error.code);
      const diagnostic = {
        "contact-identities-not-observed": "平台未能从浏览器结果确认授权身份的访问记录，环境接触结果提交被拒绝。",
        "xss-identities-not-observed": "浏览器证据未覆盖要求的独立身份，验证结果提交被拒绝。",
        BROWSER_STRUCTURED_OUTPUT_MISSING: "浏览器未返回结构化页面记录，平台无法确认环境接触结果。",
      }[error.code];
      result = { execution_status: leaseBlocked ? "BLOCKED" : error.code === "runtime-packet-timed-out" ? "TIMED_OUT" : "FAILED", outcome: "INCONCLUSIVE",
        ...(leaseBlocked ? { environment_lease: error.environment_lease ?? null } : {}),
        termination_reason: terminationReason,
        cleanup_status: this.state.browser_allocated ? "UNKNOWN" : "NOT_REQUIRED", summary: leaseBlocked ? "申请测试环境被阻止，本次尚未访问目标；请在运行环境页查看占用来源。"
          : diagnostic ?? (active.row.last_submission_error ? `运行结果提交未通过平台校验（${error.code}），工作包未完成。` : "运行测试未完成，已停止环境复用。"),
        observations: [], evidence_ids: [...active.actionIds], changes: [], gaps: [`运行测试未完成：${String(error.code ?? "RUNTIME_EXECUTION_FAILED")}。`], reason: error.code ?? "RUNTIME_EXECUTION_FAILED" };
    } finally { this.clearTimer(timer); }
    // Persistence failures must not be rewritten as a second execution result.
    await this.finish(active, result);
    return this.snapshot();
  }
  requireActive(token) {
    const active = this.active;
    check(!this.closed && active && active.token === token && !active.expired && !active.submission && this.now() - active.start < active.duration, "runtime-lease-invalid");
    return active;
  }
  async tools(token) {
    const active = this.requireActive(token);
    check(!active.environmentPreparing, "runtime-environment-preparation-in-progress");
    if (this.authorization.environment_ready === false) return environmentTools.filter(tool => tool.name === "configure_environment");
    if (!this.browser) {
      this.state.browser_allocated = true; await this.save();
      this.requireActive(token);
      this.browserPromise ??= Promise.resolve().then(() => {
        this.requireActive(token);
        return this.browserFactory(this.authorization, this.privateContext);
      }).then(async browser => {
        if (this.closed || this.active !== active || active.expired) {
          await browser.close(); throw fail("runtime-lease-invalid");
        }
        return browser;
      });
      this.browser = await this.browserPromise;
    }
    this.requireActive(token);
    const tools = await this.browser.tools(active.packet);
    this.requireActive(token); return tools;
  }
  async configureEnvironment(token, input) {
    return this.exclusive(async () => {
      const active = this.requireActive(token);
      check(active.packet.phase === "CONTACT" && !this.state.browser_allocated && active.actionIds.size === 0 && this.state.packets.length === 1,
        "runtime-environment-configuration-closed");
      const prepared = resolveEnvironment(this.authorization, input);
      // Register secrets before any failure could become a public diagnostic.
      this.privateContext.sensitive_values = [...new Set([...(this.privateContext.sensitive_values ?? []), ...prepared.private.sensitive_values])];
      check(prepared.public.identities.every(identity => !this.privateContext.sensitive_values.includes(identity.id)), "runtime-environment-identity-must-not-contain-credentials");
      active.environmentPreparing = true;
      let release;
      try {
        release = await this.prepareEnvironment(prepared.public);
        this.requireActive(token);
        const privateContext = { ...this.privateContext, ...prepared.private, sensitive_values: this.privateContext.sensitive_values };
        await this.persistEnvironment(privateContext); this.requireActive(token);
        this.authorization = prepared.public; Object.assign(this.privateContext, privateContext);
        // No browser evidence exists yet. Freeze the interpreted environment and
        // bind the initial CONTACT packet before admitting the first request.
        active.packet = { ...active.packet, authorization_digest: prepared.public.artifact_digest,
          identity_ids: prepared.public.identities.map(identity => identity.id) };
        active.row.input_digest = digest(active.packet);
        this.state.authorization_digest = prepared.public.artifact_digest; this.state.environment_ready = true;
        await atomicJson(join(this.root, "authorization.json"), prepared.public);
        await atomicJson(join(this.root, "packets", `${active.packet.id}.input.json`), seal(active.packet));
        await this.save();
        this.requireActive(token);
        return { environment_ready: true, authorization_digest: prepared.public.artifact_digest,
          origins: prepared.public.origins, identities: prepared.public.identities, test_data_scope: prepared.public.test_data_scope,
          packet: active.packet };
      } catch (error) {
        await release?.();
        // Never admit a browser after a partially persisted binding.
        active.expired = true; active.preparationError = error; active.resolveAccepted();
        throw error;
      } finally { active.environmentPreparing = false; }
    });
  }
  registerSensitiveValues(token, values) {
    const active = this.requireActive(token);
    check(!active.environmentPreparing, "runtime-environment-preparation-in-progress");
    check(Array.isArray(values) && values.every(text), "runtime-environment-redactions-invalid");
    this.privateContext.sensitive_values = [...new Set([...(this.privateContext.sensitive_values ?? []), ...values])];
    return { registered: true };
  }
  async call(token, name, args) {
    const active = this.requireActive(token);
    const prior = active.operation; let release;
    active.operation = new Promise(resolve => { release = resolve; }); await prior;
    try {
      this.requireActive(token);
      check(this.authorization.environment_ready !== false, "runtime-environment-not-prepared");
      // Normal CONTACT form values can include credentials understood by the
      // Agent; register them before they reach browser responses or evidence.
      if (active.packet.phase === "CONTACT") {
        const values = name === "fill" ? [args.value] : name === "fill_form" ? (args.elements ?? []).map(element => element.value) : [];
        this.privateContext.sensitive_values = [...new Set([...(this.privateContext.sensitive_values ?? []), ...values.filter(text)])];
      }
      await this.tools(token);
      this.requireActive(token);
      const id = `${active.packet.id}.action-${++active.actionSequence}`;
      let result;
      try {
        result = await this.browser.call(name, args, active.packet);
      } catch (error) {
        this.requireActive(token);
        const code = error.code ?? "BROWSER_TOOL_FAILED";
        const binding = await this.evidence(id, { tool: name, identity_id: args.identity_id, arguments: args,
          status: "FAILED", code, summary: "浏览器工具调用失败。",
          result: { isError: true, error: { code, message: String(error.message ?? "浏览器工具未返回错误说明。") } } }, active);
        active.actionIds.add(binding.id); await this.save(); throw error;
      }
      this.requireActive(token);
      const binding = await this.evidence(id, { tool: name, identity_id: args.identity_id, arguments: args, result }, active);
      if (result?.isError && result.error?.code === "BROWSER_STRUCTURED_OUTPUT_MISSING") active.browserError = result.error.code;
      if (observedAuthorizedNavigation(name, args, result, this.authorization)) active.identitiesUsed.add(args.identity_id);
      active.actionIds.add(binding.id); await this.save();
      // Keep the legacy text while exposing MCP page/request IDs and typed data
      // without reparsing text that redaction may have made non-JSON.
      return { evidence_id: binding.id, result: redact(result, this.privateContext),
        structured_result: redactStructured(result, this.privateContext), isError: result?.isError === true };
    } finally { release(); }
  }
  async submit(token, value) {
    const active = this.requireActive(token); await active.operation;
    this.requireActive(token);
    check(!active.environmentPreparing, "runtime-environment-preparation-in-progress");
    try {
      validateSubmission(value, active.packet, active.actionIds);
      if (active.packet.phase === "CONTACT" && value.execution_status === "COMPLETED") {
        check(this.authorization.environment_ready !== false, "runtime-environment-not-prepared");
        check(active.packet.identity_ids.every(id => active.identitiesUsed.has(id)), "contact-identities-not-observed");
      }
      if (value.outcome === "SUPPORTED" && active.packet.vulnerability_type_id === "JW-INJECT-06") {
        check(active.packet.identity_ids.every(id => active.identitiesUsed.has(id)), "xss-identities-not-observed");
      }
    } catch (error) {
      // Persist only the contract's fixed code, never rejected private input.
      active.row.last_submission_error = { code: error.code ?? "runtime-submission-invalid", recorded_at: new Date().toISOString() };
      await this.save(); throw error;
    }
    check(!active.submitting, "runtime-submission-duplicate"); active.submitting = true;
    active.submission = structuredClone(value);
    active.resolveAccepted();
    // The accepted artifact ends execution; do not charge a worker that hangs after submission.
    active.stopWorker?.();
    return { accepted: true, packet_id: active.packet.id };
  }
  async finish(active, result) {
    return this.exclusive(async () => {
      if (this.active !== active) return;
      active.expired = true;
      const elapsed = Math.max(0, Math.floor(this.now() - active.start));
      // Store only redacted narratives; preserve status/identity fields structurally.
      const safe = { ...result, summary: redact(result.summary, this.privateContext),
        observations: result.observations.map(item => redact(item, this.privateContext)),
        gaps: result.gaps.map(item => redact(item, this.privateContext)),
        changes: result.changes.map(change => ({ marker: redact(change.marker, this.privateContext), resource: redact(change.resource, this.privateContext), cleanup_status: change.cleanup_status })),
        proof: result.proof ? Object.fromEntries(Object.entries(result.proof).map(([key, value]) => [key,
          key === "method" && value === "REAL_APPLICATION_INPUT" ? value : redact(value, this.privateContext)])) : null };
      const output = seal({ ...safe, protocol: PROTOCOL, audit_id: this.authorization.audit_id, packet_id: active.packet.id,
        input_digest: active.row.input_digest, authorization_digest: this.authorization.artifact_digest,
        environment_revision: this.authorization.environment_revision, elapsed_ms: elapsed, evidence_validity: "UNVERIFIED" });
      const path = `packets/${active.packet.id}.result.json`; await atomicJson(join(this.root, path), output);
      if (active.packet.phase === "CLEANUP") this.state.cleanup_elapsed_ms += elapsed;
      else this.state.elapsed_ms += elapsed;
      Object.assign(active.row, { execution_status: safe.execution_status, outcome: safe.outcome, cleanup_status: safe.cleanup_status,
        ...(safe.reason ? { reason: safe.reason } : {}),
        evidence_ids: [...active.actionIds], summary: safe.summary, result_path: path, result_digest: output.artifact_digest, elapsed_ms: elapsed });
      this.state.stages[active.packet.phase] = safe.execution_status; this.state.active_packet = null;
      this.state.cleanup_status = safe.cleanup_status;
      if (safe.environment_lease) this.state.environment_lease = safe.environment_lease;
      if (safe.execution_status === "BLOCKED" && !this.state.browser_allocated) {
        this.state.status = "BLOCKED"; this.state.reason = safe.reason ?? "ENVIRONMENT_CONTACT_INCOMPLETE";
      } else if (["FAILED", "UNKNOWN"].includes(safe.cleanup_status) || ["FAILED", "TIMED_OUT", "CANCELLED"].includes(safe.execution_status)) {
        this.state.status = "QUARANTINED"; this.state.reason = safe.reason ?? "ENVIRONMENT_STATE_UNKNOWN";
      } else if (active.packet.phase === "CONTACT" && safe.execution_status !== "COMPLETED") {
        this.state.status = "BLOCKED"; this.state.reason = "ENVIRONMENT_CONTACT_INCOMPLETE";
      } else {
        this.state.status = "READY";
        if (active.packet.phase === "CONTACT") this.state.baseline_packet = active.packet.id;
      }
      this.active = null;
      if (["QUARANTINED", "BLOCKED"].includes(this.state.status)) await this.releaseBrowser();
      await this.save();
    });
  }
  async cancel() {
    // Revoke admission before waiting for initialization or an in-flight start.
    this.closed = true;
    await this.ready;
    await this.exclusive(async () => {});
    const active = this.active;
    if (active) {
      active.expired = true; active.stopWorker?.();
      await this.finish(active, active.submission ?? { execution_status: "CANCELLED", outcome: "INCONCLUSIVE", cleanup_status: "UNKNOWN",
        summary: "运行测试已取消，环境状态需要人工核对。", observations: [], gaps: [], changes: [], evidence_ids: [...active.actionIds] });
      active.resolveAccepted();
    }
    return this.close();
  }
  async close() {
    await this.ready;
    return this.exclusive(async () => {
    check(!this.active, "runtime-work-still-active"); this.closed = true;
    await this.releaseBrowser();
    if (!["SKIPPED", "QUARANTINED", "BLOCKED"].includes(this.state.status)) this.state.status = "CLOSED";
    if (this.state.status !== "SKIPPED") {
      if (this.state.stages.CLEANUP === "NOT_SCHEDULED") this.state.stages.CLEANUP = this.state.cleanup_status === "NOT_REQUIRED" ? "SKIPPED" : ["FAILED", "UNKNOWN"].includes(this.state.cleanup_status) ? "BLOCKED" : "COMPLETED";
      for (const phase of PHASES) if (this.state.stages[phase] === "NOT_SCHEDULED") this.state.stages[phase] = "SKIPPED";
    }
    await this.save(); return this.writeEvidenceSet();
    });
  }
  async releaseBrowser() {
    if (this.browser) {
      const browser = this.browser; this.browser = null;
      try { await browser.close(); } catch {
        this.state.cleanup_status = "UNKNOWN"; this.state.status = "QUARANTINED"; this.state.reason = "BROWSER_CLOSE_FAILED";
      }
    }
  }
  async writeEvidenceSet() {
    for (const binding of this.state.evidence) await checkedJson(this.root, binding.path, binding.sha256);
    const packets = [];
    for (const row of this.state.packets) {
      if (!row.result_path) { packets.push({ ...row, evidence_validity: "UNVERIFIED" }); continue; }
      const result = await checkedJson(this.root, row.result_path);
      check(digest(result) === row.result_digest && result.artifact_digest === row.result_digest, "runtime-result-changed");
      packets.push({ ...row, result });
    }
    const value = seal({ protocol: PROTOCOL, artifact_type: "runtime-testing-evidence-set", audit_id: this.authorization.audit_id,
      authorization_digest: this.authorization.artifact_digest, environment_revision: this.authorization.environment_revision,
      status: this.state.status, reason: this.state.reason, cleanup_status: this.state.cleanup_status,
      ...(this.state.runtime_host ? { runtime_host: this.state.runtime_host } : {}),
      elapsed_ms: this.state.elapsed_ms, cleanup_elapsed_ms: this.state.cleanup_elapsed_ms, stages: this.state.stages,
      packets, evidence_bindings: this.state.evidence });
    await atomicJson(join(this.root, "evidence-set.json"), value); return value;
  }
}
