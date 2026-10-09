import http from "node:http";
import { globalAgentSlots } from "../agent-slots.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL, atomicJson, check, controlledBytes } from "./contract.mjs";
import { TaskBoardStore } from "./store.mjs";
import { acceptReview, finalizeBoard, prepareReview } from "./review.mjs";
import { correctReport } from "./report-correction.mjs";
import { BAC_AGENTS, TASK_PLAN, bacSelection } from "../bac/contract.mjs";
import { prepareTaskBacPlan, taskBacEnabled } from "./bac.mjs";
import { prepareMining } from "../agent-mining/service.mjs";

const guardian = fileURLToPath(new URL("./worker-host.mjs", import.meta.url));
const instructionPath = fileURLToPath(new URL("./worker.md", import.meta.url));

export async function workerConfiguration(environment, task) {
  const inherited = JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? "{}");
  const instructions = await readFile(instructionPath, "utf8");
  const specialist = await readFile(new URL(`../../agents/${task.agent_name}.md`, import.meta.url), "utf8");
  const sections = specialist.split(/(?=^## )/m).filter(section => /^## (?:Audit Dimensions|High-value Web checks|Scope\b|Ownership boundary|Evidence Rules|Severity Decision|Judgment Rules Summary)/.test(section));
  const mcpMap = JSON.parse(await readFile(new URL("../../agent-manifest/mcp-map.json", import.meta.url), "utf8"));
  const agent = `task-board-${task.domain}-worker`;
  const config = { ...inherited, plugin: [], agent: { ...(inherited.agent ?? {}), [agent]: {
    mode: "primary", description: `${task.domain} 领域任务执行者`, prompt: `${instructions}\n\n以下为原专业 Agent 的领域参考，只应用于当前任务范围：\n${sections.join("\n")}`,
    permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow", edit: "allow", bash: "allow", skill: "allow", lsp: "allow", external_directory: "allow",
      ...Object.fromEntries((mcpMap.agents[task.agent_name] ?? []).map(name => [name, "allow"])), task: "deny", question: "deny", webfetch: "deny", websearch: "deny" },
  } }, mcp: { ...(inherited.mcp ?? {}) } };
  for (const key of Object.keys(config.mcp)) if (/chrome|browser|winapp|windows-control|runtime/i.test(key)) config.mcp[key] = { enabled: false };
  return { agent, config };
}

