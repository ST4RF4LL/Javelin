import { BAC_CONTRACT, nonempty, objectDigest } from "./contract.mjs";
const unitLabel = row => `${row.task_id ?? row.focus_area_id} / ${row.attempt_id ?? row.assignment_id}`;

export function buildBacSummary(rows) {
  const number = key => rows.reduce((sum, row) => sum + (row[key] ?? 0), 0);
  const policies = new Map();
  for (const row of rows) for (const tuple of row.policy_bindings ?? []) {
    const key = JSON.stringify([tuple.D, tuple.O, tuple.R]);
    if (!policies.has(key)) policies.set(key, new Set());
    policies.get(key).add(tuple.AC);
  }
  const conflicts = [...policies].filter(([, values]) => values.size > 1).map(([key]) => `ACP_CONFLICT：相同资源/操作/角色存在冲突策略 ${key}，不能按写入顺序覆盖。`).sort();
  return { contract_version: BAC_CONTRACT, status: conflicts.length || rows.some(row => ["PARTIAL", "GAP"].includes(row.status)) ? "PARTIAL" : rows.length ? "COMPLETE" : "NOT_APPLICABLE",
    units: rows, counts: { units: rows.length, candidates: number("candidates"), accepted: number("accepted"), paths: number("paths"), policies: number("policies") },
    gaps: [...rows.flatMap(row => row.gaps.map(reason => `${unitLabel(row)}：${reason}`)), ...conflicts],
    claim_boundary: "统计为工作包内路径与策略计数，跨工作包可能重复；候选尚须独立三方复核，不能由专项完成状态推断无漏洞。" };
}

export function validateBacSummary(value) {
  if (!value || value.contract_version !== BAC_CONTRACT || !Array.isArray(value.units)
    || value.units.some(row => !row || !(nonempty(row.task_id) && nonempty(row.attempt_id) || nonempty(row.focus_area_id) && nonempty(row.assignment_id)) || !["GAP", "PARTIAL", "COMPLETE", "NOT_APPLICABLE"].includes(row.status)
      || !Array.isArray(row.gaps) || row.gaps.some(gap => !nonempty(gap))
      || ["candidates", "accepted", "paths", "policies"].some(key => row[key] != null && (!Number.isInteger(row[key]) || row[key] < 0))
      || (row.accepted ?? 0) > (row.candidates ?? 0)
      || (row.policy_bindings != null && (!Array.isArray(row.policy_bindings) || row.policy_bindings.some(tuple => !tuple
        || Object.keys(tuple).sort().join() !== "AC,D,O,R" || !nonempty(tuple.D) || !nonempty(tuple.R)
        || !["CREATE", "READ", "UPDATE", "DELETE"].includes(tuple.O) || !["NONE", "VAC", "HAC", "VAC+HAC"].includes(tuple.AC))))
      || (["COMPLETE", "NOT_APPLICABLE"].includes(row.status) && row.gaps.length > 0)
      || (["GAP", "PARTIAL"].includes(row.status) && row.gaps.length === 0))
    || new Set(value.units.map(row => `${row.task_id ? "task" : "focus"}\0${unitLabel(row)}`)).size !== value.units.length) return ["bac-summary-invalid"];
  return objectDigest(buildBacSummary(value.units)) === objectDigest(value) ? [] : ["bac-summary-accounting-mismatch"];
}

export function renderBacSummary(value) {
  if (!value) return [];
  const safe = value => String(value ?? "").replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
  return ["## 越权专项分析", "", `状态：${value.status}；工作包：${value.counts.units}；路径：${value.counts.paths}；策略：${value.counts.policies}；原始候选：${value.counts.candidates}；接入复核：${value.counts.accepted}。`, "",
    value.claim_boundary, "", value.units.some(row => row.task_id) ? "| 任务 / Focus Area | 执行 / 分派 | 状态 | 路径 | 候选 | 接入 |" : "| Focus Area | 分派 | 状态 | 路径 | 候选 | 接入 |", "|---|---|---|---:|---:|---:|",
    ...value.units.map(row => `| ${safe(row.task_id ?? row.focus_area_id)} | ${safe(row.attempt_id ?? row.assignment_id)} | ${row.status} | ${row.paths ?? 0} | ${row.candidates ?? 0} | ${row.accepted ?? 0} |`), "",
    ...value.units.flatMap(row => [row.reason ? `- ${safe(row.task_id ?? row.focus_area_id)}：${safe(row.reason)}` : "", row.run ? `- 差分制品：\`${safe(row.run.path)}\`；SHA-256：\`${row.run.sha256}\`。` : "", row.review ? `- 复查制品：\`${safe(row.review.path)}\`；SHA-256：\`${row.review.sha256}\`。` : ""].filter(Boolean)),
    ...value.gaps.map(gap => `- 缺口：${safe(gap)}`), ""];
}
