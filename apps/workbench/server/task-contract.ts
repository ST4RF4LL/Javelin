import { BadRequestException } from '@nestjs/common';
import { MINING_STRATEGIES } from '../shared/mining-strategies.js';

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
  const allowedStrategies: string[] = MINING_STRATEGIES.map(strategy => strategy.id);
  const mining = auditMode === 'dynamic' ? [] : input.miningStrategies ?? [choice(input.miningStrategy, allowedStrategies, 'focus_area')];
  if (!Array.isArray(mining) || (auditMode !== 'dynamic' && !mining.length) || mining.length > allowedStrategies.length
    || mining.some(value => typeof value !== 'string' || !allowedStrategies.includes(value)) || new Set(mining).size !== mining.length) {
    throw new BadRequestException('请至少选择一种有效的漏洞挖掘方式，且不能重复。');
  }
  if (auditMode !== 'dynamic' && input.miningStrategies != null && input.miningStrategy != null
    && (mining.length !== 1 || mining[0] !== input.miningStrategy)) throw new BadRequestException('新旧漏洞挖掘方式字段不一致。');
  const apiInventory = mining.includes('api') ? textField(input.apiInventory, 'API 清单', 120000, true) : '';
  let creedOptions: { paths?: string[]; symbols?: string[] } | undefined;
  if (mining.includes('creed') && input.creedOptions != null) {
    if (typeof input.creedOptions !== 'object' || Array.isArray(input.creedOptions) || Object.keys(input.creedOptions).some(key => !['paths', 'symbols'].includes(key))) throw new BadRequestException('CREED 范围格式无效。');
    creedOptions = {};
    for (const key of ['paths', 'symbols'] as const) {
      const entries = (input.creedOptions as Record<string, unknown>)[key];
      if (entries == null) continue;
      const maximum = key === 'paths' ? 1000 : 400;
      if (!Array.isArray(entries) || entries.length > 200 || entries.some(value => typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/u.test(value))) throw new BadRequestException(`CREED 范围每类最多 200 项，${key === 'paths' ? '路径' : '函数名'}每项为 1–${maximum} 字符。`);
      creedOptions[key] = [...new Set(entries.map(value => value.trim()))];
    }
    if (creedOptions.paths) creedOptions.paths = creedOptions.paths.map(path => path.replaceAll('\\', '/').replace(/\/$/, ''));
    if (creedOptions.paths?.some(path => !path || /^(?:[A-Za-z]:|[/\\])/.test(path) || path.split(/[\\/]/).includes('..') || /[*?\[\]{}]/.test(path))) throw new BadRequestException('CREED 路径必须是源码根内的相对目录或文件，不支持通配符。');
  }
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
    model: textField(input.model ?? 'default', '模型', 240), task_protocol: 'task-board.v1',
    ...(auditMode === 'dynamic' ? {} : { mining_contract: 'mining-strategies.v1', mining_strategies: mining }), api_inventory: apiInventory,
    ...(creedOptions ? { creed_options: creedOptions } : {}),
    memory_mode: choice(input.memoryMode, ['full', 'facts_only', 'off', 'blind'], 'full'), bac_analysis: choice(input.bacAnalysis, ['auto', 'off'], 'auto'),
    additional_instructions_enabled: additionalEnabled, additional_instructions: additional,
    test_environment_enabled: environmentEnabled, test_environment_context: environmentEnabled ? environment : '', runtime_testing: runtime } };
}
