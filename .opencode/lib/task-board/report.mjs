import { renderBacSummary } from "../bac/summary.mjs";
// Presentation only: keep conclusions and every residual gap from the sealed model.
const text = value => typeof value === "string" ? value : JSON.stringify(value);
const title = value => String(value ?? "").replace(/\s+/g, " ").replace(/([\\`*_[\]<>])/g, "\\$1");
const code = value => {
  const body = text(value) ?? "";
  const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return `${fence}\n${body}\n${fence}`;
};
const fieldLabels = {
  gap_id: "缺口标识", id: "标识", title: "标题", type: "类型", kind: "类别", severity: "严重性",
  description: "缺口说明", detail: "详细说明", area: "范围", attempted: "已尝试的工作",
  consequence: "影响", impact: "影响", impact_if_closed: "补齐后的影响", where: "相关位置",
  evidence: "依据", next_step: "后续工作", related: "关联项",
};

function appendGap(lines, value) {
  let structured;
  try { structured = JSON.parse(value); } catch { /* Plain narrative remains verbatim. */ }
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    for (const [key, content] of Object.entries(structured)) {
      const label = fieldLabels[key] ? `${fieldLabels[key]}（${key}）` : key;
      lines.push(`**${title(label)}**`, "", typeof content === "object" && content !== null ? code(JSON.stringify(content, null, 2)) : text(content), "");
    }
  } else lines.push(value, "");
}

function groupedGaps(model) {
  const groups = new Map(), prefixes = [];
  const register = (prefix, group, source, ref = "") => prefixes.push({ prefix: `${prefix}：`, group, source, ref });
  for (const task of model.tasks) {
    const group = `任务：${task.title}`;
    groups.set(group, new Map());
    register(task.title, group, "任务报告自报缺口");
    register(task.task_id, group, "任务报告质量复核", task.task_id);
  }
  for (const row of [...model.findings, ...model.excluded_findings, ...model.runtime_findings]) {
    const task = model.tasks.find(task => task.task_id === row.task_id);
    const group = task ? `任务：${task.title}` : "未关联任务的候选";
    register(row.finding_id, group, "尚未确定的候选", row.finding_id);
    for (const [role, label] of [["AFFIRMATIVE", "正方复核"], ["NEGATIVE", "反方复核"], ["MODERATOR", "裁决复核"]]) {
      register(`${role}/${row.finding_id}`, group, label, `${role}/${row.finding_id}`);
    }
  }
  for (const packet of model.runtime?.packets ?? []) register(`运行工作包 ${packet.id}`, "运行测试与清理缺口", `工作包：${packet.id}`);
  register("越权专项", "越权专项缺口", "专项复核");
  // Match only exact model identifiers, never infer a source from the prose.
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
  for (const gap of model.residual_gaps) {
    const value = text(gap), match = prefixes.find(item => value.startsWith(item.prefix));
    const group = match?.group ?? "其他审计与清理缺口", source = match?.source ?? "原始记录";
    if (!groups.has(group)) groups.set(group, new Map());
    const sources = groups.get(group);
    if (!sources.has(source)) sources.set(source, []);
    sources.get(source).push({ ref: match?.ref, body: match ? value.slice(match.prefix.length) : value });
  }
  return [...groups].filter(([, sources]) => sources.size);
}

export function renderStructuredBoardReport(model) {
  const noReports = model.report_version >= 2 && model.delivery_outcome === "NO_REPORTS";
  const summary = model.summary, lines = [noReports ? "# 审计执行失败记录" : "# 安全审计报告", ""];
  const section = (level, name) => lines.push(`${"#".repeat(level)} ${title(name)}`, "");
  const field = (label, value) => lines.push(`**${label}：** ${text(value) ?? ""}`, "");
  section(2, "1. 审计概览");
  section(3, "1.1 审计标识与范围");
  field("审计标识", model.audit_id);
  field("源码范围摘要", model.scope_digest);
  section(3, "1.2 漏洞挖掘策略");
  lines.push(summary.mining_strategy === "api"
    ? "本次采用逐接口 API 审查策略，逐项分析用户提供清单中的接口。交付比例不代表已发现所有漏洞，也不证明接口清单覆盖全部应用入口。"
    : summary.mining_strategy === "focus_area"
      ? "本次采用高风险 Focus Area 策略，对威胁建模识别的高风险主题定向深入分析。交付比例不代表已发现所有漏洞或已逐一审查全部接口。"
      : "Focus Area 为高风险定向审查；API 为用户提供清单中的逐接口审查。交付比例不代表已发现所有漏洞，也不证明接口清单覆盖全部应用入口。", "");
  section(3, "1.3 任务交付与结论范围");
  if (noReports) lines.push("**审计执行未完成：本轮未收到任何源码审计报告，全部任务均登记为执行缺口。以下内容仅记录失败原因与缺口，无法据此判断目标是否存在漏洞。修复执行问题后须重新创建审计。**", "");
  else if (model.report_version >= 2 && model.delivery_outcome === "PARTIAL") lines.push("**本轮仅收到部分任务的审计报告。漏洞结论仅限已交付且完成复核的证据，未交付任务仍须补充审计。**", "");
  else if (model.report_version >= 2 && model.delivery_outcome === "NO_TASKS") lines.push("**本轮未发布审计任务，无法据此判断目标是否存在漏洞。**", "");
  lines.push(`任务 ${summary.total} 项，收到报告 ${summary.reported} 项，执行缺口 ${summary.gap} 项。`, "");
  if (summary.mining_strategy !== "api") lines.push(`- Focus Area：${summary.tracks.focus_area.reported}/${summary.tracks.focus_area.total}。`);
  if (summary.mining_strategy !== "focus_area") lines.push(`- API 任务：${summary.tracks.api.reported}/${summary.tracks.api.total}。`, `- 用户提交 API ${summary.api_inventory.submitted} 项，相关任务全部交付 ${summary.api_inventory.reported} 项。`);
  lines.push("", `确认源码漏洞 ${model.findings.length} 条；排除及未确定候选 ${model.excluded_findings.length} 条；剩余缺口记录 ${model.residual_gaps.length} 条。`, "");

  if (model.report_corrections?.length) {
    section(3, "1.4 报告更正记录");
    for (const row of model.report_corrections) {
      field("更正任务", row.task_id); field("更正原因", row.reason); field("更正时间", row.corrected_at);
      field("原始报告", row.previous.path); field("原始摘要", row.previous.sha256);
      field("更正报告", row.replacement.path); field("更正摘要", row.replacement.sha256);
    }
    lines.push("原始交付已保留；本报告的质量复核与候选验证绑定更正后的输入。", "");
  }
  section(2, "2. 已确认源码漏洞");
  model.findings.forEach((row, index) => {
    section(3, `2.${index + 1} ${row.title ?? row.finding_id}`);
    field("漏洞标识", row.finding_id);
    field("来源任务", model.tasks.find(task => task.task_id === row.task_id)?.title ?? row.task_id);
    section(4, "漏洞说明");
    lines.push(row.description ?? row.summary ?? "", "");
    section(4, "严重性与代码位置");
    field("严重性", typeof row.severity === "string" ? row.severity : row.severity?.rating ?? "未评级");
    field("代码位置", row.location ? JSON.stringify(row.location) : "见绑定审计报告");
    section(4, "复核依据");
    lines.push(row.review.reason, "");
    section(4, "证据清单");
    lines.push(...row.review.evidence_refs.map(ref => `- ${text(ref).replaceAll("\n", "\n  ")}`), "");
    section(4, "修复建议");
    lines.push(typeof row.remediation === "string" ? row.remediation : row.remediation?.summary ?? "见绑定审计报告", "");
  });
  if (!model.findings.length) lines.push(noReports ? "没有可供源码漏洞复核的审计报告；本轮无法形成源码安全结论。" : "本次未形成经三方复核确认的源码漏洞。", "");

  section(2, "3. 任务复核明细");
  model.tasks.forEach((task, index) => {
    const review = model.assessments.find(row => row.task_id === task.task_id);
    section(3, `3.${index + 1} ${task.title}`);
    field("任务标识", task.task_id);
    field("审计粒度 / 领域", `${task.kind === "api" ? "API" : "Focus Area"} / ${task.domain}`);
    section(4, "复核结论与依据");
    field("复核状态", review?.status === "REVIEWED" ? "已复核" : "存在缺口或待补充");
    lines.push(review?.reason ?? task.reason ?? "", "");
    if (task.report) { section(4, "原始报告"); lines.push(code(task.report.path), ""); }
  });

  section(2, "4. 剩余缺口");
  lines.push(`共 ${model.residual_gaps.length} 条记录，按来源任务及复核环节分组。不同环节对同一事项的记录分别保留。`, "");
  groupedGaps(model).forEach(([group, sources], index) => {
    section(3, `4.${index + 1} ${group}`);
    let number = 0;
    for (const [source, gaps] of sources) {
      section(4, source);
      for (const gap of gaps) {
        field(`缺口 ${++number}`, gap.ref ?? source);
        appendGap(lines, gap.body);
      }
    }
  });
  if (!model.residual_gaps.length) lines.push("已发布任务的复核未记录剩余缺口。", "");

  section(2, "5. 运行测试与清理");
  section(3, "5.1 总体状态");
  field("状态", model.runtime?.status ?? "SKIPPED");
  field("原因", model.runtime?.reason ?? "未启用动态验证");
  field("清理状态", model.runtime?.cleanup_status ?? "NOT_REQUIRED");
  const packets = model.runtime?.packets ?? [];
  packets.forEach((packet, index) => {
    section(3, `5.${index + 2} 工作包：${packet.id}`);
    section(4, "执行摘要");
    lines.push(packet.result?.summary ?? packet.reason ?? packet.execution_status, "");
    section(4, "清理与变更记录");
    field("清理状态", packet.cleanup_status);
    lines.push(code(JSON.stringify(packet.result?.changes ?? [], null, 2)), "");
  });
  if (model.runtime_findings.length) {
    section(3, `5.${packets.length + 2} 仅运行环境结论`);
    for (const row of model.runtime_findings) {
      section(4, row.finding_id);
      field("复核结论", row.review.verdict);
      lines.push(row.review.reason, "", "源码映射未知。", "");
    }
  }
  let lastSection = 6;
  if (model.bac_analysis) {
    section(2, "6. 越权专项");
    section(3, "6.1 专项结论与依据");
    lines.push(model.bac_analysis.reason, "");
    if (model.bac_analysis.summary) lines.push(...renderBacSummary(model.bac_analysis.summary).slice(2));
    lastSection++;
  }
  section(2, `${lastSection}. 排除及未确定候选`);
  model.excluded_findings.forEach((row, index) => {
    section(3, `${lastSection}.${index + 1} ${row.title ?? row.finding_id}`);
    field("候选标识", row.finding_id);
    field("复核结论", row.review.verdict);
    section(4, "复核依据");
    lines.push(row.review.reason, "");
  });
  if (!model.excluded_findings.length) lines.push("本次没有排除或未确定的候选。", "");
  return `${lines.join("\n").trimEnd()}\n`;
}
