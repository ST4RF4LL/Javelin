import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export function relativeTime(value: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  if (minutes < 1) return '刚刚'; if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`; return `${Math.floor(minutes / 1440)} 天前`;
}
export function dateText(value: string) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('zh-CN') : '—'; }
export const statusLabels: Record<string, string> = { running: '运行中', paused: '已暂停', queued: '排队中', completed: '已完成', failed: '执行失败', interrupted: '已中断', cancelled: '已取消', preparing: '准备中', recovering: '恢复中', pausing: '正在暂停', cancelling: '正在取消', artifact_only: '历史制品' };
export const severityLabels: Record<string, string> = { critical: '严重', high: '高危', medium: '中危', low: '低危', info: '信息', unknown: '未评级' };

export const findingStatusLabels: Record<string, string> = { unreviewed: '待复核', confirmed: '已确认', rejected: '已排除', insufficient_evidence: '证据不足', awaiting_validation: '待验证', validated: '验证通过', validation_failed: '验证未通过', validation_blocked: '验证受阻', reported: '已入报告' };
