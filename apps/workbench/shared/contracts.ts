export type Source = 'demo' | 'live';
export const WORKBENCH_API_VERSION = 3;
export interface WorkbenchRuntime { mode: 'preview' | 'integrated'; defaultSource: Source; demoEnabled: boolean; liveReadOnly: boolean; legacyUrl: string | null; featureVersion?: number }
export type AuditStatus = 'running' | 'paused' | 'queued' | 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'preparing' | 'recovering' | 'pausing' | 'cancelling' | 'artifact_only';
export interface Stage { id: string; label: string; status: 'done' | 'active' | 'pending' | 'gap' }
export interface LogEntry { sequence: number; time: string; level: string; agent: string; message: string }
export interface Audit {
  productId?: string; targetId?: string; allowedActions?: AuditAction[]; canRetry?: boolean; executionIncomplete?: boolean; error?: string; logsError?: string; runtimeTestingStatus?: string;
  id: string; name: string; repository: string; product: string; branch: string; commit: string;
  status: AuditStatus; progress: number; stage: string; findings: number; updatedAt: string;
  version: number; strategy: string; model: string; tasks: { total: number; done: number; gap: number };
  stages: Stage[]; logs: LogEntry[]; source: Source;
}
export interface Finding { id: string; title: string; severity: string; status: string; repository: string; auditId: string; path: string; description: string; remediation?: string; evidence?: { text: string; kind: string }[] }
export interface FindingPage { findings: Finding[]; count: number; page: number; pageSize: number; totalPages: number }
export interface Product { id: string; name: string; description: string; repositories: string[]; audits: number; findings: number; targetCount?: number }
export interface Report { id: string; name: string; auditId: string; repository: string; date: string; status: string }
export interface ReportContent extends Report { body: string; html: string; presentation?: { format: string; derived: boolean; source_sha256: string; sha256: string } }
export interface Snapshot {
  source: Source; generatedAt: string; audits: Audit[]; products: Product[]; reports: Report[];
  summary: { audits: number; running: number; findings: number; reports: number; validations?: number; targets?: number; severity?: Record<string, number> };
}
export interface AuditPage { items: Audit[]; count: number; page: number; pageSize: number; totalPages: number }
export type AuditAction = 'pause' | 'resume' | 'recover' | 'cancel' | 'dispatch';
export interface TaskProduct { id: string; name: string; status: string }
export interface TaskTarget { id: string; name: string; path: string; runnable: boolean; reason: string }
export interface TaskOptions { runnerEnabled: boolean; products: TaskProduct[]; models: { value: string; label: string }[]; selectedModel: string }
export interface TaskModels { models: { value: string; label: string }[]; selectedModel: string }
export interface RealAuditInput {
  productId: string; targetId: string; auditId: string; name: string; model: string;
  miningStrategy: 'focus_area' | 'api'; apiInventory: string; memoryMode: string; bacAnalysis: string;
  additionalInstructionsEnabled: boolean; additionalInstructions: string;
  testEnvironmentEnabled: boolean; testEnvironmentContext: string;
  runtimeTesting: { mode: string; budgetMinutes: number; identityMode: string; testInput: boolean; testMutation: boolean };
}
export type RealAuditDraft = Omit<RealAuditInput, 'auditId'>;
