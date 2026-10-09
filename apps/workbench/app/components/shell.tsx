import { NavLink, Outlet, Link, useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { LayoutDashboard, Layers3, ScanLine, ShieldAlert, FileText, Settings2, ChevronsUpDown, ArrowUpRight, ChevronRight, RefreshCw, PanelLeftClose, Menu, FlaskConical, Radio, Command, Search, X } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { useSnapshot, useWorkspace } from '../lib/workspace';
import { CreateAudit } from './create-audit';
import { OriginalFeature, type OriginalView } from './original-feature';
const navigation = [
  { to: '/', label: '工作台概览', icon: LayoutDashboard }, { to: '/products', label: '产品与对象', icon: Layers3 },
  { to: '/audits', label: '审计任务', icon: ScanLine }, { to: '/findings', label: '漏洞发现', icon: ShieldAlert }, { to: '/reports', label: '审计报告', icon: FileText },
  { to: '/validation', label: '动态验证', icon: FlaskConical }, { to: '/runtime', label: '运行环境', icon: Radio },
];
export default function Shell() {
  const { source, setSource, runtime } = useWorkspace(); const snapshot = useSnapshot(); const client = useQueryClient();
  const [menu, setMenu] = useState(false); const location = useLocation();
  const featureViews: Record<string, OriginalView> = { products: 'projects', audits: 'audits', findings: 'findings', reports: 'reports', validation: 'validation', runtime: 'runtime', settings: 'settings' };
  const view = featureViews[location.pathname.split('/')[1]];
  const isCoverage = location.pathname === '/audits/coverage';
  const auditId = isCoverage ? undefined : location.pathname.match(/^\/audits\/([^/]+)$/)?.[1];
  const current = isCoverage ? '文件覆盖率' : navigation.find(n => n.to !== '/' && location.pathname.startsWith(n.to))?.label || (location.pathname === '/settings' ? '工作台设置' : '工作台概览');
  return <div className="app-shell"><aside className={cn('sidebar', menu && 'mobile-open')}><Link to="/" className="brand"><div className="brand-mark"><span /><span /><span /></div><div>DeepHole<span>SECURITY WORKSPACE</span></div></Link>
    <Link to="/settings" className="workspace-switch" onClick={() => setMenu(false)}><span className="workspace-avatar">S</span><span><strong>安全工程中心</strong><small>Workspace / 01</small></span><ChevronRight size={14} /></Link>
    <div className="nav-label">工作空间</div><nav aria-label="主导航">{navigation.map(n => <Fragment key={n.to}><NavLink to={n.to} end={n.to === '/'} onClick={() => setMenu(false)} className={({ isActive }) => cn('nav-item', isActive && 'active')}><n.icon size={18} strokeWidth={1.7} /><span>{n.label}</span>{n.to === '/audits' && !!snapshot.data?.summary.running && <em>{snapshot.data.summary.running}</em>}</NavLink>{n.to === '/audits' && <NavLink to={`/audits/coverage${auditId ? `?audit_id=${encodeURIComponent(decodeURIComponent(auditId))}` : ''}`} onClick={() => setMenu(false)} className={({ isActive }) => cn('nav-item nav-subitem', isActive && 'active')}><FileText size={15} strokeWidth={1.7} /><span>文件覆盖率</span></NavLink>}</Fragment>)}</nav>
    <div className="nav-label second">管理</div><NavLink to="/settings" onClick={() => setMenu(false)} className={({ isActive }) => cn('nav-item', isActive && 'active')}><Settings2 size={18} strokeWidth={1.7} /><span>工作台设置</span></NavLink>
    <div className="sidebar-bottom"><div className="engine-card"><span className="engine-icon"><Radio size={17} /></span><div><strong>{source === 'demo' ? '交互演示已就绪' : snapshot.isError ? '等待连接工作台' : runtime.liveReadOnly ? '真实数据 · 只读' : '真实任务运行模式'}</strong><p>{source === 'demo' ? '探索全新的审计体验' : '连接原工作台 API'}</p></div><i className={cn('connection-dot', snapshot.isError && source === 'live' && 'offline')} /></div><div className="profile"><div className="avatar">W</div><div><strong>工作台管理员</strong><small>本地工作空间</small></div><span className="profile-key"><Command size={13} /></span></div></div>
  </aside>{menu && <button className="sidebar-backdrop" aria-label="关闭导航" onClick={() => setMenu(false)} />}
  <div className="main-shell"><header className="topbar"><div className="breadcrumb"><button className="mobile-menu icon-button" onClick={() => setMenu(!menu)} aria-label="打开导航"><Menu size={20} /></button><span className="breadcrumb-root">工作空间</span><ChevronRight size={14} /><span>{current}</span></div><div className="topbar-actions"><a href={runtime.legacyUrl} aria-label="返回原工作台" className="legacy-link"><ArrowUpRight size={14} /><span>返回原工作台</span></a><label className="source-picker"><span className={cn('source-dot', source === 'live' && 'live')} /><select aria-label="数据来源" value={source} disabled={!runtime.demoEnabled} onChange={e => setSource(e.target.value as 'demo' | 'live')}>{runtime.demoEnabled && <option value="demo">演示预览</option>}<option value="live">{runtime.liveReadOnly ? '真实数据 · 只读' : '真实任务 · 可执行'}</option></select><ChevronsUpDown size={12} /></label><span className="topbar-divider" /><Button variant="ghost" size="icon" aria-label="刷新数据" onClick={() => { void client.invalidateQueries(); window.dispatchEvent(new Event('workbench:refresh')); }}><RefreshCw size={16} className={snapshot.isFetching ? 'animate-spin' : ''} /></Button><div className="avatar small">W</div></div></header>
    <main className="main-content">{source === 'live' && <OriginalFeature view={view || 'dashboard'} auditId={auditId && decodeURIComponent(auditId)} hidden={!view || isCoverage} />}{(source !== 'live' || !view || isCoverage) && <Outlet />}</main><footer className="app-footer"><span><span className="footer-dot" />DeepHole 安全审计工作台</span><span>{source === 'demo' ? '演示数据 · 不代表真实审计结果' : '真实数据 · 原平台共享 API'}<span className="footer-version">{runtime.mode === 'integrated' ? runtime.liveReadOnly ? 'INTEGRATION / 01' : 'TASKS / 02' : 'PREVIEW / 01'}</span></span></footer>
  </div><CreateAudit /></div>;
}
