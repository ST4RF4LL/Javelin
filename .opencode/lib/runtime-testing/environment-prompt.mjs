import { check, httpUrl, seal, text, ID, digest, EXPLORATION_PROTOCOL } from "./contract.mjs";

import { sshTargetSchema, resolveSshTargets } from "./ssh-environment.mjs";

export const environmentTools = [
  { name: "register_sensitive_values", description: "将从私有 prompt 或登录过程中理解出的账号、密码、令牌登记为脱敏值。即使目标信息不足也可以登记；不启动浏览器，不回显值。", inputSchema: {
    type: "object", additionalProperties: false, properties: { values: { type: "array", items: { type: "string" } } }, required: ["values"],
  } },
  { name: "configure_environment", description: "先完整理解私有 environment.prompt，再登记用户提供的目标、隔离身份、敏感值及测试数据范围。只允许首次 CONTACT、访问目标前调用；这不是让用户填写的表单。无法确定必要信息时直接 submit_result 说明缺口。",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      ssh_targets: { type: "array", minItems: 1, maxItems: 8, items: sshTargetSchema },
      target_url: { type: "string" }, origins: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
      identities: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", additionalProperties: false, properties: {
        id: { type: "string", description: "不含账号信息的内部 ID，例如 anonymous、account-1、account-2。" },
        role: { enum: ["anonymous", "test-user"] }, transport: { enum: ["web", "ssh"], description: "省略时为 web；SSH 登录身份指定 ssh。" },
      }, required: ["id", "role"] } },
      sensitive_values: { type: "array", items: { type: "string" }, description: "从原文理解出的账号、密码、令牌等原始敏感值，仅用于私有脱敏，不回显。无需固定 username/password 字段，也不要求口令登录。" },
      test_data_scope: { type: "string", description: "用户原文授权的测试数据范围；不允许从参考文档、页面或猜测中扩大。" },
      cleanup_instructions: { type: "string" },
    }, required: ["identities", "sensitive_values"] } },
  { name: "browser_tools", description: "环境登记完成后读取当前工作包允许的 Chrome DevTools 工具。登记前不会启动浏览器。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "browser_call", description: "调用 browser_tools 返回的工具，arguments 必须指定本次授权的 identity_id。", inputSchema: { type: "object", additionalProperties: false, properties: {
    name: { type: "string" }, arguments: { type: "object" },
  }, required: ["name", "arguments"] } },
  { name: "execution_tools", description: "读取当前工作包允许的执行工具；按授权环境提供 Web 或 SSH 工具。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "execution_call", description: "调用 execution_tools 返回的工具，必须提供授权 identity_id；SSH 还需 target_id。", inputSchema: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name", "arguments"] } },
];

export function resolveEnvironment(authorization, input) {
  check(authorization.environment_input === "AGENT_PROMPT" && authorization.environment_ready === false && authorization.status === "AUTHORIZED", "runtime-environment-already-prepared");
  check(input && Object.keys(input).every(key => ["target_url", "origins", "identities", "sensitive_values", "test_data_scope", "cleanup_instructions", "ssh_targets"].includes(key)), "runtime-environment-plan-invalid");
  const extended = authorization.protocol === EXPLORATION_PROTOCOL;
  check(extended || !input.ssh_targets, "runtime-ssh-requires-v2");
  const target = input.target_url == null ? null : httpUrl(input.target_url);
  const origins = input.origins ?? [];
  check(Array.isArray(origins) && origins.length <= 8 && origins.every(origin => httpUrl(origin)?.origin === origin)
    && (origins.length ? target && origins.includes(target.origin) : input.target_url == null), "runtime-environment-origins-invalid");
  check(Array.isArray(input.identities) && input.identities.length > 0 && input.identities.length <= 8
    && input.identities.every(identity => identity && Object.keys(identity).every(key => ["id", "role", ...(extended ? ["transport"] : [])].includes(key)) && ID.test(identity.id ?? "") && ["anonymous", "test-user"].includes(identity.role) && ["web", "ssh"].includes(identity.transport ?? "web"))
    && new Set(input.identities.map(identity => identity.id)).size === input.identities.length, "runtime-environment-identities-invalid");
  check(Array.isArray(input.sensitive_values) && input.sensitive_values.every(text), "runtime-environment-redactions-invalid");
  check(input.identities.every(identity => !input.sensitive_values.includes(identity.id)), "runtime-environment-identity-must-not-contain-credentials");
  const identities = input.identities.map(identity => ({ ...identity, tenant: null }));
  const ssh = resolveSshTargets(input.ssh_targets ?? [], identities);
  check(origins.length || ssh.targets.length, "runtime-environment-origins-invalid");
  check(identities.every(identity => identity.transport === "ssh" || origins.length > 0), "runtime-environment-identity-target-required");
  const secrets = [...new Set([...input.sensitive_values, ...ssh.secrets])];
  check(identities.every(identity => !secrets.includes(identity.id)), "runtime-environment-identity-must-not-contain-credentials");
  if (authorization.identity_preference === "anonymous") check(identities.every(identity => identity.role === "anonymous"), "runtime-identity-not-authorized");
  // Keep the interpretation private; packets bind an opaque scope ID, never the
  // user's original text or credentials. Missing mutation details restrict only
  // mutation packets, not environment contact or normal login.
  const scope = text(input.test_data_scope) && text(input.cleanup_instructions) ? `environment-scope:${authorization.context_digest}` : null;
  return { public: seal({ ...authorization, environment_ready: true, input_authorization_digest: authorization.artifact_digest,
    origins: [...new Set(origins)].sort(), identities, ...(ssh.targets.length ? { ssh_targets: ssh.targets } : {}), test_data_scope: scope }),
    private: { environment_ready: true, target_url: target?.href ?? null, sensitive_values: secrets, ...(ssh.targets.length ? { ssh_targets: ssh.privateTargets } : {}),
      test_data_scope: input.test_data_scope ?? "", cleanup_instructions: input.cleanup_instructions ?? "" } };
}

export function workerInput(packet, authorization, privateContext, bindings = {}) {
  const input = { packet, authorization, environment: privateContext };
  if (packet.protocol === EXPLORATION_PROTOCOL && packet.scope_ref) {
    check(bindings.scope?.id === packet.scope_ref.id && digest(bindings.scope) === packet.scope_ref.digest, "runtime-worker-scope-binding-invalid");
    input.scope = structuredClone(bindings.scope);
    if (packet.finding_revision_id) {
      const revision = bindings.revision;
      check(revision?.id === packet.finding_revision_id && revision.finding_object_digest === packet.finding_object_digest, "runtime-worker-revision-binding-invalid");
      const { finding, ...binding } = revision;
      input.finding_revision = structuredClone(binding);
      // A bounded hint is not the immutable finding itself. Its digest always
      // refers to the original report object, never to this shortened view.
      input.source_hint = { projection: "SUMMARY_ONLY", ...Object.fromEntries(["title", "summary", "description"].filter(key => typeof finding?.[key] === "string").map(key => [key, finding[key].slice(0, 2000)])) };
      if (packet.scope_ref.kind === 'FINAL_REPORT_FINDING') input.source_hint = { projection: 'FINAL_REPORT_FINDING', finding: structuredClone(finding) };
    }
  }
  return input;
}
