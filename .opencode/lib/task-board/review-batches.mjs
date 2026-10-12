import { join } from "node:path";
import { atomicJson, check, controlledBytes, digest, hash, PROTOCOL } from "./contract.mjs";

export const REVIEW_BATCH_PROTOCOL = "task-board-review-batches.v1";
export const REVIEW_ROLES = ["AFFIRMATIVE", "NEGATIVE", "MODERATOR"];
const agents = { AFFIRMATIVE: "vulnerability-affirmative", NEGATIVE: "vulnerability-negative", MODERATOR: "vulnerability-moderator" };
const verdicts = { AFFIRMATIVE: ["PROVEN", "NOT_PROVEN", "INCONCLUSIVE"], NEGATIVE: ["REFUTED", "NOT_REFUTED", "INCONCLUSIVE"], MODERATOR: ["TRUE_POSITIVE", "FALSE_POSITIVE", "INCONCLUSIVE"] };
const nonempty = value => typeof value === "string" && value.trim();
// A conservative, provider-independent packing estimate, not billing usage.
export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let ascii = 0, other = 0;
  for (const char of text) char.codePointAt(0) < 128 ? ascii++ : other++;
  return Math.ceil(ascii / 3 + other);
}
export async function readBound(root, ref) {
  check(ref && typeof ref.path === "string" && /^[a-f0-9]{64}$/.test(ref.sha256 ?? ""), "分批复核制品绑定无效。");
  const bytes = await controlledBytes(root, ref.path);
  check(hash(bytes) === ref.sha256, "分批复核制品摘要不匹配。");
  return JSON.parse(bytes.toString("utf8"));
}
async function save(root, path, value) {
  await atomicJson(join(root, path), value);
  return { path, sha256: hash(`${JSON.stringify(value, null, 2)}\n`) };
}
// Locality only: never delete candidates or infer equivalent exploit conditions.
function evidenceGroup(candidate) {
  const finding = candidate.finding ?? {}, locations = finding.locations;
  const primary = Array.isArray(locations) ? locations[0] : locations?.primary;
  return `${candidate.claim_scope}:${primary?.file ?? primary?.path ?? finding.location?.file ?? candidate.task_id ?? candidate.candidate_id}`;
}
function exactIds(rows, ids, field) {
  check(Array.isArray(rows) && rows.length === ids.length && new Set(rows.map(row => row?.[field])).size === ids.length
    && rows.every(row => ids.includes(row?.[field])), "分批复核必须逐项覆盖本批标识，不能遗漏、重复或新增。");
}

