import { EventLogReader } from "./event-log-reader.mjs";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { arch as osArch, platform as osPlatform, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { validateExternalRuntimeValidationRequest } from "../../skills/common-subagent/finding-evidence-contract/scripts/external-runtime-validation-contract.mjs";
import { stageEnvelopeDigest, validateStageEnvelope } from "../../skills/common-subagent/audit-artifact-management/scripts/stage-agent-contract.mjs";
import { buildOpenCodeEnvironment } from "./opencode-runtime-config.mjs";
import { normalizeOpenCodeModel } from "./opencode-model-settings.mjs";
import { BrowserSessionBroker } from "./dynamic-validation-core.mjs";
import { resolvedOpenCodeExecutables } from "./executable-resolution.mjs";
import { webValidationCapability } from "./web-validation-policy.mjs";

const RUN_ID = /^[a-z0-9][a-z0-9._:-]{2,260}$/i;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_LOG_LINE = 16 * 1024;
const execFileAsync = promisify(execFile);

function safeRelative(root, candidate) {
  const absoluteRoot = resolve(root);
  const absolute = resolve(candidate);
  const value = relative(absoluteRoot, absolute);
  if (value.startsWith("..") || isAbsolute(value) || value.split(sep).includes("..")) return null;
  return value;
}

async function readJson(path, root) {
  if (safeRelative(root, path) === null) throw new Error("validation-artifact-outside-runtime-root");
  const linkInfo = await lstat(path);
  if (linkInfo.isSymbolicLink()) throw new Error("validation-artifact-symlink-forbidden");
  const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
  if (safeRelative(realRoot, realPath) === null) throw new Error("validation-artifact-realpath-outside-runtime-root");
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_JSON_BYTES) throw new Error("validation-artifact-size-invalid");
  return JSON.parse(await readFile(path, "utf8"));
}

function validateLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && LOOPBACK.has(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

function genericRedact(value) {
  return String(value)
    .replace(/(["']?(?:password|passwd|secret|token|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,"']+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[JWT_REDACTED]");
}

function redact(value, secrets = []) {
  let result = genericRedact(value);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) result = result.replaceAll(secret, "[REDACTED]");
  return result.slice(0, MAX_LOG_LINE);
}

async function createEphemeralRuntimeRoot() {
  const root = await mkdtemp(join(tmpdir(), "opencode-dynval-"));
  const tempHome = join(root, "tmp");
  await mkdir(tempHome, { recursive: true });
  return { root, tempHome };
}

export function validateAuthorization(input) {
  const target = validateLoopbackUrl(input.target_base_url);
  if (input.explicit_authorization !== true || input.test_environment !== true) throw Object.assign(new Error("必须明确确认这是授权的测试环境。"), { statusCode: 422, code: "authorization-required" });
  if (!target) throw Object.assign(new Error("动态验证目标必须是 localhost、127.0.0.1 或 [::1] 的 HTTP(S) URL。"), { statusCode: 422, code: "target-not-loopback" });
  const account = (value, name) => {
    if (value == null) return null;
    if (typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error(`${name} 测试账号格式无效。`), { statusCode: 422, code: "test-account-invalid" });
    const username = value.username == null ? "" : value.username;
    const password = value.password == null ? "" : value.password;
    if (typeof username !== "string" || username.length > 300 || typeof password !== "string" || password.length > 4096) {
      throw Object.assign(new Error(`${name} 测试账号格式无效或过长。`), { statusCode: 422, code: "test-account-invalid" });
    }
    return username.trim() || password ? { username: username.trim(), password } : null;
  };
  let attacker = account(input.attacker_account, "attacker");
  let victim = account(input.victim_account, "victim");
  let accountMode = "anonymous";
  if (attacker || victim) {
    if (!attacker) attacker = victim;
    if (!victim) victim = attacker;
    accountMode = attacker.username && victim.username && attacker.username !== victim.username ? "distinct" : "shared";
  }
  const instruction = (value, field) => {
    if (value == null || value === "") return "";
    if (typeof value !== "string" || value.length > 4000) throw Object.assign(new Error(`${field} 格式无效或过长。`), { statusCode: 422, code: "instructions-invalid" });
    return value.trim();
  };
  return {
    target,
    attacker,
    victim,
    accountMode,
    loginInstructions: instruction(input.login_instructions, "login_instructions"),
    cleanupInstructions: instruction(input.cleanup_instructions, "cleanup_instructions"),
    browserMode: input.browser_mode ?? "auto",
  };
}

function validationPrompt({ request, requestPath, envelopePath, target, attacker, victim, accountMode, loginInstructions, cleanupInstructions, browserSession, repository, executionPaths }) {
  const vulnerabilityTypeId = request.claim.vulnerability_type_id;
  const validatorInstruction = vulnerabilityTypeId === "JW-INJECT-06"
    ? "加载 web-xss-runtime-validation，执行 XSS 专用证据与结果契约。"
    : "加载 web-runtime-validation，执行通用 Web 证据与结果契约；若安全确认需要破坏性、拒绝服务、进程崩溃、文件覆盖或外部目标访问，必须返回 INCONCLUSIVE 或 NOT_RUN。";
  const browserInstruction = browserSession.mode === "isolated_browser"
    ? `本次使用独立临时 Chrome（headless=${browserSession.headless}）；只关闭本会话创建的页面和该受管实例。`
    : browserSession.mode === "isolated_context"
      ? `本次连接用户 Chrome，但必须使用命名 isolated context ${browserSession.context_name}，只关闭本任务页面和上下文。`
      : "本次连接用户已授权远程调试的 Chrome，只创建并关闭本任务标签页；不得读取、操作或关闭其他已有页面。";
  const accountInstructions = accountMode === "distinct"
    ? [
        "本次提供两个身份不同的专用测试账号；仅在实际分别登录并建立隔离上下文后，才可声称跨用户复现。",
        `attacker username: ${attacker.username}`,
        `attacker password: ${attacker.password}`,
        `victim username: ${victim.username}`,
        `victim password: ${victim.password}`,
      ]
    : accountMode === "shared"
      ? [
          "本次只提供单一或同身份测试账号；可以验证同一身份内的漏洞，但不得声称跨用户或跨权限复现。",
          `shared test username: ${attacker.username}`,
          `shared test password: ${attacker.password}`,
        ]
      : [
          "本次未提供测试账号；只允许验证匿名可达路径。若目标实际要求登录，必须返回 NOT_RUN 或 INCONCLUSIVE，不得索取、猜测或使用其他账号。",
        ];
  return [
    `@dynamic-vulnerability-validator 执行一次用户明确授权的 localhost Web 动态验证：${vulnerabilityTypeId}。`,
    validatorInstruction,
    `密封 runtime-validation request：${requestPath}`,
    `密封 P08 input envelope：${envelopePath}`,
    `被测源码根目录 ${repository.path} 只读；不得在其中创建 reports、tmp、浏览器数据或任何其他文件。`,
    `当前执行工作区是 ${executionPaths.workspace_root}；所有相对 reports/** 输出必须通过该工作区落到工作台受控制品目录。`,
    `授权测试目标：${target.href}`,
    "用户已确认该环境以及任何已提供账号均为专用测试资产，不是生产、第三方或真实用户资产。",
    ...accountInstructions,
    loginInstructions ? `login instructions: ${loginInstructions}` : "未提供登录步骤；仅按应用中明确可见且非破坏性的正常入口操作。",
    cleanupInstructions ? `cleanup instructions: ${cleanupInstructions}` : "未提供清理步骤；如验证会产生持久化写入且无法确认安全清理路径，不得执行该写入，并返回 NOT_RUN 或 INCONCLUSIVE。",
    `浏览器会话 ID：${browserSession.id}；模式：${browserSession.mode}。`,
    `Chrome DevTools MCP package：${browserSession.mcp.command[2]}。结果中的 browser_backend.package 必须记录该精确值。`,
    ...(browserSession.connection_warning ? [browserSession.connection_warning] : []),
    browserInstruction,
    "严格遵守动态验证安全边界，只使用 Chrome DevTools MCP；保存脱敏证据并尝试清理，禁止任何全局浏览器进程终止操作。",
  ].join("\n");
}

function validationRiskSignals(vulnerabilityTypeId) {
  if (vulnerabilityTypeId === "JW-INJECT-06") return ["distinct_accounts", "stored_xss", "persistent_mutation", "clean_state"];
  if (/^JW-(?:ACCESS|AUTHN|FILE|BUSINESS)-/.test(vulnerabilityTypeId)
    || new Set(["JW-INJECT-04", "JW-INTEGRITY-01", "JW-ERROR-01", "JW-RESILIENCE-01"]).has(vulnerabilityTypeId)) {
    return ["distinct_accounts", "persistent_mutation", "clean_state"];
  }
  return [];
}

function publicRun(run) {
  const { idempotency_digest, ephemeral_session_root, ...value } = run;
  return { ...value };
}

function safeEphemeralSessionRoot(path) {
  if (typeof path !== "string") return null;
  const resolved = resolve(path);
  return resolve(dirname(resolved)) === resolve(tmpdir()) && basename(resolved).startsWith("opencode-dynval-") ? resolved : null;
}

export class DynamicValidationRunner extends EventEmitter {
  constructor({ stateRoot, enabled = false, command = "opencode", spawnProcess = spawn, registryPath, rolesPath, authSourceRoot = null, resultValidator = null, browserBroker = null, platform = osPlatform(), architecture = osArch(), environment = process.env } = {}) {
    super();
    this.stateRoot = resolve(stateRoot);
    this.enabled = enabled;
    this.command = command;
    this.spawnProcess = spawnProcess;
    this.registryPath = resolve(registryPath);
    this.rolesPath = resolve(rolesPath);
    this.authSourceRoot = authSourceRoot ? resolve(authSourceRoot) : null;
    this.resultValidator = resultValidator;
    this.browserBroker = browserBroker ?? new BrowserSessionBroker({
      platform,
      desktopAvailable: platform !== "linux" || Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY),
    });
    this.platform = platform;
    this.architecture = architecture;
    this.environment = environment;
    this.runs = new Map();
    this.processes = new Map();
    this.subscribers = new Map();
    this.eventLogReader = new EventLogReader();
    this.queues = new Map();
    this.ready = this.initialize();
  }

  async initialize() {
    await mkdir(this.stateRoot, { recursive: true });
    const entries = await readdir(this.stateRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const run = JSON.parse(await readFile(join(this.stateRoot, entry.name, "run.json"), "utf8"));
        const ephemeralRoot = safeEphemeralSessionRoot(run.ephemeral_session_root);
        if (run.ephemeral_cleanup !== "SUCCEEDED" && ephemeralRoot) {
          await rm(ephemeralRoot, { recursive: true, force: true });
          run.ephemeral_cleanup = "SUCCEEDED";
          run.ephemeral_session_root = null;
        }
        if (["preparing", "running", "cancelling"].includes(run.status)) {
          run.status = "failed";
          run.error = "平台重启后无法恢复动态验证子进程；没有执行全局浏览器进程清理。";
          run.finished_at = new Date().toISOString();
        }
        run.updated_at = new Date().toISOString();
        this.runs.set(run.id, run);
        await this.persist(run);
      } catch {
        // Preserve invalid state directories for operator inspection.
      }
    }
  }

  enqueue(id, operation) {
    const prior = this.queues.get(id) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    this.queues.set(id, next);
    next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); }).catch(() => {});
    return next;
  }

  directory(id) {
    return join(this.stateRoot, createHash("sha256").update(id).digest("hex").slice(0, 32));
  }

  async persist(run) {
    const directory = this.directory(run.id);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `run.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, join(directory, "run.json"));
  }

  async record(run, type, data = {}) {
    return this.enqueue(run.id, async () => {
      run.updated_at = new Date().toISOString();
      run.version += 1;
      run.event_sequence += 1;
      const event = { event_id: `evt_${randomUUID()}`, validation_id: run.id, sequence: run.event_sequence, occurred_at: run.updated_at, type, data };
      await this.persist(run);
      await appendFile(join(this.directory(run.id), "events.jsonl"), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      for (const subscriber of this.subscribers.get(run.id) ?? []) subscriber(event);
      return event;
    });
  }

  listRuns() {
    return [...this.runs.values()].map(publicRun).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  getRun(id) {
    const run = this.runs.get(id);
    return run ? publicRun(run) : null;
  }

  async deleteAuditRuns(auditId) {
    await this.ready;
    const values = [...this.runs.values()].filter(run => run.audit_id === auditId);
    if (values.some(run => ["preparing", "running", "cancelling"].includes(run.status) || this.processes.has(run.id))) {
      throw Object.assign(new Error("该审计仍有动态验证正在运行；请先取消并等待验证结束。"), { statusCode: 409, code: "audit-validation-active" });
    }
    for (const run of values) {
      const queuedWrite = this.queues.get(run.id);
      if (queuedWrite) await queuedWrite;
      await rm(this.directory(run.id), { recursive: true, force: true });
      this.eventLogReader.files.delete(join(this.directory(run.id), "events.jsonl"));
      this.runs.delete(run.id);
      this.subscribers.delete(run.id);
      this.queues.delete(run.id);
    }
    return values.length;
  }

  async eventsSince(id, sequence = 0) {
    return this.eventLogReader.eventsSince(join(this.directory(id), "events.jsonl"), sequence);
  }

  subscribe(id, listener) {
    const listeners = this.subscribers.get(id) ?? new Set();
    listeners.add(listener);
    this.subscribers.set(id, listeners);
    return () => listeners.delete(listener);
  }

  async validateArtifacts({ repository, reportsRoot, runtimeRoot, requestDescriptor, authorization }) {
    if (resolve(runtimeRoot) !== resolve(reportsRoot, "validation-handoff", "runtime")) {
      throw Object.assign(new Error("动态验证 runtime root 必须位于工作台为该仓库分配的 reports 路径。"), { statusCode: 422, code: "validation-runtime-root-invalid" });
    }
    const requestPath = join(runtimeRoot, requestDescriptor.request_path);
    const [request, registry, roles, requestBytes] = await Promise.all([
      readJson(requestPath, runtimeRoot),
      JSON.parse(await readFile(this.registryPath, "utf8")), JSON.parse(await readFile(this.rolesPath, "utf8")),
      readFile(requestPath),
    ]);
    const requestErrors = validateExternalRuntimeValidationRequest(request);
    if (requestErrors.length) throw Object.assign(new Error(`密封验证请求无效：${requestErrors.join(", ")}`), { statusCode: 422, code: "validation-request-invalid" });
    const envelope = {
      schema_version: 1,
      contract_id: "P08_RUNTIME_VALIDATION.dynamic-vulnerability-validator",
      stage_id: "P08_RUNTIME_VALIDATION",
      direction: "INPUT",
      audit_id: request.audit_id,
      round: 1,
      agent_name: "dynamic-vulnerability-validator",
      agent_session_id: `manual-${createHash("sha256").update(request.packet_digest).digest("hex").slice(0, 24)}`,
      scope_binding: { state: "FROZEN", scope_digest: request.scope_digest },
      artifact_bindings: [{
        artifact_type: "external-runtime-validation-request",
        path: `reports/validation-handoff/runtime/${requestDescriptor.request_path}`,
        sha256: createHash("sha256").update(requestBytes).digest("hex"),
        media_type: "application/json",
        json_pointer: null,
      }],
      payload: {
        explicit_user_request: true,
        localhost_target: authorization.target.origin,
        attacker_account_supplied: Boolean(authorization.attacker),
        victim_account_supplied: Boolean(authorization.victim),
        login_instructions_supplied: Boolean(authorization.loginInstructions),
        cleanup_instructions_supplied: Boolean(authorization.cleanupInstructions),
      },
      constraints: ["LOOPBACK_ONLY", "SYNTHETIC_TEST_ACCOUNTS_ONLY", "NON_DESTRUCTIVE"],
    };
    envelope.envelope_digest = stageEnvelopeDigest(envelope);
    const envelopeErrors = validateStageEnvelope(envelope, registry, { roles });
    if (envelopeErrors.length) throw Object.assign(new Error(`动态验证授权 envelope 无效：${envelopeErrors.join(", ")}`), { statusCode: 422, code: "validation-request-invalid" });
    const envelopePath = join(runtimeRoot, request.audit_id, `${request.finding_id}.envelope-input.json`);
    const envelopeTemporary = `${envelopePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(envelopeTemporary, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(envelopeTemporary, envelopePath);
    if (request.audit_id !== requestDescriptor.audit_id || request.finding_id !== requestDescriptor.finding_id
      || envelope.audit_id !== request.audit_id || envelope.agent_name !== "dynamic-vulnerability-validator") {
      throw Object.assign(new Error("验证请求与 P08 envelope 绑定不一致。"), { statusCode: 422, code: "validation-binding-mismatch" });
    }
    const capability = await webValidationCapability(request.claim?.vulnerability_type_id);
    if (!capability) throw Object.assign(new Error("该漏洞类型不属于当前 Web 动态验证范围。"), { statusCode: 422, code: "validation-type-unsupported" });
    const envelopeTarget = validateLoopbackUrl(envelope.payload?.localhost_target);
    if (!envelopeTarget || envelopeTarget.origin !== authorization.target.origin) {
      throw Object.assign(new Error("表单目标与密封 P08 envelope 的 localhost origin 不一致。"), { statusCode: 409, code: "validation-target-binding-mismatch" });
    }
    const currentCommit = (await execFileAsync("git", ["-C", repository.path, "rev-parse", "HEAD"], { windowsHide: true, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout.trim();
    if (request.source_binding?.commit && request.source_binding.commit !== currentCommit) {
      throw Object.assign(new Error("当前仓库提交与密封验证请求不一致。"), { statusCode: 409, code: "validation-source-drift" });
    }
    return { request, envelope, requestPath, envelopePath, capability };
  }

  async create({ input, repository, reportsRoot, runtimeRoot, executionPaths, requestDescriptor, idempotencyKey }) {
    await this.ready;
    if (!this.enabled) throw Object.assign(new Error("动态验证 Runner 未启用。"), { statusCode: 503, code: "dynamic-runner-disabled" });
    if (!idempotencyKey || idempotencyKey.length > 200) throw Object.assign(new Error("缺少有效的 Idempotency-Key。"), { statusCode: 400, code: "idempotency-key-required" });
    if (!RUN_ID.test(requestDescriptor.id)) throw Object.assign(new Error("验证 ID 非法。"), { statusCode: 422, code: "validation-id-invalid" });
    const existing = this.runs.get(requestDescriptor.id);
    const digest = createHash("sha256").update(idempotencyKey).digest("hex");
    if (existing?.idempotency_digest === digest) return publicRun(existing);
    if (existing && ["preparing", "running", "cancelling"].includes(existing.status)) throw Object.assign(new Error("该 finding 已有动态验证正在运行。"), { statusCode: 409, code: "validation-active" });
    if (requestDescriptor.result_present) throw Object.assign(new Error("该 finding 已存在动态验证结果；默认拒绝覆盖。"), { statusCode: 409, code: "validation-result-exists" });
    const authorization = validateAuthorization(input);
    const artifacts = await this.validateArtifacts({ repository, reportsRoot, runtimeRoot, requestDescriptor, authorization });
    const browserSession = this.browserBroker.create({
      requested: authorization.browserMode,
      riskSignals: validationRiskSignals(artifacts.request.claim.vulnerability_type_id),
    });
    authorization.browserSession = browserSession;
    const now = new Date().toISOString();
    const run = {
      id: requestDescriptor.id,
      audit_id: requestDescriptor.audit_id,
      finding_id: requestDescriptor.finding_id,
      repository_id: repository.id,
      request_digest: artifacts.request.packet_digest,
      vulnerability_type_id: artifacts.request.claim.vulnerability_type_id,
      validator: artifacts.capability.validator,
      target_origin: authorization.target.origin,
      account_roles: authorization.accountMode === "distinct"
        ? { mode: "distinct", attacker: "authorized-test-attacker", victim: "authorized-test-victim", distinct: true }
        : authorization.accountMode === "shared"
          ? { mode: "shared", attacker: "authorized-shared-test-account", victim: "authorized-shared-test-account", distinct: false }
          : { mode: "anonymous", attacker: null, victim: null, distinct: false },
      browser_session_id: browserSession.id,
      browser_mode: browserSession.mode,
      browser_headless: browserSession.headless,
      browser_mode_reason: browserSession.reason,
      provider_session_id: null,
      status: "preparing",
      version: 1,
      event_sequence: 0,
      created_at: now,
      updated_at: now,
      finished_at: null,
      exit_code: null,
      error: null,
      ephemeral_cleanup: "PENDING",
      ephemeral_session_root: null,
      result_validation: "PENDING",
      idempotency_digest: digest,
    };
    this.runs.set(run.id, run);
    await this.persist(run);
    await this.record(run, "validation.preparing", { target_origin: run.target_origin });
    this.start({ run, repository, runtimeRoot, executionPaths, requestDescriptor, artifacts, authorization, input }).catch(async error => {
      run.status = "failed";
      run.error = genericRedact(error.message);
      run.finished_at = new Date().toISOString();
      await this.record(run, "validation.failed", { message: run.error });
    });
    return publicRun(run);
  }

  async start({ run, repository, runtimeRoot, executionPaths, requestDescriptor, artifacts, authorization, input }) {
    const ephemeral = await createEphemeralRuntimeRoot();
    run.ephemeral_session_root = ephemeral.root;
    await this.persist(run);
    const secrets = [authorization.attacker?.username, authorization.attacker?.password, authorization.victim?.username, authorization.victim?.password];
    const prompt = validationPrompt({ ...artifacts, ...authorization, browserSession: authorization.browserSession, repository, executionPaths });
    const authorizationFile = join(ephemeral.root, "dynamic-validation-authorization.txt");
    await writeFile(authorizationFile, prompt, { encoding: "utf8", mode: 0o600 });
    let child;
    try {
      const model = normalizeOpenCodeModel(requestDescriptor.model);
      const openCodeEnvironment = await buildOpenCodeEnvironment(repository.config_path, this.environment);
      const runtimeConfig = JSON.parse(openCodeEnvironment.OPENCODE_CONFIG_CONTENT || "{}");
      runtimeConfig.mcp = { ...(runtimeConfig.mcp ?? {}), "chrome-devtools": authorization.browserSession.mcp };
      openCodeEnvironment.OPENCODE_CONFIG_CONTENT = JSON.stringify(runtimeConfig);
      const executableCandidates = this.platform === "win32"
        ? await resolvedOpenCodeExecutables({ command: this.command, environment: this.environment, platform: this.platform, architecture: this.architecture })
        : [];
      const executable = executableCandidates[0] ?? this.command;
      child = this.spawnProcess(executable, ["run", "请读取所附授权说明并严格按 dynamic-vulnerability-validator 契约执行。", "--format", "json", ...(model ? ["--model", model] : []), "--agent", "dynamic-vulnerability-validator", "--dir", executionPaths.workspace_root, "--title", `动态验证 ${run.audit_id}/${run.finding_id}`, "--file", authorizationFile], {
        cwd: executionPaths.workspace_root,
        env: {
          ...openCodeEnvironment,
          AUDIT_SOURCE_ROOT: executionPaths.source_root,
          AUDIT_ENGINE_ROOT: resolve(dirname(repository.config_path), ".."),
          AUDIT_WORKSPACE_ROOT: executionPaths.workspace_root,
          AUDIT_REPORTS_ROOT: executionPaths.reports_root,
          AUDIT_TMP_ROOT: executionPaths.tmp_root,
          TMPDIR: ephemeral.tempHome,
          ...(this.platform === "win32" ? { TEMP: ephemeral.tempHome, TMP: ephemeral.tempHome } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      secrets.fill("");
      await rm(ephemeral.root, { recursive: true, force: true });
      run.ephemeral_cleanup = "SUCCEEDED";
      run.ephemeral_session_root = null;
      try { await this.browserBroker.close(authorization.browserSession.id); }
      catch (cleanupError) { error.browser_cleanup_error = genericRedact(cleanupError.message); }
      throw error;
    }
    const processState = { child, ephemeral, secrets, browserSessionId: authorization.browserSession.id, stderrTail: "" };
    this.processes.set(run.id, processState);
    run.status = "running";
    run.pid = child.pid ?? null;
    const startedEvent = this.record(run, "validation.started", { pid: run.pid });
    const capture = (stream, source) => {
      let buffer = "";
      stream?.setEncoding?.("utf8");
      stream?.on("data", chunk => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (source === "stdout" && !run.provider_session_id) {
            try {
              const event = JSON.parse(line);
              const sessionId = event.sessionID ?? event.part?.sessionID;
              if (typeof sessionId === "string" && /^ses_[A-Za-z0-9]+$/.test(sessionId)) {
                run.provider_session_id = sessionId;
                this.record(run, "validation.provider-session-identified", { provider_session_id: sessionId }).catch(() => {});
              }
            } catch {}
          }
          if (source === "stderr") processState.stderrTail = redact(line, secrets);
          this.log(run, source, line, secrets).catch(() => {});
        }
      });
    };
    capture(child.stdout, "stdout");
    capture(child.stderr, "stderr");
    child.once("error", error => { run.error = redact(error.message, secrets); });
    child.once("close", (code, signal) => startedEvent.then(() => this.finish({ run, repository, runtimeRoot, requestDescriptor, code, signal })).catch(() => {}));
    await startedEvent;
  }

  async log(run, source, line, secrets) {
    const message = redact(line, secrets);
    if (!message) return;
    await appendFile(join(this.directory(run.id), "runner.log.jsonl"), `${JSON.stringify({ occurred_at: new Date().toISOString(), source, message })}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async validateResultArtifacts({ run, repository, runtimeRoot, requestDescriptor }) {
    if (this.resultValidator) return this.resultValidator({ run: publicRun(run), repository, runtimeRoot, requestDescriptor });
    const xss = run.vulnerability_type_id === "JW-INJECT-06";
    const validator = join(dirname(repository.config_path), "skills", "dynamic-vulnerability-validator-subagent",
      xss ? "web-xss-runtime-validation" : "web-runtime-validation", "scripts",
      xss ? "validate-web-xss-runtime-result.mjs" : "validate-web-runtime-result.mjs");
    await execFileAsync(process.execPath, [
      validator,
      "--request", join(runtimeRoot, requestDescriptor.request_path),
      "--target", join(runtimeRoot, run.audit_id, `${run.finding_id}.target.json`),
      "--result", join(runtimeRoot, run.audit_id, `${run.finding_id}.result.json`),
    ], { cwd: repository.path, windowsHide: true, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
  }

  async finish({ run, repository, runtimeRoot, requestDescriptor, code, signal }) {
    const processState = this.processes.get(run.id);
    this.processes.delete(run.id);
    try {
      const resultPath = join(runtimeRoot, run.audit_id, `${run.finding_id}.result.json`);
      let resultPresent = false;
      try { resultPresent = (await stat(resultPath)).isFile(); } catch {}
      run.exit_code = code;
      run.finished_at = new Date().toISOString();
      run.pid = null;
      if (run.status === "cancelling") run.status = "cancelled";
      else if (code === 0 && resultPresent) {
        try {
          await this.validateResultArtifacts({ run, repository, runtimeRoot, requestDescriptor });
          run.result_validation = "PASSED";
          run.status = "completed";
        } catch (error) {
          run.result_validation = "FAILED";
          run.status = "failed";
          run.error = `动态验证结果未通过确定性校验：${genericRedact(error.message)}`;
        }
      } else run.status = "failed";
      if (!resultPresent && run.status === "failed" && !run.error) {
        run.error = processState?.stderrTail
          ? `OpenCode 未生成动态验证结果：${processState.stderrTail}`
          : "OpenCode 结束时没有生成绑定的动态验证结果。";
      }
      if (signal && !run.error) run.error = `进程由信号 ${signal} 结束。`;
      await this.record(run, `validation.${run.status}`, { exit_code: code, result_present: resultPresent });
    } finally {
      if (processState?.secrets) processState.secrets.fill("");
      if (processState?.browserSessionId) {
        try {
          await this.browserBroker.close(processState.browserSessionId);
          run.browser_cleanup = "SUCCEEDED";
        } catch (error) {
          run.browser_cleanup = "FAILED";
          run.status = "failed";
          run.error = `受管浏览器资源清理失败：${genericRedact(error.message)}`;
          await this.record(run, "validation.browser-cleanup-failed", { message: run.error });
        }
      }
      try {
        if (processState?.ephemeral?.root) await rm(processState.ephemeral.root, { recursive: true, force: true });
        run.ephemeral_cleanup = "SUCCEEDED";
        run.ephemeral_session_root = null;
        await this.record(run, "validation.ephemeral-session-removed", {});
      } catch (error) {
        run.ephemeral_cleanup = "FAILED";
        run.status = "failed";
        run.error = `临时 OpenCode 会话目录清理失败：${genericRedact(error.message)}`;
        await this.record(run, "validation.ephemeral-session-cleanup-failed", { message: run.error });
      }
    }
  }

  async cancel(id) {
    const run = this.runs.get(id);
    const processState = this.processes.get(id);
    if (!run || !processState || run.status !== "running") throw Object.assign(new Error("该动态验证当前不可取消。"), { statusCode: 409, code: "validation-cancel-not-allowed" });
    run.status = "cancelling";
    await this.record(run, "validation.cancelling", {});
    if (!processState.child.kill("SIGTERM")) throw new Error("取消信号发送失败。");
    return publicRun(run);
  }

  health() {
    return { enabled: this.enabled, active_processes: this.processes.size, persistent_opencode_sessions: true, ephemeral_authorization_files: true, browser_session_policy: "managed" };
  }

  async shutdown() {
    await this.ready;
    for (const [id, processState] of this.processes) {
      const run = this.runs.get(id);
      if (!run || run.status === "cancelling") continue;
      run.status = "cancelling";
      await this.record(run, "validation.cancelling", { reason: "workbench-shutdown" });
      processState.child.kill("SIGTERM");
    }
  }
}
