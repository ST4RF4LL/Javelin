import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { RuntimeTestingController, atomicJson } from "./controller.mjs";
import { ChromeRuntimeBrowser } from "./browser.mjs";
import { PROTOCOL, check, fail, validatePacket } from "./contract.mjs";
import { workerInput } from "./environment-prompt.mjs";

const originOwners = new Map();
const gateway = fileURLToPath(new URL("./worker-mcp.mjs", import.meta.url));
const workerInstructions = fileURLToPath(new URL("./worker-instructions.md", import.meta.url));
const leaseKey = origin => {
  const url = new URL(origin);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return `${url.protocol}//loopback:${url.port || (url.protocol === "https:" ? 443 : 80)}`;
  return `origin:${url.origin}`;
};

export class RuntimeTestingService {
  constructor({ root, privateRoot, authorization, privateContext, command, environment, workspaceRoot, model, onChange = async () => {}, browserFactory, worker, spawnProcess = spawn }) {
    this.root = root; this.privateRoot = privateRoot; this.command = command; this.environment = environment;
    this.workspaceRoot = workspaceRoot; this.model = model; this.onChange = onChange; this.token = randomUUID();
    this.queue = []; this.draining = null; this.accepting = true; this.server = null; this.keys = [];
    this.lockPaths = [];
    this.spawnProcess = spawnProcess;
    this.controller = new RuntimeTestingController({ root, authorization, privateContext,
      prepareEnvironment: grant => this.acquireEnvironment(grant),
      persistEnvironment: async context => { await mkdir(this.privateRoot, { recursive: true }); await atomicJson(join(this.privateRoot, "environment.json"), context); },
      browserFactory: browserFactory ?? (async grant => new ChromeRuntimeBrowser(grant)),
      worker: async args => { await this.changed(); return worker ? worker(args) : this.worker(args); } });
  }
  async start() {
    try { return await this.startOnce(); } catch (error) {
      if (this.controller.state) {
        this.controller.state.status = "BLOCKED"; this.controller.state.reason = "RUNTIME_SERVICE_START_FAILED";
      }
      await this.shutdown().catch(() => {});
      throw error;
    }
  }
  async startOnce() {
    await this.controller.ready;
    if (["SKIPPED", "CLOSED", "BLOCKED", "QUARANTINED"].includes(this.controller.state.status)) { await this.controller.close(); await this.changed(); return this; }
    if (this.controller.authorization.environment_ready !== false) {
      try { await this.acquireEnvironment(this.controller.authorization); }
      catch (error) {
        if (!["ENVIRONMENT_ALREADY_LEASED", "ENVIRONMENT_LEASE_REQUIRES_REVIEW"].includes(error.code)) throw error;
        this.controller.state.status = "BLOCKED"; this.controller.state.reason = error.code;
        await this.controller.close(); await this.changed(); return this;
      }
    }
    this.server = http.createServer((request, response) => this.handle(request, response));
    this.server.requestTimeout = 60_000;
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve); });
    this.endpoint = `http://127.0.0.1:${this.server.address().port}`;
    await mkdir(this.privateRoot, { recursive: true });
    await atomicJson(join(this.privateRoot, "endpoint.json"), { endpoint: this.endpoint, token: this.token });
    const maximumElapsed = Math.max(this.controller.authorization.budget_ms * 4, 3_600_000);
    this.expiryTimer = setTimeout(() => {
      if (this.controller.closed) return;
      this.controller.state.status = this.controller.state.browser_allocated ? "QUARANTINED" : "BLOCKED";
      this.controller.state.reason = "MAX_ELAPSED_EXCEEDED";
      if (this.controller.state.browser_allocated) this.controller.state.cleanup_status = "UNKNOWN";
      this.shutdown().catch(() => {});
    }, Math.max(1, maximumElapsed - (Date.now() - Date.parse(this.controller.state.started_at))));
    this.expiryTimer.unref?.();
    await this.changed(); return this;
  }
  async acquireEnvironment(authorization) {
    const keys = [...new Set(authorization.origins.map(leaseKey))];
    check(keys.length > 0 && this.keys.length === 0, "runtime-environment-lease-invalid");
    check(!keys.some(key => originOwners.has(key)), "ENVIRONMENT_ALREADY_LEASED");
    this.keys = keys; for (const key of keys) originOwners.set(key, this);
    const release = async () => {
      for (const path of this.lockPaths.splice(0)) await rm(path, { force: true });
      for (const key of this.keys) if (originOwners.get(key) === this) originOwners.delete(key);
      this.keys = [];
    };
    try {
      const leasesRoot = join(dirname(dirname(this.privateRoot)), "runtime-environment-leases");
      await mkdir(leasesRoot, { recursive: true });
      for (const key of keys.sort()) {
        const path = join(leasesRoot, `${createHash("sha256").update(key).digest("hex")}.json`);
        await writeFile(path, JSON.stringify({ audit_id: authorization.audit_id, owner: this.token, reason: "环境使用中；异常退出后禁止自动清除租约。" }), { flag: "wx", mode: 0o600 });
        this.lockPaths.push(path);
      }
      return release;
    } catch (error) {
      await release();
      if (error.code === "EEXIST") throw fail("ENVIRONMENT_LEASE_REQUIRES_REVIEW");
      throw error;
    }
  }
  async changed() { await this.onChange({ ...this.controller.snapshot(), queued_packets: this.queue.map(packet => ({ id: packet.id, phase: packet.phase })) }); }
  async handle(request, response) {
    try {
      check(request.method === "POST" && !request.headers.origin, "runtime-http-request-invalid");
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; check(size <= 512 * 1024, "runtime-body-too-large"); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const token = request.headers.authorization?.replace(/^Bearer /, ""); let result;
      if (["/tools", "/call", "/submit", "/configure", "/redactions"].includes(request.url)) {
        this.controller.requireActive(token);
        if (request.url === "/redactions") result = this.controller.registerSensitiveValues(token, body.values);
        if (request.url === "/configure") result = await this.controller.configureEnvironment(token, body);
        if (request.url === "/tools") result = await this.controller.tools(token);
        if (request.url === "/call") result = await this.controller.call(token, body.name, body.arguments ?? {});
        if (request.url === "/submit") result = await this.controller.submit(token, body);
        await this.changed();
      } else {
        check(token === this.token, "runtime-controller-auth-required");
        if (request.url === "/status") result = { ...this.controller.snapshot(), queued_packets: this.queue.map(packet => ({ id: packet.id, phase: packet.phase })) };
        else if (request.url === "/enqueue") result = await this.enqueue(body);
        else if (request.url === "/close") {
          const unavailable = ["QUARANTINED", "BLOCKED"].includes(this.controller.state.status);
          check(unavailable || !this.draining && this.queue.length === 0, "runtime-work-still-active");
          if (unavailable) this.cancelQueued("ENVIRONMENT_UNAVAILABLE");
          clearTimeout(this.expiryTimer);
          this.accepting = false; result = await this.controller.close(); await this.changed();
        } else if (request.url === "/cancel") { clearTimeout(this.expiryTimer); this.accepting = false; this.cancelQueued("USER_CANCELLED"); result = await this.controller.cancel(); await this.changed(); }
        else check(false, "runtime-route-unknown");
      }
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error.statusCode ?? 500, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: error.code ?? "RUNTIME_SERVICE_FAILED" }));
    }
  }
  async enqueue(packet) {
    if (this.controller.state.status === "SKIPPED") return { status: "SKIPPED", reason: this.controller.state.reason };
    check(this.accepting && !["CLOSED", "QUARANTINED", "BLOCKED"].includes(this.controller.state.status), "runtime-environment-unavailable");
    validatePacket(packet, this.controller.authorization);
    check(this.queue.length < 16 && !this.queue.some(item => item.id === packet.id) && !this.controller.state.packets.some(row => row.id === packet.id), "runtime-queue-invalid");
    this.queue.push(structuredClone(packet)); this.controller.state.queued_packets = structuredClone(this.queue);
    await this.controller.save(); await this.changed();
    if (!this.draining && this.accepting) this.draining = Promise.resolve().then(() => this.drain()).catch(async error => {
      this.drainError = error;
      this.controller.state.status = "QUARANTINED"; this.controller.state.reason = "RUNTIME_QUEUE_FAILED";
      this.controller.state.cleanup_status = "UNKNOWN";
      await this.shutdown().catch(shutdownError => { this.shutdownError = shutdownError; });
    }).finally(() => { this.draining = null; });
    return { status: "QUEUED", packet_id: packet.id };
  }
  async drain() {
    while (this.queue.length && this.accepting) {
      const packet = this.queue.shift();
      this.inFlightPacket = packet;
      this.controller.state.queued_packets = structuredClone(this.queue);
      try { await this.controller.run(packet); } catch (error) {
        if (this.controller.closed) return;
        // A failed write after admission is an execution/storage failure, not
        // another skipped packet with the same id.
        if (this.controller.state.packets.some(row => row.id === packet.id)) throw error;
        this.controller.state.packets.push({ id: packet.id, phase: packet.phase, hypothesis_id: packet.hypothesis_id ?? null,
          finding_id: packet.finding_id ?? null, finding_object_digest: packet.finding_object_digest ?? null, scope_digest: packet.scope_digest ?? null,
          execution_status: "SKIPPED", outcome: "INCONCLUSIVE", cleanup_status: "NOT_REQUIRED", reason: error.code ?? "PACKET_NOT_EXECUTED" });
        await this.controller.save();
      } finally { this.inFlightPacket = null; }
      if (!this.accepting) return;
      if (["BLOCKED", "QUARANTINED"].includes(this.controller.state.status)) {
        this.accepting = false; clearTimeout(this.expiryTimer);
        this.cancelQueued("ENVIRONMENT_UNAVAILABLE");
        await this.controller.close(); await this.changed(); return;
      }
      await this.changed();
    }
  }
  async contact() {
    if (this.controller.state.status !== "AUTHORIZED") return;
    const grant = this.controller.authorization;
    return this.enqueue({ protocol: PROTOCOL, id: "contact-1", phase: "CONTACT", audit_id: grant.audit_id,
      authorization_digest: grant.artifact_digest, environment_revision: grant.environment_revision,
      identity_ids: grant.identities.map(identity => identity.id), actions: grant.allowed_actions.filter(action => ["navigate", "normal_interaction"].includes(action)),
      budget_seconds: 600, question: "测试环境是否可访问，授权身份和正常操作基线是否可用？", expected_behavior: "每个授权身份在隔离会话中访问对应测试范围。",
      steps: ["先完整理解私有环境 prompt，登记目标、隔离身份和敏感值；无法确定必要信息时说明缺口。", "通过真实应用路径确认页面、身份和正常响应；不得进行漏洞输入。"], counterchecks: [] });
  }
  async worker({ active, privateContext }) {
    const inherited = JSON.parse(this.environment.OPENCODE_CONFIG_CONTENT ?? "{}");
    const configured = JSON.parse(await readFile(this.environment.OPENCODE_CONFIG, "utf8"));
    const mcp = Object.fromEntries([...new Set([...Object.keys(configured.mcp ?? {}), ...Object.keys(inherited.mcp ?? {})])].map(name => [name, { enabled: false }]));
    mcp["runtime-browser"] = { type: "local", command: [process.execPath, gateway], enabled: true,
      environment: { RUNTIME_WORKER_ENDPOINT: this.endpoint, RUNTIME_WORKER_TOKEN: active.token } };
    const prompt = await readFile(workerInstructions, "utf8");
    const config = { ...inherited, mcp, agent: { "runtime-testing-worker": { mode: "primary", description: "受控运行测试工作包", prompt,
      permission: { "*": "deny", "runtime-browser_*": "allow" } } } };
    // Secrets are on a private attachment, never in argv or public report artifacts.
    const inputPath = join(this.privateRoot, `${active.packet.id}.worker.json`);
    await atomicJson(inputPath, workerInput(active.packet, this.controller.authorization, privateContext));
    try {
      // Preparation may have outlived the lease; never launch a late worker.
      this.controller.requireActive(active.token);
      await new Promise((resolve, reject) => {
        // --file is variadic: keep the positional message before all options.
        const child = this.spawnProcess(this.command, ["run", "执行随本消息展开的 JSON 工作包。用户环境原文就是该 JSON 对象中 environment.prompt 的字符串值，不是另一个文件或附件。CONTACT 的 environment_ready=false 与 origins=[] 表示等待你理解原文并调用 configure_environment 登记；登记成功前禁止访问目标。通过 runtime-browser 提交结果后结束。",
          "--format", "json", "--agent", "runtime-testing-worker", "--dir", this.workspaceRoot,
          ...(this.model ? ["--model", this.model] : []), "--file", inputPath],
        { cwd: this.workspaceRoot, env: { ...this.environment, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, stdio: "ignore", shell: false });
        let stopping; let exited = false;
        active.stopWorker = () => {
          if (stopping || exited) return;
          child.kill();
          // Escalate only this owned OpenCode worker; never enumerate browsers.
          stopping = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 5000);
          stopping.unref?.();
        };
        child.once("error", reject); child.once("close", code => {
          exited = true; clearTimeout(stopping);
          code === 0 || active.submission ? resolve() : reject(Object.assign(new Error("worker-failed"), { code: "RUNTIME_WORKER_FAILED" }));
        });
      });
    } finally { await rm(inputPath, { force: true }); }
  }
  async shutdown() {
    this.shutdownPromise ??= this.shutdownOnce();
    return this.shutdownPromise;
  }
  cancelQueued(reason) {
    const pending = this.queue.splice(0);
    // A dequeued item may still be waiting for controller admission. Account
    // for it before sealing, so its later rejection cannot mutate the bundle.
    if (this.inFlightPacket && !this.controller.state.packets.some(row => row.id === this.inFlightPacket.id)) pending.push(this.inFlightPacket);
    for (const packet of pending) this.controller.state.packets.push({ id: packet.id, phase: packet.phase, hypothesis_id: packet.hypothesis_id ?? null,
      finding_id: packet.finding_id ?? null, finding_object_digest: packet.finding_object_digest ?? null, scope_digest: packet.scope_digest ?? null,
      execution_status: "SKIPPED", reason, outcome: "INCONCLUSIVE", cleanup_status: "NOT_REQUIRED" });
    this.controller.state.queued_packets = [];
  }
  async shutdownOnce() {
    clearTimeout(this.expiryTimer);
    this.accepting = false;
    this.cancelQueued(this.controller.state.reason === "MAX_ELAPSED_EXCEEDED" ? "MAX_ELAPSED_EXCEEDED" : "AUDIT_ENDED");
    try {
      await this.controller.cancel(); await this.changed();
    } finally {
      // Observability or artifact I/O failures must not leave a listening API.
      if (this.server) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); this.server = null; }
      await rm(join(this.privateRoot, "endpoint.json"), { force: true });
      if (this.controller.state?.status !== "QUARANTINED") {
        for (const key of this.keys) if (originOwners.get(key) === this) originOwners.delete(key);
        for (const path of this.lockPaths.splice(0)) await rm(path, { force: true });
      }
    }
  }
}