export async function prepareReviewBatches(store) {
  const board = store.snapshot(), ref = board.validation.input;
  check(ref, "请先生成复核输入。");
  if (board.validation.batch_plan) {
    const plan = await readBound(store.reportsRoot, board.validation.batch_plan);
    check(plan.input.sha256 === ref.sha256, "分批复核计划已失效。");
    return { ...board.validation.batch_plan, batch_count: plan.batches.length };
  }
  check(!board.final_report && board.validation.status !== "REVIEWED", "已完成的复核保持原有协议。");
  const input = await readBound(store.reportsRoot, ref), root = store.reportsRoot;
  const prefix = `validation/batches/${board.audit_id}/${ref.sha256}`;
  const ordered = [...input.candidates].sort((a, b) => evidenceGroup(a).localeCompare(evidenceGroup(b)) || a.candidate_id.localeCompare(b.candidate_id));
  const batches = []; let rows = [];
  const packet = candidates => {
    const ids = new Set(candidates.map(row => row.task_id));
    const externalTasks = new Set(candidates.filter(row => row.evidence_external).map(row => row.task_id));
    return { protocol: REVIEW_BATCH_PROTOCOL, audit_id: input.audit_id, scope_digest: input.scope_digest, input_sha256: ref.sha256,
      candidates, tasks: input.tasks.filter(task => ids.has(task.task_id)).map(task => externalTasks.has(task.task_id) ? { task_id: task.task_id, title: task.title, report: task.report } : task),
      bac_mode: input.bac_mode, bac_units: input.bac_summary?.units?.filter(unit => ids.has(unit.task_id) && !externalTasks.has(unit.task_id)) ?? [],
      runtime: input.runtime ? { path: input.runtime.path, sha256: input.runtime.sha256 } : null };
  };
  // Oversized evidence is still available by immutable reference, not truncated.
  const externalize = async candidate => {
    const value = packet([candidate]);
    if (estimateTokens(value) <= 16_000) return candidate;
    const finding = candidate.finding ?? {};
    return { candidate_id: candidate.candidate_id, task_id: candidate.task_id, claim_scope: candidate.claim_scope,
      evidence: await save(root, `${prefix}/candidate-${hash(candidate.candidate_id).slice(0, 24)}.json`, value),
      finding: { title: String(finding.title ?? "候选漏洞").slice(0, 300) },
      evidence_external: true };
  };
  const flush = async () => {
    if (!rows.length) return;
    const batchId = `batch-${String(batches.length + 1).padStart(4, "0")}`;
    const data = packet(rows);
    data.batch_id = batchId;
    batches.push({ batch_id: batchId, candidate_ids: rows.map(row => row.candidate_id),
      estimated_tokens: estimateTokens(data), input: await save(root, `${prefix}/${batchId}.json`, data) });
    rows = [];
  };
  for (const original of ordered) {
    const candidate = await externalize(original);
    if (rows.length && (rows.length >= 6 || estimateTokens(packet([...rows, candidate])) > 16_000)) await flush();
    rows.push(candidate);
  }
  await flush();
  const plan = { protocol: REVIEW_BATCH_PROTOCOL, audit_id: board.audit_id, input: ref, max_candidates: 6, target_input_tokens: 16_000, batches };
  const planRef = await save(root, `${prefix}/plan.json`, plan);
  await store.mutate(next => {
    check(next.validation.input?.sha256 === ref.sha256 && !next.final_report, "复核输入已变化，请重新获取批次。");
    next.validation.batch_plan = planRef;
    next.validation.status = "IN_PROGRESS";
    next.validation.batch_count = batches.length;
    next.validation.batch_results ??= [];
  });
  return { ...planRef, batch_count: batches.length };
}

export async function nextReviewBatch(store) {
  const board = store.snapshot(), plan = await readBound(store.reportsRoot, board.validation.batch_plan);
  check(plan.input.sha256 === board.validation.input?.sha256, "分批复核计划已失效。");
  const completed = board.validation.batch_results ?? [];
  for (const batch of plan.batches) {
    const result = completed.find(row => row.batch_id === batch.batch_id) ?? {};
    for (const role of REVIEW_ROLES) {
      if (result[role.toLowerCase()]) continue;
      const previous = { ...(role !== "AFFIRMATIVE" ? { affirmative: result.affirmative } : {}), ...(role === "MODERATOR" ? { negative: result.negative } : {}) };
      return { done: false, batch_id: batch.batch_id, role, agent: agents[role], new_session_required: true,
        input: batch.input, input_sha256: plan.input.sha256, candidate_count: batch.candidate_ids.length, ...previous,
        instruction: "为本批创建全新会话，不传 task_id 恢复旧会话。只读取本批输入与按需引用的证据；逐候选输出判断。反方先独立查反证，再读取本批正方。输出绑定 input_sha256、batch_input_sha256、batch_id、role 和真实 agent_session_id。" };
    }
  }
  return { done: true, batch_count: plan.batches.length, candidate_count: plan.batches.reduce((n, batch) => n + batch.candidate_ids.length, 0) };
}

