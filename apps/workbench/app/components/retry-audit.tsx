import { useMutation } from '@tanstack/react-query';
import { LoaderCircle, RotateCcw } from 'lucide-react';
import { Button } from './ui/button';
import { useWorkspace } from '../lib/workspace';
import { api } from '../lib/api';
import type { Audit } from '../../shared/contracts';

export function RetryAuditButton({ audit }: { audit: Audit }) {
  const { source, runtime, openRetry } = useWorkspace();
  const draft = useMutation({ mutationFn: () => api.retryDraft(audit.id), retry: false, gcTime: 0, onSuccess: value => { openRetry(value); draft.reset(); } });
  if (source !== 'live' || runtime.liveReadOnly || !audit.canRetry) return null;
  return <span className="retry-action"><Button variant="outline" size="sm" disabled={draft.isPending} onClick={() => draft.mutate()}>{draft.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <RotateCcw size={14} />}{audit.status === 'completed' && !audit.executionIncomplete ? '再次审计' : '新建重试'}</Button>{draft.error && <span role="alert" className="task-error">{draft.error.message}</span>}</span>;
}
