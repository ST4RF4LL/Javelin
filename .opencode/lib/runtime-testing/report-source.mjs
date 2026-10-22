import { controlledBytes, hash } from '../task-board/contract.mjs';
import { renderBoardReport } from '../task-board/review.mjs';
import { renderFinalReport, validateFinalReportModel } from '../../skills/common-subagent/audit-coverage-accounting/scripts/final-report-model-core.mjs';
import { check, seal, digest, ID, SHA } from './contract.mjs';

export const REPORT_VALIDATION_PROTOCOL = 'report-validation.v1';
const MAX_BYTES = 8 * 1024 * 1024;

// Only the server resolves report IDs to controlled artifacts. Report prose is
// untrusted evidence and cannot supply execution authority or target origins.
export async function readReportSource({ root, report }) {
  check(ID.test(report.audit_id ?? '') && report.path === `final/security-audit-report.${report.audit_id}.md`, 'report-validation-source-invalid', '请选择已封存的最终漏洞报告。');
  const bytes = await controlledBytes(root, report.path, MAX_BYTES);
  let model, modelBytes, modelPath;
  for (const name of ['task-board-report-model', 'security-audit-report-model']) {
    modelPath = `final/${name}.${report.audit_id}.json`;
    try { modelBytes = await controlledBytes(root, modelPath, MAX_BYTES); model = JSON.parse(modelBytes.toString('utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  check(model?.audit_id === report.audit_id, 'report-validation-model-required', '报告缺少可校验的结构化模型，无法建立逐项验证清单。');
  if (model.protocol === 'task-board.v1') {
    check(model.artifact_type === 'task-board-final-report' && [1, 2, 3].includes(model.report_version ?? 1)
      && renderBoardReport(model) === bytes.toString('utf8'), 'report-validation-model-mismatch', '最终报告与模型不一致，请重新封存报告。');
  } else {
    check(validateFinalReportModel(model).length === 0 && model.report_kind !== 'CHECKPOINT'
      && renderFinalReport(model) === bytes.toString('utf8'), 'report-validation-model-mismatch', '最终报告与模型不一致或尚未完成封存。');
  }
  const findings = [...(model.findings ?? []), ...(model.excluded_findings ?? []).filter(row => (row.review?.verdict ?? row.state) === 'INCONCLUSIVE'),
    ...(model.runtime_findings ?? model.runtime_testing?.runtime_only_findings ?? []).filter(row => (row.review?.verdict ?? row.verdict) !== 'FALSE_POSITIVE')];
  check(findings.length > 0, 'report-validation-no-findings', '该报告没有可动态验证的漏洞或未确定候选。');
  check(findings.length <= 500 && findings.every(row => row && typeof row.finding_id === 'string')
    && new Set(findings.map(row => row.finding_id)).size === findings.length, 'report-validation-findings-invalid', '报告候选清单无效或超过 500 项限制。');
  check(findings.every(row => JSON.stringify(row).length <= 64000) && JSON.stringify(findings).length <= 2 * 1024 * 1024,
    'report-validation-input-too-large', '报告候选上下文过大：每项最多 6.4 万字符，清单总计最多 2M 字符。');
  return seal({ protocol: REPORT_VALIDATION_PROTOCOL, source: { report_id: report.id, audit_id: report.audit_id,
    repository_id: report.repository_id, report_path: report.path, report_sha256: hash(bytes), model_path: modelPath, model_sha256: hash(modelBytes),
    scope_digest: model.scope_digest, finding_count: findings.length }, findings });
}

export function verifyReportSource(value) {
  check(value?.protocol === REPORT_VALIDATION_PROTOCOL && value.artifact_digest === digest(value)
    && SHA.test(value.source?.report_sha256 ?? '') && SHA.test(value.source?.model_sha256 ?? '')
    && Array.isArray(value.findings) && value.findings.length === value.source.finding_count && value.findings.length > 0,
  'report-validation-snapshot-invalid', '报告验证输入快照校验失败。');
  return value;
}

export function reportSourceRequest(source) {
  return { report_id: source.report_id, report_sha256: source.report_sha256, model_sha256: source.model_sha256 };
}
