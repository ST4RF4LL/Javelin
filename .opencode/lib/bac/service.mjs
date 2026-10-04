import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BAC_CONTRACT, BAC_TYPES, bacForUnit, boundFile, inside, interfacesForUnit, isTaskPlan, nonempty, objectDigest, planBinding, requireBac, seal, sha256,
  unitForPlan, unitForRequest, validateComparison, validateReview, validateRun, verifiedPlan, verifyEvidenceSources } from "./contract.mjs";

const execute = promisify(execFile);
const corePath = fileURLToPath(new URL("../../skills/common-subagent/detect-bac-risks/scripts/analyze_bac.py", import.meta.url));
const json = path => readFile(resolve(path), "utf8").then(JSON.parse);
async function writeJson(path, value, options = {}) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", ...options });
}
function safeId(value) { requireBac(typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value), "运行标识无效。"); return value; }
async function outputRoot(reportsRoot, sourceRoot) {
  const output = await realpath(reportsRoot), source = await realpath(sourceRoot);
  requireBac(output !== source && !inside(source, output), "交付目录不得位于源码根目录内。");
  return output;
}
export async function outputDirectory(root, directory) {
  requireBac(root === directory || inside(root, directory), "输出子目录越界。");
  let current = root;
  for (const part of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = await lstat(current);
    requireBac(info.isDirectory() && !info.isSymbolicLink() && inside(root, await realpath(current)), "输出子目录不能经过符号链接。");
  }
  return directory;
}
export async function writeImmutableJson(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try { await writeFile(path, text, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const info = await lstat(path);
    requireBac(info.isFile() && !info.isSymbolicLink() && await readFile(path, "utf8") === text, "已封存制品不同，必须使用新的运行标识。");
  }
}

export async function taskPolicyInputs(plan) {
  const refs = plan.task.bac_analysis?.policy_shards ?? [];
  requireBac(refs.length && plan.task.bac_analysis.resource_role_catalog, "当前任务未绑定独立策略分片和资源角色目录，请保留策略缺口。");
  const shards = [];
  for (const ref of refs) {
    const { value } = await boundFile(plan.reports_root, ref);
    requireBac(value.contract_version === BAC_CONTRACT && value.artifact_type === "bac-policy-shard" && value.audit_id === plan.audit_id && value.scope_digest === plan.scope_digest
      && (value.task_ids?.includes(plan.task.task_id) || value.consumed_bindings?.linked_task_id === plan.task.task_id), "策略分片不属于当前任务或冻结范围。");
    requireBac(value.acp?.repository?.root === plan.source_root && value.acp.repository.scope_digest === plan.scope_digest
      && value.acp.producer?.agent_name === "security-threat-modeler" && nonempty(value.acp.producer.agent_session_id), "策略分片的源码或独立生产者无效。");
    shards.push(value.acp);
  }
  requireBac(new Set(shards.map(row => row.producer.agent_session_id)).size === 1, "同一任务的策略分片须来自同一独立策略会话。");
  const acp = structuredClone(shards[0]);
  for (const key of ["quadruples", "unresolved", "out_of_model", "limitations"]) acp[key] = shards.flatMap(row => row[key] ?? []);
  // Exact duplicate tuples are shared evidence; conflicting AC values remain visible to the engine.
  acp.quadruples = [...new Map(acp.quadruples.map(row => [objectDigest(row), row])).values()];
  acp.coverage = { status: shards.every(row => row.coverage?.status === "COMPLETE") ? "COMPLETE" : "PARTIAL",
    evidence: shards.flatMap(row => row.coverage?.evidence ?? []), known_gaps: shards.flatMap(row => row.coverage?.known_gaps ?? []) };
  const { value: catalog } = await boundFile(plan.reports_root, plan.task.bac_analysis.resource_role_catalog);
  requireBac(catalog.contract_version === BAC_CONTRACT && catalog.artifact_type === "bac-resource-role-catalog" && catalog.audit_id === plan.audit_id && catalog.scope_digest === plan.scope_digest, "资源角色目录与当前范围不匹配。");
  const sourceCatalog = catalog.resource_role_catalog ?? catalog;
  const resource_role_catalog = Object.fromEntries(["resources", "roles", "aliases", "known_gaps"].map(key => [key, sourceCatalog[key]]));
  return { acp, resource_role_catalog };
}

export async function prepareBac({ planPath, sourceRoot, reportsRoot, focusAreaId, assignmentId, taskId, attemptId, sessionId, runId }) {
  const plan = await verifiedPlan(planPath);
  const identity = isTaskPlan(plan) ? { task_id: taskId, attempt_id: attemptId } : { focus_area_id: focusAreaId, assignment_id: assignmentId };
  const unit = unitForPlan(plan, identity);
  requireBac(unit && bacForUnit(plan, unit), "此工作包未启用越权专项。");
  requireBac(nonempty(sessionId), "缺少源码工作包真实会话 ID。");
  const output = await outputRoot(reportsRoot, sourceRoot);
  const interfaces = interfacesForUnit(plan, unit);
  const repository = { root: await realpath(sourceRoot), scope_digest: plan.scope_digest, revision: "unknown" };
  const producer = { agent_name: unit.agent_name, agent_session_id: sessionId };
  const request = {
    contract_version: BAC_CONTRACT, audit_id: plan.audit_id, scope_digest: plan.scope_digest,
    ...identity, ...(isTaskPlan(plan) ? { plan_digest: plan.artifact_digest } : {}), producer, run_id: safeId(runId),
    plan_path: resolve(planPath), source_root: repository.root,
    resource_role_catalog: { resources: [], roles: [], aliases: [], known_gaps: ["尚待依据数据库定义、实体与权限配置建立规范映射。"] },
    acp: { schema_version: "1.0", repository, producer: { agent_name: "security-threat-modeler", agent_session_id: null },
      coverage: { status: "PARTIAL", evidence: [], known_gaps: ["待独立策略会话提取预期权限。"] }, quadruples: [], unresolved: [], out_of_model: [], limitations: [] },
    paths: { schema_version: "1.0", repository, producer, coverage: { status: "PARTIAL", evidence: [], known_gaps: ["待源码工作包恢复实际数据库路径。"] }, paths: [], limitations: [] },
    api_catalog: { schema_version: "1.0", repository, coverage: { status: "PARTIAL", evidence: [], known_gaps: ["冻结入口只是线索，仍须核对框架绑定、数据库相关性与遗漏入口。"] },
      apis: interfaces.map(row => ({ api_id: row.api_id ?? row.interface_id, interface_id: row.interface_id, operation: row.operation,
        address: row.address, protocol: row.protocol, interface_type: "OTHER", database_relevant: null })) },
  };
  if (isTaskPlan(plan)) {
    requireBac(repository.root === plan.source_root && output === plan.reports_root, "任务计划与当前源码或交付根目录不同。");
    Object.assign(request, await taskPolicyInputs(plan));
    requireBac(request.acp.producer.agent_session_id !== sessionId, "策略与源码必须使用独立会话。");
  }
  const path = join(output, "bac", safeId(plan.audit_id), "drafts", `${safeId(runId)}.request.json`);
  await outputDirectory(output, dirname(path));
  await writeJson(path, request, { flag: "wx" });
  return { request_path: path, expected_interfaces: interfaces.length, status: "NEEDS_FACTS" };
}

export function validateRequest(request, plan) {
  const unit = unitForRequest(plan, request);
  requireBac(bacForUnit(plan, unit), "冻结 Plan 未启用专项。");
  if (isTaskPlan(plan)) requireBac(request.plan_digest === plan.artifact_digest && request.source_root === plan.source_root, "请求与当前任务计划摘要不一致。");
  for (const data of [request.acp, request.paths, request.api_catalog]) {
    requireBac(data && data.repository?.scope_digest === plan.scope_digest && data.repository?.root === request.source_root, "所有输入必须绑定同一源码根目录和冻结范围。");
  }
  requireBac(request.paths.producer?.agent_session_id === request.producer.agent_session_id && request.paths.producer?.agent_name === unit.agent_name, "实际路径生产者与当前工作包不符。");
  requireBac(request.acp.producer?.agent_name === "security-threat-modeler" && nonempty(request.acp.producer?.agent_session_id)
    && request.acp.producer.agent_session_id !== request.producer.agent_session_id, "预期策略必须由独立策略会话产生。");
  requireBac(Array.isArray(request.acp.quadruples) && Array.isArray(request.paths.paths) && Array.isArray(request.api_catalog.apis), "输入集合缺失。");
  const expected = interfacesForUnit(plan, unit);
  const allowedIds = new Set(expected.map(row => row.api_id ?? row.interface_id));
  const apis = new Map(request.api_catalog.apis.map(row => [row.api_id, row]));
  requireBac(apis.size === request.api_catalog.apis.length && [...allowedIds].every(id => apis.has(id)), "API 清单遗漏或重复冻结入口。");
  for (const api of apis.values()) {
    requireBac(nonempty(api.api_id), "入口 ID 不能为空。");
    if (!allowedIds.has(api.api_id)) requireBac(Array.isArray(api.evidence) && api.evidence.length > 0, "补充入口须有源码证据。");
    if (api.database_relevant === false) requireBac(Array.isArray(api.evidence) && api.evidence.length > 0, "排除数据库相关性须有证据。");
  }
  for (const path of request.paths.paths) {
    requireBac(apis.has(path.api_id), "路径必须引用清单中的入口。");
    requireBac(apis.get(path.api_id).database_relevant !== false, "已存在数据库访问路径的入口不能声明为非数据库相关。");
    requireBac(path.sink?.location && typeof path.sink.location === "object" && path.entrypoint?.location && typeof path.entrypoint.location === "object", "路径必须有结构化入口和 sink 位置。");
    requireBac(Array.isArray(path.call_chain) && path.call_chain.length > 0, "路径必须保存实际调用链。");
    if (path.policy_binding) requireBac(nonempty(path.caller_context?.principal) && Array.isArray(path.caller_context?.roles)
      && path.caller_context.roles.every(nonempty), "调用者身份与策略角色必须分别描述。");
    for (const step of path.call_chain) requireBac(nonempty(step?.symbol) && Array.isArray(step.evidence) && step.evidence.length > 0, "实际调用链节点必须有符号与源码依据。");
  }
  requireBac(request.resource_role_catalog && ["resources", "roles", "aliases", "known_gaps"].every(key => Array.isArray(request.resource_role_catalog[key])), "缺少资源与角色规范映射。");
  const resourceIds = new Set(request.resource_role_catalog.resources.map(row => row.D));
  const excludedResources = new Set(request.resource_role_catalog.resources.filter(row => row.classification === "OUT_OF_MODEL").map(row => row.D));
  const roleIds = new Set(request.resource_role_catalog.roles.map(row => row.R));
  requireBac([...resourceIds, ...roleIds].every(nonempty) && ![...roleIds].some(role => role.toUpperCase() === "UNKNOWN"), "资源或角色规范名无效。");
  requireBac(resourceIds.size === request.resource_role_catalog.resources.length && roleIds.size === request.resource_role_catalog.roles.length, "资源/角色规范名重复。");
  for (const row of [...request.resource_role_catalog.resources, ...request.resource_role_catalog.roles, ...request.resource_role_catalog.aliases]) {
    requireBac(Array.isArray(row.evidence) && row.evidence.length, "规范名映射缺少源码依据。");
  }
  for (const row of request.acp.quadruples) requireBac(resourceIds.has(row.tuple?.D) && !excludedResources.has(row.tuple?.D) && roleIds.has(row.tuple?.R), "ACP 使用了未登记的数据库资源、模型外对象或角色。");
  for (const row of request.resource_role_catalog.aliases) requireBac(nonempty(row.alias) && (resourceIds.has(row.canonical) || roleIds.has(row.canonical)), "别名必须引用已登记的资源或角色规范名。");
  return unit;
}

export async function compareBac({ requestPath, reportsRoot, environment = process.env, executeFile = execute }) {
  const request = await json(requestPath), plan = await verifiedPlan(request.plan_path);
  const unit = validateRequest(request, plan);
  if (isTaskPlan(plan)) {
    const policies = await taskPolicyInputs(plan);
    requireBac(Object.entries(policies).every(([key, value]) => objectDigest(request[key]) === objectDigest(value)), "请求不得修改已绑定的独立策略或规范目录。");
  }
  const root = await outputRoot(reportsRoot, request.source_root);
  const files = await verifyEvidenceSources(plan, request.source_root, [request.acp, request.paths, request.api_catalog, request.resource_role_catalog]);
  const base = join(root, "bac", safeId(request.audit_id), "runs");
  await outputDirectory(root, base);
  const scratch = await mkdtemp(join(base, ".pending-"));
  try {
    const acp = structuredClone(request.acp);
    acp.limitations = [...(acp.limitations ?? []), ...request.resource_role_catalog.known_gaps];
    await writeJson(join(scratch, "acp.json"), acp);
    await writeJson(join(scratch, "paths.json"), request.paths);
    await writeJson(join(scratch, "apis.json"), request.api_catalog);
    const python = environment.AUDIT_BAC_PYTHON || (process.platform === "win32" ? "python" : "python3");
    const response = await executeFile(python, ["-I", "-B", "-X", "utf8", corePath, "--acp", join(scratch, "acp.json"), "--paths", join(scratch, "paths.json"),
      "--api-catalog", join(scratch, "apis.json"), "--markdown", join(scratch, "bac-findings.md")],
    { shell: false, windowsHide: true, encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024,
      env: { ...environment, PYTHONIOENCODING: "utf-8" } });
    const result = validateComparison(JSON.parse(response.stdout), request);
    const run = seal({ contract_version: BAC_CONTRACT, artifact_type: "bac-run", audit_id: request.audit_id,
      scope_digest: request.scope_digest, ...(isTaskPlan(plan) ? { task_id: request.task_id, attempt_id: request.attempt_id }
        : { focus_area_id: request.focus_area_id, assignment_id: request.assignment_id }),
      producer: request.producer, run_id: safeId(request.run_id), engine_version: "bac-comparison.v1",
      engine_sha256: sha256(await readFile(corePath)), source_index_digest: objectDigest(plan.source_index),
      plan_binding: planBinding(plan, unit), input_digest: objectDigest(request), input: request, inspected_files: files, result });
    await writeJson(join(scratch, "bac-findings.json"), run);
    const sarif = { version: "2.1.0", $schema: "https://json.schemastore.org/sarif-2.1.0.json", runs: [{ tool: { driver: { name: "BAC policy-path comparison", version: "1.0", rules: ["BVAC_CANDIDATE", "BHAC_CANDIDATE", "BVAC_BHAC_CANDIDATE"].map(id => ({ id, shortDescription: { text: "越权静态差分候选，须独立复核。" } })) } },
      results: result.findings.map(finding => ({ ruleId: finding.classification, level: "warning", message: { text: finding.root_cause },
        locations: [{ physicalLocation: { artifactLocation: { uri: finding.sink.location.file.split("\\").join("/").split("/").map(encodeURIComponent).join("/") }, region: { startLine: finding.sink.location.line_start } } }],
        properties: { bac_finding_id: finding.finding_id, validation_status: "NOT_PERFORMED" } })) }] };
    await writeJson(join(scratch, "result.sarif"), sarif);
    const manifest = seal({ contract_version: BAC_CONTRACT, artifact_type: "bac-run-manifest", audit_id: request.audit_id,
      scope_digest: request.scope_digest, run_digest: run.artifact_digest, artifacts: await Promise.all(["bac-findings.json", "bac-findings.md", "result.sarif", "acp.json", "paths.json", "apis.json"].map(async path => ({ path, sha256: sha256(await readFile(join(scratch, path))) }))) });
    await writeJson(join(scratch, "manifest.json"), manifest);
    const destination = join(base, safeId(request.run_id));
    // rename cannot replace a non-empty prior run; published bundles are immutable.
    await rename(scratch, destination);
    return { status: result.summary.analysis_complete && !result.out_of_model.length ? "COMPLETE" : "PARTIAL", run_path: join(destination, "bac-findings.json"),
      run: { path: relative(root, join(destination, "bac-findings.json")).split("\\").join("/"), sha256: sha256(await readFile(join(destination, "bac-findings.json"))) },
      candidates: result.findings.length, gaps: result.limitations.length + result.out_of_model.length + Object.values(result.coverage_gaps).reduce((sum, rows) => sum + rows.length, 0) };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export async function reviewBac({ runPath, reviewPath, reportsRoot }) {
  const run = validateRun(await json(runPath)), reviewInput = await json(reviewPath);
  const plan = await verifiedPlan(run.input.plan_path);
  const unit = validateRequest(run.input, plan);
  if (isTaskPlan(plan)) {
    const policies = await taskPolicyInputs(plan);
    requireBac(Object.entries(policies).every(([key, value]) => objectDigest(run.input[key]) === objectDigest(value)), "差分中的独立策略输入发生变化。");
  }
  requireBac(objectDigest(run.plan_binding) === objectDigest(planBinding(plan, unit)) && run.source_index_digest === objectDigest(plan.source_index), "Plan 已变化，不能复用旧差分。");
  validateComparison(run.result, run.input);
  validateReview(reviewInput, run, plan);
  await verifyEvidenceSources(plan, run.input.source_root, [run.input.acp, run.input.paths, run.input.api_catalog, run.input.resource_role_catalog, reviewInput]);
  const root = await outputRoot(reportsRoot, run.input.source_root);
  const absRun = await realpath(runPath);
  requireBac(inside(root, absRun), "差分制品不在交付目录中。");
  requireBac(!(await lstat(runPath)).isSymbolicLink(), "差分制品不能是符号链接。");
  await outputDirectory(root, dirname(absRun));
  const review = seal({ ...reviewInput, artifact_type: "bac-review" });
  const out = join(dirname(absRun), "review.json");
  await writeImmutableJson(out, review);
  const incomplete = !run.result.summary.analysis_complete || run.result.out_of_model.length || review.decisions.some(row => row.disposition === "INCONCLUSIVE");
  const attachment = { contract_version: BAC_CONTRACT, status: incomplete ? "PARTIAL" : "COMPLETE",
    run: { path: relative(root, absRun).split("\\").join("/"), sha256: sha256(await readFile(absRun)) },
    review: { path: relative(root, out).split("\\").join("/"), sha256: sha256(await readFile(out)) } };
  await writeImmutableJson(join(dirname(absRun), "attachment.json"), attachment);
  return { attachment, findings: review.decisions.filter(row => row.disposition === "ACCEPTED").map(row => row.finding) };
}

export async function prepareReview({ runPath, output }) {
  const run = validateRun(await json(runPath));
  await outputRoot(dirname(resolve(output)), run.input.source_root);
  const value = { contract_version: BAC_CONTRACT, audit_id: run.audit_id, scope_digest: run.scope_digest,
    producer: run.producer, run_digest: run.artifact_digest,
    decisions: run.result.findings.map(row => ({ bac_finding_id: row.finding_id, disposition: "INCONCLUSIVE", reason: "尚未完成源码复查与 Finding v2 证据补全。" })) };
  await writeJson(resolve(output), value, { flag: "wx" });
  return { output: resolve(output), candidates: value.decisions.length, ...(isTaskPlan(run.plan_binding)
    ? { routing: { protocol: "task-board.v1", task_id: run.task_id, attempt_id: run.attempt_id, domain: run.plan_binding.task.domain }, vulnerability_type_ids: [...BAC_TYPES] }
    : { checks: run.plan_binding.checks.filter(row => row.lens === "control-driven" && BAC_TYPES.has(row.vulnerability_type_id)) }) };
}
