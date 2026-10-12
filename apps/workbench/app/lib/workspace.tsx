import { createContext, useContext, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Source, WorkbenchRuntime, RealAuditDraft, BatchAuditSelection } from '../../shared/contracts';
import { api } from './api';
const Context = createContext<{ source: Source; setSource: (source: Source) => void; createOpen: boolean; batchSelection: BatchAuditSelection | null; openBatch: (selection: BatchAuditSelection) => void; setCreateOpen: (value: boolean) => void; retryDraft: RealAuditDraft | null; openRetry: (draft: RealAuditDraft) => void; runtime: WorkbenchRuntime } | null>(null);
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const config = useQuery({ queryKey: ['runtime-config'], queryFn: api.runtime, staleTime: Infinity, retry: 1 });
  if (config.isPending) return <div className="initial-loading" role="status">正在连接工作台…</div>;
  if (config.error) return <div className="initial-loading" role="alert"><p>{config.error.message}</p><button onClick={() => void config.refetch()}>重新连接</button></div>;
  return <ReadyWorkspace runtime={{ ...config.data, legacyUrl: config.data.legacyUrl === 'http://127.0.0.1:4173/' ? config.data.legacyUrl : null }}>{children}</ReadyWorkspace>;
}
function ReadyWorkspace({ children, runtime }: { children: ReactNode; runtime: WorkbenchRuntime }) {
  const [source, setSourceState] = useState<Source>(runtime.defaultSource); const [createOpen, setCreateOpenState] = useState(false); const [retryDraft, setRetryDraft] = useState<RealAuditDraft | null>(null);
  const [batchSelection, setBatchSelection] = useState<BatchAuditSelection | null>(null);
  const setCreateOpen = (open: boolean) => { setRetryDraft(null); setBatchSelection(null); setCreateOpenState(open); };
  const openBatch = (selection: BatchAuditSelection) => { setRetryDraft(null); setBatchSelection({ productId: selection.productId, targetIds: [...selection.targetIds] }); setCreateOpenState(true); };
  const openRetry = (draft: RealAuditDraft) => { setRetryDraft(draft); setBatchSelection(null); setCreateOpenState(true); };
  const client = useQueryClient();
  const setSource = (value: Source) => { if (value === 'demo' && !runtime.demoEnabled) return; void client.cancelQueries(); setCreateOpen(false); setSourceState(value); };
  return <Context.Provider value={{ source, setSource, createOpen, batchSelection, openBatch, setCreateOpen, retryDraft, openRetry, runtime }}>{children}</Context.Provider>;
}
export function useWorkspace() { const value = useContext(Context); if (!value) throw new Error('WorkspaceProvider missing'); return value; }
export function useSnapshot() { const { source } = useWorkspace(); return useQuery({ queryKey: ['snapshot', source], queryFn: ({ signal }) => api.snapshot(source, signal), staleTime: 15000, refetchInterval: source === 'live' ? 15000 : false, retry: 1 }); }

export function useFindings(auditId?: string, filters: Record<string, string> = {}) {
  const { source } = useWorkspace();
  return useQuery({ queryKey: ['findings', source, auditId, filters], queryFn: ({ signal }) => api.findings(source, auditId, signal, filters), staleTime: 15000,
    refetchInterval: query => source === 'live' && !query.state.error ? 15000 : false, retry: false, networkMode: 'always', refetchOnWindowFocus: false });
}
