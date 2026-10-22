import { BadRequestException } from '@nestjs/common';

export function identifier(value: unknown, label = '标识'): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,179}$/.test(value)) throw new BadRequestException(`${label}无效。`);
  return value;
}
export function textField(value: unknown, label: string, max: number, required = false): string {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new BadRequestException(`${label}为空或超过长度限制。`);
  return value;
}
function choice(value: unknown, values: string[], fallback: string): string {
  if (value == null) return fallback;
  if (typeof value !== 'string' || !values.includes(value)) throw new BadRequestException('任务选项无效。');
  return value;
}
export function idempotencyKey(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{8,200}$/.test(value)) throw new BadRequestException('缺少有效的请求幂等键，请重新打开创建表单。');
  return value;
}
export function createTaskInput(input: Record<string, unknown>) {
  const productId = identifier(input.productId, '产品');
  const auditMode = input.auditMode == null ? null : choice(input.auditMode, ['static', 'dynamic', 'joint'], 'static');
  let sourceReport: { report_id: string; report_sha256: string; model_sha256: string; finding_ids?: string[] } | undefined;
  if (input.sourceReport != null) {
    const source = input.sourceReport as Record<string, unknown>;
    if (auditMode !== 'dynamic' || typeof source !== 'object' || !/^[a-f0-9]{64}$/.test(String(source.report_sha256)) || !/^[a-f0-9]{64}$/.test(String(source.model_sha256))) throw new BadRequestException('报告验证来源或摘要无效。');
    sourceReport = { report_id: identifier(source.report_id, '报告编号'), report_sha256: String(source.report_sha256), model_sha256: String(source.model_sha256) };
    if (source.finding_ids !== undefined) {
      const ids = source.finding_ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 240) || new Set(ids).size !== ids.length) throw new BadRequestException('漏洞选择无效；空选择不能执行整份报告。');
      sourceReport.finding_ids = [...ids];
    }
  }
  const targetId = auditMode === 'dynamic' ? null : identifier(input.targetId, '源码对象');
  const auditId = identifier(input.auditId, '任务编号');
  if (auditId.length < 3 || auditId.length > 128) throw new BadRequestException('任务编号需为 3–128 个字符。');
  const mining = auditMode === 'dynamic' ? 'focus_area' : choice(input.miningStrategy, ['focus_area', 'api', 'file_sweep'], 'focus_area');
  const apiInventory = mining === 'api' ? textField(input.apiInventory, 'API 清单', 120000, true) : '';
  const additionalEnabled = input.additionalInstructionsEnabled === true;
  const additional = additionalEnabled ? textField(input.additionalInstructions, '补充说明', 12000, true) : '';
  const environment = auditMode !== 'static' && input.testEnvironmentEnabled === true ? textField(input.testEnvironmentContext, '测试环境', 24000) : '';
  const environmentEnabled = input.testEnvironmentEnabled === true && !!environment.trim();
  if (auditMode === 'dynamic' && !environmentEnabled) throw new BadRequestException('独立动态测试需要显式授权并填写环境说明。');
  let runtime: Record<string, unknown> | null = null;
  if (environmentEnabled) {
    const selected = input.runtimeTesting as Record<string, unknown> | undefined;
    const budget = selected?.budgetMinutes ?? 60;
    if (!Number.isInteger(budget) || Number(budget) < 10 || Number(budget) > 240) throw new BadRequestException('动态预算必须为 10–240 分钟。');
    runtime = { protocol: auditMode === 'joint' || auditMode === 'dynamic' ? 'runtime-testing.v2' : 'runtime-testing.v1', explicit_authorization: true,
      mode: sourceReport ? 'TARGETED_CONFIRMATION' : choice(selected?.mode, ['CONTACT_ONLY', 'INTEGRATED_TESTING', 'TARGETED_CONFIRMATION'], 'CONTACT_ONLY'),
      identity_mode: choice(selected?.identityMode, ['auto', 'anonymous', 'shared', 'distinct'], 'auto'), budget_minutes: budget,
      allowed_actions: ['navigate', 'normal_interaction', ...(selected?.testInput === true ? ['test_input'] : []), ...(selected?.testMutation === true ? ['test_mutation'] : [])] };
  }
  return { productId, body: { ...(auditMode ? { audit_mode: auditMode } : {}), ...(sourceReport ? { source_report: sourceReport } : {}), name: textField(input.name, '任务名称', 160, true).trim(), target_id: targetId, audit_id: auditId,
    ...(input.engine == null ? {} : { engine: choice(input.engine, ['opencode', 'opencode-v2', 'grow'], 'opencode') }),
    model: textField(input.model ?? 'default', '模型', 240), task_protocol: 'task-board.v1', mining_strategy: mining, api_inventory: apiInventory,
    memory_mode: choice(input.memoryMode, ['full', 'facts_only', 'off', 'blind'], 'full'), bac_analysis: choice(input.bacAnalysis, ['auto', 'off'], 'auto'),
    additional_instructions_enabled: additionalEnabled, additional_instructions: additional,
    test_environment_enabled: environmentEnabled, test_environment_context: environmentEnabled ? environment : '', runtime_testing: runtime } };
}