export class TaskBoardService {
  constructor({ path, reportsRoot, privateRoot, workspaceRoot, sourceRoot, auditId, scopeDigest, environment = process.env, command = "opencode", model = null,
    runtimeRequired = false, bacMode = "off", concurrency = 4, leaseMs = 30 * 60_000, onChange = async () => {}, onLog = async () => {}, worker = null, spawnProcess = spawn, memory = null, agentSlots = globalAgentSlots }) {
    Object.assign(this, { path, reportsRoot, privateRoot, workspaceRoot, sourceRoot, auditId, scopeDigest, environment, command, model, runtimeRequired, bacMode, leaseMs, onLog, worker, spawnProcess });
    this.concurrency = Math.min(6, Math.max(1, concurrency)); this.token = randomUUID(); this.active = new Map(); this.paused = false; this.closed = false; this.lastDispatch = new Map();
    this.memory = memory; this.memoryTokens = new Map(); this.agentSlots = agentSlots;
    this.store = new TaskBoardStore({ path, reportsRoot, auditId, scopeDigest, onChange });
  }
  async start() {
    try {
      await this.store.open(); this.unsubscribeSlots = this.agentSlots.subscribe(() => this.pump()); await mkdir(this.privateRoot, { recursive: true });
      const board = this.store.snapshot();
      if (board.bac_analysis) check(board.bac_analysis.mode === this.bacMode, "任务面板与运行配置的专项选择不同。");
      else if (!board.tasks.length && !board.final_report) await this.store.mutate(next => { next.bac_analysis = { ...bacSelection(this.bacMode), task_plan_contract: TASK_PLAN }; });
      this.server = http.createServer((request, response) => this.handle(request, response)); this.server.requestTimeout = 60_000;
      await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve); });
      this.endpoint = `http://127.0.0.1:${this.server.address().port}`;
      this.connectionPath = join(this.privateRoot, "endpoint.json");
      await atomicJson(this.connectionPath, { protocol: PROTOCOL, endpoint: this.endpoint, token: this.token });
      this.timer = setInterval(() => this.pump(), 15_000); this.timer.unref?.(); this.pump(); return this;
    } catch (error) { await this.shutdown(); throw error; }
  }
  async handle(request, response) {
    try {
      const suppliedToken = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
      const memoryPrincipal = this.memoryTokens.get(suppliedToken);
      check(request.method === "POST" && !request.headers.origin && (suppliedToken === this.token || request.url === "/memory" && memoryPrincipal), "任务服务请求未授权。");
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; check(size <= 8 * 1024 * 1024, "任务请求过大。"); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      let result;
      if (request.url === "/memory") {
        check(this.memory, "当前任务没有启用长期记忆。");
        let principal = { taskId: "recon" };
        if (memoryPrincipal) {
          principal = { taskId: memoryPrincipal.taskId, sessionId: memoryPrincipal.sessionId ?? null, memoryMode: memoryPrincipal.memoryMode };
        }
        result = await this.memory.request(body, principal);
      } else if (request.url === "/status") result = this.store.summary();
      else if (request.url === "/list") {
        const board = this.store.snapshot();
        const offset = Math.max(0, Number(body.offset) || 0), limit = Math.min(100, Math.max(1, Number(body.limit) || 25));
        const rows = body.source === "api" ? board.api_sources : board.tasks.filter(task => !body.status || task.status === body.status);
        result = { total: rows.length, items: rows.slice(offset, offset + limit), next_offset: offset + limit < rows.length ? offset + limit : null };
      } else if (request.url === "/publish") result = await this.store.publish(body);
      else if (request.url === "/seal") result = await this.store.seal(body);
      else if (request.url === "/skip") result = await this.store.skip(body);
      else if (request.url === "/review-input") result = await prepareReview(this.store, { runtimeRequired: this.runtimeRequired, bacMode: this.bacMode });
      else if (request.url === "/correct-report") result = await correctReport(this.store, body);
      else if (request.url === "/review") result = await acceptReview(this.store, body);
      else if (request.url === "/finalize") {
        result = await finalizeBoard(this.store);
        if (this.memory) try { await this.memory.finalize(this.store.snapshot()); } catch (error) { await this.log("stderr", `长期记忆最终入库缺口：${error.message}`); }
      }
      else throw Object.assign(new Error("任务服务命令不存在。"), { statusCode: 404 });
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(result ?? { ok: true }));
      this.pump();
    } catch (error) {
      response.writeHead(error.statusCode ?? 500, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify({ error: error.message }));
    }
  }
  pump() {
    if (this.closed || this.paused) return;
    if (this.pumping) { this.pumpRequested = true; return; }
    this.pumpRequested = false;
    this.pumping = this.dispatch().catch(error => this.log("stderr", `任务调度失败：${error.message}`)).finally(() => {
      this.pumping = null;
      if (this.pumpRequested) this.pump();
    });
  }
  async log(source, line) {
    try { await this.onLog(source, line); } catch (error) { this.logError = error; }
  }
  async dispatch() {
    while (!this.closed && !this.paused && this.active.size < this.concurrency) {
      const domains = [...new Set(this.store.snapshot().tasks.filter(task => task.status === "PENDING" && !this.active.has(task.domain)).map(task => task.domain))]
        .sort((a, b) => (this.lastDispatch.get(a) ?? 0) - (this.lastDispatch.get(b) ?? 0));
      if (!domains.length) return;
      const domain = domains[0], release = this.agentSlots.tryAcquire(`${this.auditId}:${domain}`);
      if (!release) return;
      let job;
      try { job = await this.store.claim(domain, this.leaseMs); } catch (error) { release(); throw error; }
      if (!job) { release(); return; }
      const active = { job, controller: new AbortController(), promise: null }; this.active.set(domain, active); this.lastDispatch.set(domain, Date.now());
      active.promise = this.execute(active).catch(async error => {
        try { await this.store.fail(job.task.task_id, job.attempt.attempt_id, error.message, { interrupted: active.controller.signal.aborted }); }
        catch (persistenceError) {
          this.paused = true;
          await this.log("stderr", `任务状态无法保存，调度已暂停：${persistenceError.message}`);
        }
        await this.log("stderr", `任务执行失败：${error.message}`);
      }).finally(() => {
        this.active.delete(domain); release(); this.pump();
      });
    }
  }
  async execute(active) {
    const { job, controller } = active;
    const workRoot = join(this.privateRoot, "attempts", job.attempt.attempt_id);
    await mkdir(workRoot, { recursive: true });
    let memoryContext = null, memoryToken = null;
    if (this.memory) {
      try {
        const memoryMode = job.task.agent_mining?.track === "blind" || this.environment.AUDIT_MEMORY_MODE === "blind" ? "blind" : null;
        memoryContext = await this.memory.context(job.task.task_id, memoryMode);
        memoryToken = randomUUID(); this.memoryTokens.set(memoryToken, { taskId: job.task.task_id, attemptId: job.attempt.attempt_id, sessionId: null, memoryMode });
        await atomicJson(join(workRoot, "memory-connection.json"), { endpoint: this.endpoint, token: memoryToken });
      } catch (error) { memoryContext = { status: "GAP", reason: error.message }; }
    }
    let agentMiningContext = null;
    if (job.task.agent_mining) {
      try {
        const prepared = await prepareMining({ sourceRoot: this.sourceRoot, outputRoot: workRoot, auditId: this.auditId,
          taskId: job.task.task_id, attemptId: job.attempt.attempt_id, scopeDigest: this.scopeDigest, config: { ...job.task.agent_mining, ...(memoryContext?.binding?.mode === "blind" || this.environment.AUDIT_MEMORY_MODE === "blind" ? { track: "blind" } : {}) }, environment: this.environment });
        agentMiningContext = { agent_mining: prepared, agent_mining_cli: join(this.workspaceRoot, ".opencode", "scripts", "agent-mining.mjs") };
      } catch (error) { agentMiningContext = { agent_mining_gap: `Agent 静态挖掘准备失败：${error.message}` }; }
    }
    let bacContext = null;
    if (taskBacEnabled(this.store.snapshot()) && BAC_AGENTS.has(job.task.agent_name)) {
      try {
        const ref = await prepareTaskBacPlan({ board: this.store.snapshot(), task: job.task, attempt: job.attempt, reportsRoot: this.reportsRoot, sourceRoot: this.sourceRoot });
        await this.store.mutate(board => { board.attempts.find(row => row.attempt_id === job.attempt.attempt_id).bac_plan = ref; });
        bacContext = { bac_plan: { ...ref, path: join(this.reportsRoot, ref.path) } };
      } catch (error) {
        const reason = `新版专项计划准备失败：${error.message}`;
        await this.store.mutate(board => { board.attempts.find(row => row.attempt_id === job.attempt.attempt_id).bac_gap = reason; });
        bacContext = { bac_gap: reason };
      }
    }
    const input = { protocol: PROTOCOL, audit_id: this.auditId, task: job.task, attempt_id: job.attempt.attempt_id,
      source_root: this.sourceRoot, scope_digest: this.scopeDigest, output_root: workRoot, report_path: join(workRoot, "report.json"), receipt_path: join(workRoot, "receipt.json"),
      report_check_cli: join(this.workspaceRoot, ".opencode", "scripts", "task-report-check.mjs"),
      memory_context: memoryContext, memory_cli: this.memory ? join(this.workspaceRoot, ".opencode", "scripts", "audit-memory.mjs") : null,
      reports_root: this.reportsRoot, session_path: join(workRoot, "session.json"), ...bacContext, ...agentMiningContext, bac_mode: this.bacMode, runtime_protocol: this.runtimeRequired ? "runtime-testing.v1" : null };
    const inputPath = join(workRoot, "input.json"); await atomicJson(inputPath, input);
    let timedOut = false, receiptSnapshot = null, capturing = null, captureStopped = false;
    const deadline = performance.now() + this.leaseMs;
    // Freeze only a complete delivery observed before the deadline. Reading the
    // files after stopping a worker could accept a late or half-written receipt.
    const captureReceipt = () => {
      if (captureStopped || capturing || receiptSnapshot || active.deliveryRevoked || controller.signal.aborted || performance.now() >= deadline) return;
      capturing = Promise.resolve().then(async () => {
        const receipt = JSON.parse((await controlledBytes(workRoot, "receipt.json", 64 * 1024)).toString("utf8"));
        const snapshot = await this.store.prepareReceipt({ taskId: job.task.task_id, attemptId: job.attempt.attempt_id,
          receipt, inputRoot: workRoot, requireCompleteJson: true });
        if (!captureStopped && !active.deliveryRevoked && !controller.signal.aborted && performance.now() < deadline) receiptSnapshot = snapshot;
      }).catch(() => {}).finally(() => { capturing = null; });
    };
    const captureTimer = setInterval(captureReceipt, Math.min(1000, Math.max(10, Math.floor(this.leaseMs / 10)))); captureTimer.unref?.();
    const stopCapture = () => { captureStopped = true; clearInterval(captureTimer); };
    controller.signal.addEventListener("abort", stopCapture, { once: true });
    const timer = setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true; stopCapture(); controller.abort();
    }, this.leaseMs); timer.unref?.();
    const canReceive = () => !active.deliveryRevoked && !controller.signal.aborted && !this.paused && !this.closed;
    try {
      const pending = this.worker ? this.worker({ job, input, inputPath, workRoot, signal: controller.signal }) : this.runWorker({ job, inputPath, signal: controller.signal });
      captureReceipt();
      const result = await pending;
      if (!canReceive()) throw new Error(timedOut ? "任务执行超时。" : "任务调度已暂停或停止。");
      if (result?.session_id) await this.store.mutate(board => { board.attempts.find(row => row.attempt_id === job.attempt.attempt_id).session_id = result.session_id; });
      const receipt = JSON.parse((await controlledBytes(workRoot, "receipt.json", 64 * 1024)).toString("utf8"));
      await this.store.receive({ taskId: job.task.task_id, attemptId: job.attempt.attempt_id, receipt, inputRoot: workRoot }, { canReceive });
    } catch (error) {
      // A report fully written before a worker crash is still a valid delivery.
      let received = false;
      if (timedOut && receiptSnapshot && !active.deliveryRevoked && !this.paused && !this.closed) {
        try {
          await this.store.receivePreparedReceipt(receiptSnapshot, { canReceive: () => !active.deliveryRevoked && !this.paused && !this.closed });
          received = true;
        } catch {}
      } else if (canReceive()) {
        try {
          if (error.session_id) await this.store.mutate(board => { board.attempts.find(row => row.attempt_id === job.attempt.attempt_id).session_id = error.session_id; });
          const receipt = JSON.parse((await controlledBytes(workRoot, "receipt.json", 64 * 1024)).toString("utf8"));
          await this.store.receive({ taskId: job.task.task_id, attemptId: job.attempt.attempt_id, receipt, inputRoot: workRoot }, { canReceive }); received = true;
        } catch {}
      }
      const interrupted = active.deliveryRevoked || this.paused || this.closed || controller.signal.aborted && !timedOut;
      if (!received) await this.store.fail(job.task.task_id, job.attempt.attempt_id,
        timedOut && !interrupted ? "任务执行超时。" : error.message, { interrupted });
    } finally {
      clearTimeout(timer); stopCapture(); controller.signal.removeEventListener("abort", stopCapture);
      if (memoryToken) this.memoryTokens.delete(memoryToken);
      if (this.memory) {
        const completed = this.store.snapshot().tasks.find(task => task.task_id === job.task.task_id);
        const attempt = this.store.snapshot().attempts.find(row => row.attempt_id === job.attempt.attempt_id);
        if (completed?.report) try { await this.memory.ingest(completed, attempt); } catch (error) { await this.log("stderr", `长期记忆报告入库缺口：${error.message}`); }
      }
    }
  }
  async runWorker({ job, inputPath, signal }) {
    const { config, agent } = await workerConfiguration(this.environment, job.task);
    // Static workers never allocate a browser or inherit the monitor's authority.
    const environment = { ...this.environment, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), AUDIT_TASK_PROTOCOL: PROTOCOL,
      AUDIT_TASK_BOARD_CONNECTION_PATH: "", AUDIT_TODO_PATH: "", AUDIT_TODO_CLI: "", AUDIT_RUNTIME_CONNECTION_PATH: "", AUDIT_RUNTIME_CLI: "",
      AUDIT_RUNTIME_PROTOCOL: "", AUDIT_RUNTIME_STATE_ROOT: "",
      AUDIT_MEMORY_CONNECTION_PATH: this.memory ? join(dirname(inputPath), "memory-connection.json") : "",
      AUDIT_MEMORY_MODE: job.task.agent_mining?.track === "blind" ? "blind" : this.environment.AUDIT_MEMORY_MODE ?? "full",
      AUDIT_MEMORY_CLI: this.memory ? join(this.workspaceRoot, ".opencode", "scripts", "audit-memory.mjs") : "",
      AUDIT_TEST_ENVIRONMENT_CONTEXT_PATH: "", AUDIT_TEST_ENVIRONMENT_CONTEXT_SHA256: "", AUDIT_QUICK_DYNAMIC_ENABLED: "false" };
    // --file is variadic: keep the positional message before all options.
    const args = ["run", "完整读取附件中的唯一任务，依据领域技能执行源码审计。写报告和回执后立即结束。",
      "--format", "json", "--agent", agent, "--dir", this.workspaceRoot,
      ...(this.model ? ["--model", this.model] : []), "--title", `${job.task.title}`,
      "--file", inputPath];
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("任务已停止。"));
      const child = this.spawnProcess(process.execPath, [guardian, this.command, ...args], { cwd: this.workspaceRoot, env: environment, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let sessionId = null, stopping = null, sessionWrite = Promise.resolve(), sessionWriteError = null;
      const stop = () => {
        if (stopping) return;
        if (child.connected) child.send({ type: "stop" }, () => {});
        child.kill("SIGTERM"); stopping = setTimeout(() => child.kill("SIGKILL"), 7000); stopping.unref?.();
      };
      signal.addEventListener("abort", stop, { once: true });
      for (const [stream, source] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) {
        let buffer = ""; stream?.setEncoding?.("utf8");
        stream?.on("data", chunk => {
          buffer += chunk; if (buffer.length > 256 * 1024) buffer = buffer.slice(-256 * 1024);
          const lines = buffer.split("\n"); buffer = lines.pop();
          for (const line of lines) {
            try {
              const event = JSON.parse(line), id = event.sessionID ?? event.session_id ?? event.session?.id;
              if (!sessionId && typeof id === "string" && id) {
                sessionId = id;
                for (const principal of this.memoryTokens.values()) if (principal.attemptId === job.attempt.attempt_id) principal.sessionId = id;
                sessionWrite = atomicJson(join(dirname(inputPath), "session.json"), { protocol: PROTOCOL, audit_id: this.auditId,
                  task_id: job.task.task_id, attempt_id: job.attempt.attempt_id, agent_session_id: id }).catch(error => { sessionWriteError = error; });
              }
            } catch {}
            this.log(source, `[${job.task.domain}/${job.task.task_id}] ${line}`);
          }
        });
      }
      child.once("error", error => { signal.removeEventListener("abort", stop); clearTimeout(stopping); reject(Object.assign(error, { session_id: sessionId })); });
      child.once("close", async code => {
        signal.removeEventListener("abort", stop); clearTimeout(stopping); await sessionWrite;
        if (sessionWriteError || code !== 0) reject(Object.assign(sessionWriteError ?? new Error(`专业 Agent 退出码：${code}。`), { session_id: sessionId }));
        else resolve({ session_id: sessionId });
      });
    });
  }
  async pause() {
    this.paused = true;
    // Revocation belongs to an attempt and cannot be undone by a quick resume.
    for (const active of this.active.values()) active.deliveryRevoked = true;
    await this.pumping;
    for (const active of this.active.values()) { active.deliveryRevoked = true; active.controller.abort(); }
    await Promise.allSettled([...this.active.values()].map(active => active.promise));
  }
  resume() { this.paused = false; this.pump(); }
  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      this.closed = true; this.unsubscribeSlots?.(); clearInterval(this.timer); await this.pause();
      if (this.server?.listening) await new Promise(resolve => { this.server.close(resolve); this.server.closeIdleConnections?.(); });
      if (this.connectionPath) await rm(this.connectionPath, { force: true });
      await this.store.close();
    })();
    return this.shutdownPromise;
  }
}