async function checkBatchResult(root, inputRef, batch, role, ref, previous, sessions) {
  const doc = await readBound(root, ref);
  check(doc.protocol === PROTOCOL && doc.audit_id === (await readBound(root, batch.input)).audit_id
    && doc.input_sha256 === inputRef.sha256 && doc.batch_id === batch.batch_id && doc.batch_input_sha256 === batch.input.sha256 && doc.role === role,
  "分批复核角色、批次或输入摘要不匹配。");
  check(nonempty(doc.agent_session_id) && !sessions.has(doc.agent_session_id), "每个复核批次与角色必须使用全新独立会话，不能复用其他批次的 session。");
  exactIds(doc.findings, batch.candidate_ids, "candidate_id");
  for (const row of doc.findings) check(verdicts[role]?.includes(row.verdict) && nonempty(row.reason) && Array.isArray(row.evidence_refs) && Array.isArray(row.gaps)
    && (row.verdict === "INCONCLUSIVE" || row.evidence_refs.length > 0), "分批漏洞复核结论或证据字段不完整。");
  if (role !== "AFFIRMATIVE") check(previous.affirmative && doc.affirmative_sha256 === previous.affirmative.sha256, "本批复核未绑定正方证据。");
  if (role === "MODERATOR") check(previous.negative && doc.negative_sha256 === previous.negative.sha256, "本批裁决未绑定反方证据。");
  sessions.add(doc.agent_session_id);
  return doc;
}

export async function submitReviewBatch(store, { batch_id: batchId, role, result }) {
  check(REVIEW_ROLES.includes(role), "复核角色无效。");
  return store.mutate(async board => {
    check(!board.final_report && board.validation.status !== "REVIEWED", "已封存的复核结果不能覆盖。");
    const plan = await readBound(store.reportsRoot, board.validation.batch_plan);
    check(plan.input.sha256 === board.validation.input?.sha256, "分批复核计划已失效。");
    const batch = plan.batches.find(row => row.batch_id === batchId);
    check(batch, "复核批次不存在。");
    const results = board.validation.batch_results ??= [], key = role.toLowerCase();
    let previous = results.find(row => row.batch_id === batchId);
    if (previous?.[key]) { check(digest(previous[key]) === digest(result), "已提交的批次结果不同，不能覆盖。"); return { received: true, duplicate: true }; }
    const sessions = new Set(results.flatMap(row => Object.values(row.sessions ?? {})));
    const doc = await checkBatchResult(store.reportsRoot, plan.input, batch, role, result, previous ?? {}, sessions);
    if (!previous) { previous = { batch_id: batchId, sessions: {} }; results.push(previous); }
    previous[key] = result; previous.sessions[role] = doc.agent_session_id;
    return { received: true, batch_id: batchId, role };
  });
}

export async function validateBatchBundle(board, root, input, bundle, sessions) {
  const plan = await readBound(root, board.validation.batch_plan);
  check(plan.protocol === REVIEW_BATCH_PROTOCOL && plan.audit_id === board.audit_id && plan.input.sha256 === board.validation.input.sha256, "分批复核计划与输入不一致。");
  exactIds(plan.batches.flatMap(batch => batch.candidate_ids.map(candidate_id => ({ candidate_id }))), input.candidates.map(row => row.candidate_id), "candidate_id");
  exactIds(bundle.batches, plan.batches.map(batch => batch.batch_id), "batch_id");
  const roles = Object.fromEntries(REVIEW_ROLES.map(role => [role.toLowerCase(), { role, agent_session_ids: [], findings: [] }]));
  for (const batch of plan.batches) {
    const row = bundle.batches.find(row => row.batch_id === batch.batch_id);
    for (const role of REVIEW_ROLES) {
      const doc = await checkBatchResult(root, plan.input, batch, role, row[role.toLowerCase()], row, sessions);
      roles[role.toLowerCase()].agent_session_ids.push(doc.agent_session_id);
      roles[role.toLowerCase()].findings.push(...doc.findings);
    }
  }
  return roles;
}

export function assembleBatchBundle(board, bundle) {
  if (!board.validation.batch_plan || bundle.batches) return bundle;
  return { ...bundle, batches: (board.validation.batch_results ?? []).map(({ sessions, ...row }) => row) };
}
