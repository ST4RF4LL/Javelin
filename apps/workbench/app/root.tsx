import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useRouteError } from 'react-router';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { WorkspaceProvider } from './lib/workspace';
import './styles.css';
export function Layout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="theme-color" content="#f8f9fc" /><link rel="icon" href="/favicon.svg" type="image/svg+xml" /><title>DeepHole · 安全审计工作台</title><Meta /><Links /></head><body>{children}<ScrollRestoration /><Scripts /></body></html>;
}
export default function App() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } }));
  return <QueryClientProvider client={client}><WorkspaceProvider><Outlet /><Toaster richColors position="bottom-right" /></WorkspaceProvider></QueryClientProvider>;
}
export function HydrateFallback() { return <div className="initial-loading"><div className="brand-mark">D</div><p>正在载入安全工作台…</p></div>; }
export function ErrorBoundary() { const error = useRouteError(); return <div className="initial-loading"><h1>页面暂时无法显示</h1><p>{isRouteErrorResponse(error) ? `${error.status} · ${error.statusText}` : '请刷新页面后重试。'}</p><a href="/">返回工作台</a></div>; }
