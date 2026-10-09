import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/button';
import { useWorkspace } from '../lib/workspace';

export type OriginalView = 'dashboard' | 'projects' | 'audits' | 'findings' | 'reports' | 'validation' | 'runtime' | 'settings';
const routes: Record<OriginalView, string> = { dashboard: '/', projects: '/products', audits: '/audits', findings: '/findings', reports: '/reports', validation: '/validation', runtime: '/runtime', settings: '/settings' };
const theme = `
:host { display:block; --ink:#323443; --muted:#858898; --line:#e8e7ee; --canvas:#f8f9fc; --panel:#fff; --green:#8064d9; --green-soft:#f0ebfc; --night:#39304d; font:14px Inter,-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif; color:var(--ink); }
.app-shell { display:block; min-height:0; } .app-shell>.sidebar { display:none; }
.workspace { min-width:0; } .workspace>.topbar { position:static; height:auto; min-height:0; padding:0 0 20px; border:0; background:transparent; box-shadow:none; }
.workspace>.topbar>div:first-child, #modern-workbench-link { display:none!important; }
.workspace>main { padding:0; max-width:none; } .page-heading { margin-top:0; } .panel { border-radius:16px; box-shadow:0 2px 8px #25213804; }
.button { border-radius:9px; font-weight:600; } .button.primary { background:var(--green); border-color:var(--green); }
.hero { background:linear-gradient(120deg,#60518b,#8a6ac5); } .view { animation:none; }
dialog { color:var(--ink); } #toast { z-index:2147483647; }
`;
type Controller = { ready: Promise<unknown>; destroy: () => void; refresh: () => Promise<unknown>; setView: (view: OriginalView) => void; navigate: (view: OriginalView, filters: Record<string, string>, auditId?: string) => Promise<unknown> };

// 在 Shell 中持续挂载，切换页面时保留产品选择、筛选和原控制器状态。
export function OriginalFeature({ view, auditId, hidden = false }: { view: OriginalView; auditId?: string; hidden?: boolean }) {
  const { runtime } = useWorkspace();
  const queryClient = useQueryClient();
  const host = useRef<HTMLDivElement>(null); const navigate = useNavigate(); const [params] = useSearchParams();
  const [controller, setController] = useState<Controller | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [attempt, setAttempt] = useState(0);
  const location = useRef({ view, auditId }); location.current = { view, auditId };
  const shownView = useRef(view);
  const search = params.toString();
  useEffect(() => {
    const element = host.current!; const root = element.shadowRoot || element.attachShadow({ mode: 'open' });
    const abort = new AbortController(); let mounted: Controller | undefined, disposed = false;
    setController(null); setError(''); setLoading(true);
    void (async () => {
      if (runtime.featureVersion !== 1) throw new Error('运行中的后台尚未加载本次功能更新。请重启平台后刷新页面。');
      const read = async (path: string) => { const response = await fetch(path, { signal: abort.signal }); if (!response.ok) throw new Error(`功能模块加载失败（${response.status}）`); return response.text(); };
      const moduleUrl = '/app.js';
      const [html, styles, module] = await Promise.all([read('/legacy/'), read('/styles.css'), import(/* @vite-ignore */ moduleUrl)]);
      if (disposed) return;
      const parsed = new DOMParser().parseFromString(html, 'text/html'); parsed.querySelectorAll('script').forEach(node => node.remove());
      const style = document.createElement('style'); style.textContent = styles.replace(/:root\b/g, ':host') + theme;
      const body = document.createElement('div'); body.append(...Array.from(parsed.body.childNodes)); root.replaceChildren(style, body);
      const scopedDocument = new Proxy(document, { get(target, key) {
        if (key === 'body' || key === 'documentElement') return body;
        if (key === 'activeElement') return root.activeElement;
        if (key === 'getElementById') return (id: string) => body.querySelector(`#${CSS.escape(id)}`);
        if (key === 'querySelector' || key === 'querySelectorAll') return body[key].bind(body);
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      mounted = module.mountWorkbench({ document: scopedDocument, initialView: location.current.view, onNavigate: (next: OriginalView) => { if (next !== location.current.view) navigate(routes[next]); }, onFileCoverage: (id: string) => navigate(`/audits/coverage?audit_id=${encodeURIComponent(id)}`), onMutation: () => { void queryClient.invalidateQueries(); } });
      shownView.current = location.current.view;
      // 原页面按资源到达逐步显示，模型或目录读取不能阻塞整个页面。
      if (!disposed) { setController(mounted!); setLoading(false); }
    })().catch(cause => { if (!disposed) { setError(cause.message); setLoading(false); } });
    return () => { disposed = true; abort.abort(); mounted?.destroy(); root.replaceChildren(); };
  }, [attempt, navigate, runtime.featureVersion, queryClient]);
  useEffect(() => {
    if (!controller) return;
    setError('');
    let current = true;
    if (shownView.current !== view) controller.setView(view);
    shownView.current = view;
    void controller.ready.then(() => current && controller.navigate(view, Object.fromEntries(new URLSearchParams(search)), auditId)).catch(cause => { if (current) setError(cause.message); });
    return () => { current = false; };
  }, [controller, view, auditId, search]);
  useEffect(() => {
    if (!controller) return;
    const refresh = () => { setError(''); void controller.refresh().catch(cause => setError(cause.message)); };
    window.addEventListener('workbench:refresh', refresh);
    return () => window.removeEventListener('workbench:refresh', refresh);
  }, [controller]);
  useEffect(() => {
    if (hidden) host.current?.shadowRoot?.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach(dialog => dialog.close());
  }, [hidden]);
  return <div className="page-enter original-feature" hidden={hidden}>{loading && <p role="status">正在加载完整工作台功能…</p>}{error && <div className="task-alert" role="alert"><p>{error}</p><Button variant="outline" onClick={() => setAttempt(value => value + 1)}>重新加载</Button></div>}<div ref={host} hidden={loading} /></div>;
}
