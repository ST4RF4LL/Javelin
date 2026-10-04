import { mkdir, readFile, realpath, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { queryKnowledge } from "../knowledge-workflow.mjs";
import { atomicJson } from "../task-board/contract.mjs";
import { PROFILE, PROTOCOL, SURFACES, FAMILIES, selection } from "./profile.mjs";
import { check, digest, hash, inside, inventory, sourceBytes } from "./inventory.mjs";

const chinese = value => typeof value === "string" && value.length <= 6000 && /\p{Script=Han}/u.test(value);
const id = value => typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,159}$/i.test(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const seal = value => ({ ...value, artifact_digest: digest(value) });
export async function jsonFile(path) {
  const info = await lstat(path);
  check(info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024, "分析制品必须是有界普通文件。");
  return JSON.parse(await readFile(path, "utf8"));
}
async function outputDirectory(sourceRoot, outputRoot) {
  const source = await realpath(sourceRoot), target = resolve(outputRoot);
  // Check the existing ancestor before mkdir, including symlinked parents.
  let parent = target;
  while (true) { try { await lstat(parent); break; } catch (error) { if (error.code !== "ENOENT") throw error; parent = dirname(parent); } }
  check(!inside(source, await realpath(parent)), "挖掘产物不得写入只读源码根。");
  await mkdir(target, { recursive: true });
  const output = await realpath(target);
  check(!inside(source, output), "挖掘产物不得写入只读源码根。");
  return output;
}

export async function prepareMining({ sourceRoot, outputRoot, auditId, taskId, attemptId, scopeDigest, config = { profile: PROFILE }, knowledgeRoot, environment = process.env, knowledgeQuery = queryKnowledge }) {
  const selected = selection(config);
  check([auditId, taskId, attemptId].every(id) && sha(scopeDigest), "Agent 挖掘任务绑定无效。");
  const output = await outputDirectory(sourceRoot, outputRoot), snapshot = await inventory(sourceRoot);
  let knowledge = [];
  // Blind returns before any retrieval, with no seed IDs or case bodies in artifacts.
  if (selected.track !== "blind") {
    knowledge = await Promise.all(selected.families.map(async family => {
      let response;
      try { response = await knowledgeQuery({ command: "show", track: selected.track, id: FAMILIES[family].case_id, limit: 1, offset: 0, ...(knowledgeRoot ? { root: knowledgeRoot } : {}) }, { environment }); }
      catch { response = { status: "UNAVAILABLE", reason: "知识查询失败，继续静态分析。" }; }
      const path = `agent-mining-knowledge-${family}.json`;
      await atomicJson(join(output, path), response);
      const usable = ["READY", "PARTIAL"].includes(response.status) && response.read_only === true && response.automatic_vulnerability_verdict === false;
      return { family, status: response.status, path, sha256: hash(await readFile(join(output, path))),
        warnings: response.warnings ?? [], reason: response.reason ?? null,
        reference: usable && response.document ? { id: response.document.id, title: response.document.title, source: response.document.source, quality: response.document.quality, curation: response.document.curation, facets: response.document.facets } : null };
    }));
  }
  const plan = seal({ protocol: PROTOCOL, ...selected, audit_id: auditId, task_id: taskId, attempt_id: attemptId, scope_digest: scopeDigest,
    inventory: snapshot, knowledge, dynamic_execution: "NOT_RUN", validation: "DEFERRED",
    matrix: selected.families.flatMap(family => SURFACES.map(surface => ({ family, surface }))),
    families: Object.fromEntries(selected.families.map(family => {
      const { case_id, ...detail } = FAMILIES[family]; return [family, detail];
    })) });
  const planPath = join(output, "agent-mining-plan.json"), analysisPath = join(output, "agent-mining-analysis.json");
  await atomicJson(planPath, plan);
  await atomicJson(analysisPath, { protocol: PROTOCOL, plan_digest: plan.artifact_digest, agent_session_id: "",
    coverage: plan.matrix.map(row => ({ ...row, status: "GAP", reason: "尚未分析当前任务范围。", evidence: [] })), claims: [], gaps: [] });
  return { protocol: PROTOCOL, plan_path: planPath, plan_sha256: hash(await readFile(planPath)), analysis_path: analysisPath,
    source_file_count: snapshot.files.length, cue_count: snapshot.cues.length, knowledge_status: selected.track === "blind" ? "SKIPPED" : knowledge.every(row => row.status === "READY") ? "READY" : "PARTIAL" };
}

export async function analyzeMining({ plan, analysis, session, sourceRoot }) {
  const { artifact_digest, ...body } = plan;
  check(plan.protocol === PROTOCOL && plan.profile === PROFILE && artifact_digest === digest(body), "Agent 挖掘计划摘要无效。");
  selection({ profile: plan.profile, families: plan.families && Object.keys(plan.families), track: plan.track });
  check(analysis.protocol === PROTOCOL && analysis.plan_digest === artifact_digest, "分析与挖掘计划不匹配。");
  check(session?.protocol === "task-board.v1" && ["audit_id", "task_id", "attempt_id"].every(key => session[key] === plan[key])
    && id(session.agent_session_id) && session.agent_session_id === analysis.agent_session_id, "实际 Agent 会话与任务绑定不匹配。");
  const root = await realpath(sourceRoot ?? plan.inventory.source_root);
  check(root === plan.inventory.source_root, "源码根与计划不一致。");
  const files = new Map(plan.inventory.files.map(file => [file.path, file]));
  // Verify the whole captured snapshot, not just positive evidence.
  for (const file of files.values()) check(hash(await sourceBytes(root, file.path)) === file.sha256, `源码摘要已变化：${file.path}`);
  const evidence = refs => {
    check(Array.isArray(refs) && refs.length > 0 && refs.length <= 100, "必须提供有界源码证据。");
    for (const ref of refs) {
      const file = files.get(ref?.path), end = ref?.end_line ?? ref?.line;
      check(file && ref.sha256 === file.sha256 && Number.isInteger(ref.line) && ref.line > 0 && Number.isInteger(end) && end >= ref.line && end <= file.lines, "源码证据路径、摘要或行号无效。");
    }
  };
  const statement = (value, required = true) => {
    check(value && chinese(value.reason), "证据说明必须是非空中文。");
    if (required || value.evidence?.length) evidence(value.evidence);
  };
  check(Array.isArray(analysis.coverage) && analysis.coverage.length === plan.matrix.length && Array.isArray(analysis.claims) && analysis.claims.length <= 50
    && Array.isArray(analysis.gaps) && analysis.gaps.every(chinese), "覆盖矩阵、候选列表或缺口无效。");
  const seen = new Set(), covered = new Map(), gaps = [...analysis.gaps];
  for (const row of analysis.coverage) {
    const key = `${row.family}/${row.surface}`;
    check(plan.matrix.some(item => item.family === row.family && item.surface === row.surface) && !seen.has(key), "覆盖项重复或超出任务风险范围。");
    check(["INSPECTED", "NOT_APPLICABLE", "GAP"].includes(row.status), "覆盖项状态无效。");
    statement(row, row.status !== "GAP"); seen.add(key); covered.set(key, row);
    if (row.status === "GAP") gaps.push(`${key}：${row.reason}`);
  }
  if (plan.inventory.skipped.length) gaps.push(`入口清单是有界词法定位，排除或未读取项：${JSON.stringify(plan.inventory.skipped)}。`);
  for (const row of plan.knowledge) if (row.status !== "READY") gaps.push(`知识引用 ${row.family}：${row.status}；${row.reason ?? row.warnings.join("；") ?? "证据质量需保留"}。`);
  const findings = [], leads = [], claimIds = new Set();
  for (const claim of analysis.claims) {
    check(id(claim.claim_id) && !claimIds.has(claim.claim_id), "候选标识无效或重复。"); claimIds.add(claim.claim_id);
    const family = FAMILIES[claim.family], cell = covered.get(`${claim.family}/${claim.surface}`);
    check(family && cell && cell.status !== "NOT_APPLICABLE", "候选超出已声明范围或与不适用结论矛盾。");
    for (const key of ["title", "description", "caller", "execution_identity", "operation", "impact", "remediation"]) check(chinese(claim[key]), `候选 ${key} 须以中文描述。`);
    check(["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"].includes(claim.severity), "候选严重性无效。");
    check(["HOST", "SANDBOX", "REMOTE", "UNKNOWN"].includes(claim.execution_context), "执行环境须明确或为 UNKNOWN。");
    statement(claim.expected_policy);
    check(Array.isArray(claim.chain) && claim.chain.length >= 3 && claim.chain.length <= 40 && Array.isArray(claim.edges) && claim.edges.length === claim.chain.length - 1, "候选须提供入口、分派、执行的连续调用链。");
    const nodeIds = new Set();
    for (const node of claim.chain) {
      check(id(node.id) && !nodeIds.has(node.id) && ["entry", "dispatch", "transform", "execution"].includes(node.stage), "调用链节点无效。");
      nodeIds.add(node.id); statement(node);
    }
    check(claim.chain[0].stage === "entry" && claim.chain.at(-1).stage === "execution" && claim.chain.some(node => node.stage === "dispatch"), "调用链须经过真实工具分派点。");
    claim.edges.forEach((edge, index) => {
      check(edge.from === claim.chain[index].id && edge.to === claim.chain[index + 1].id, "调用链存在断边。"); statement(edge);
    });
    let supported = true;
    for (const fact of family.facts) {
      const value = claim.facts?.[fact];
      check(value && ["SUPPORTED", "REFUTED", "UNKNOWN"].includes(value.status), `必要事实缺失：${fact}`);
      statement(value, value.status !== "UNKNOWN"); supported &&= value.status === "SUPPORTED";
    }
    check(Array.isArray(claim.controls) && claim.controls.length > 0 && claim.controls.length <= 30, "必须逐项描述相关控制，未知不能视为缺失。");
    for (const control of claim.controls) {
      check(chinese(control.name) && ["ENFORCED", "BYPASSED", "ABSENT", "UNKNOWN"].includes(control.status), "控制状态无效。");
      statement(control, control.status !== "UNKNOWN"); supported &&= control.status !== "UNKNOWN";
    }
    for (const name of family.counterchecks) {
      const value = claim.counterchecks?.[name];
      check(value && ["DOES_NOT_REFUTE", "REFUTES", "UNKNOWN"].includes(value.status), `必须记录反例核对：${name}`);
      statement(value, value.status !== "UNKNOWN"); supported &&= value.status === "DOES_NOT_REFUTE";
    }
    check(Array.isArray(claim.knowledge_refs), "知识引用须为数组。");
    for (const ref of claim.knowledge_refs) check(plan.track !== "blind" && plan.knowledge.some(row => row.reference?.id === ref.id && row.reference.source?.sha256 === ref.sha256), "知识引用未绑定本次有效查询或违反盲测隔离。");
    if (claim.family === "TOOL_RCE" && claim.execution_context === "UNKNOWN") supported = false;
    if (!supported) {
      leads.push({ ...claim, state: "LEAD", execution_status: "NOT_RUN", verdict: "NOT_ASSESSED" });
      gaps.push(`${claim.claim_id}：必要事实、控制或反例尚未闭合，保留静态线索。`); continue;
    }
    findings.push({ finding_id: `AM-${hash(`${plan.audit_id}:${plan.task_id}:${claim.claim_id}`).slice(0, 20)}`, state: "CANDIDATE", verdict: "NOT_ASSESSED",
      title: claim.title, description: claim.description, severity: claim.severity, vulnerability_type_id: family.catalog_id,
      location: claim.chain.at(-1).evidence[0], impact: claim.impact, remediation: claim.remediation,
      execution_status: "NOT_RUN", routing: { protocol: "task-board.v1", task_id: plan.task_id, attempt_id: plan.attempt_id, domain: "ai" },
      agent_mining: { protocol: PROTOCOL, plan_digest: artifact_digest, ...claim } });
  }
  return { protocol: "task-board.v1", audit_id: plan.audit_id, task_id: plan.task_id, attempt_id: plan.attempt_id, agent_session_id: session.agent_session_id,
    summary: `完成当前任务的 Agent 静态边界分析：候选 ${findings.length} 项，待补线索 ${leads.length} 项；未执行目标或动态验证，未作最终漏洞裁决。`,
    findings, gaps, memory_observations: analysis.memory_observations ?? [], coverage_observations: analysis.coverage_observations ?? [], memory_todos: analysis.memory_todos ?? [], evidence_refs: analysis.coverage.flatMap(row => row.evidence ?? []),
    agent_mining: { protocol: PROTOCOL, profile: PROFILE, plan_digest: artifact_digest, scope_digest: plan.scope_digest, track: plan.track,
      status: gaps.length ? "PARTIAL" : "ANALYZED", coverage: analysis.coverage, leads, knowledge: plan.knowledge, execution_status: "NOT_RUN", validation: "DEFERRED" } };
}

export async function finishMining({ planPath, analysisPath, sessionPath, sourceRoot }) {
  const plan = await jsonFile(planPath), output = await outputDirectory(plan.inventory.source_root, dirname(planPath));
  for (const reference of plan.knowledge) {
    check(/^agent-mining-knowledge-[A-Z_]+\.json$/.test(reference.path), "知识快照路径无效。");
    const path = join(output, reference.path); await jsonFile(path);
    check(hash(await readFile(path)) === reference.sha256, "知识查询快照发生变化。");
  }
  const report = await analyzeMining({ plan, analysis: await jsonFile(analysisPath), session: await jsonFile(sessionPath), sourceRoot });
  const reportPath = join(output, "report.json"), receiptPath = join(output, "receipt.json");
  await atomicJson(reportPath, report);
  await atomicJson(receiptPath, { protocol: "task-board.v1", audit_id: plan.audit_id, task_id: plan.task_id, attempt_id: plan.attempt_id, outcome: "REPORTED", report_path: "report.json" });
  return { report_path: reportPath, receipt_path: receiptPath, findings: report.findings.length, leads: report.agent_mining.leads.length, status: report.agent_mining.status };
}
