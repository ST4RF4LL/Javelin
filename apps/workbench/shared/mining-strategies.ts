import type { MiningStrategy } from './contracts.js';

export const MINING_STRATEGIES: { id: MiningStrategy; label: string; description: string }[] = [
  { id: 'focus_area', label: 'Focus Area · 风险优先', description: '围绕风险区域、源码疑点和安全边界深入分析。' },
  { id: 'api', label: '逐 API · 接口审查', description: '按你提供的 API 清单定位实现，审查接口及关联调用链。' },
  { id: 'file_sweep', label: '逐文件 · 全面浏览', description: '浏览冻结范围中的文件，将疑点交给专业 Agent 深入审查；浏览与交付分别统计。' },
  { id: 'creed', label: 'CREED · 假设驱动', description: '对完整函数分析行为、开发者假设、合理性与失效条件，保留可核查的证据链。' },
];

export function draftMiningStrategies(input: { miningStrategies?: MiningStrategy[]; miningStrategy?: MiningStrategy; apiInventory?: string }): MiningStrategy[] {
  return input.miningStrategies ? [...input.miningStrategies] : [input.miningStrategy || (input.apiInventory?.trim() ? 'api' : 'focus_area')];
}
