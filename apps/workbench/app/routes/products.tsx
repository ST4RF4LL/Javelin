import { Link } from 'react-router';
import { Layers3, GitBranch, ArrowUpRight, ScanLine, ShieldAlert, Search } from 'lucide-react';
import { useState } from 'react';
import { PageHeading, Loading, ErrorState, EmptyState } from '../components/common';
import { useSnapshot, useWorkspace } from '../lib/workspace';
export default function PreviewProducts() {
  const query = useSnapshot(); const { source, runtime } = useWorkspace(); const [search, setSearch] = useState('');
  if (query.isPending) return <Loading />; if (query.error) return <ErrorState error={query.error} retry={query.refetch} />;
  const products = query.data.products.filter(p => `${p.name} ${p.repositories.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="page-enter"><PageHeading eyebrow="PRODUCTS & REPOSITORIES" title="产品与审计对象" description="以产品组织源码与历史审计，持续积累可复用的安全知识。" /><div className="product-toolbar"><span>{query.data.products.length} 个产品空间{source === 'live' && ' · 当前加载'}</span><div className="search-field"><Search size={15} /><input aria-label="搜索产品" placeholder="搜索产品或仓库…" value={search} onChange={e => setSearch(e.target.value)} /></div></div><div className="products-grid">{products.map((p, i) => <article className="panel product-card" key={p.id}><div className="product-card-top"><span className={`product-symbol color-${i % 4}`}><Layers3 size={22} /></span><span className="product-tag">{p.targetCount ?? p.repositories.length} 个对象</span></div><h2>{p.name}</h2><p>{p.description}</p><div className="product-repos">{source === 'live' && <a href={runtime.legacyUrl}>在原工作台查看对象与产品记忆<ArrowUpRight size={13} /></a>}{p.repositories.map(r => <Link key={r} to={`/audits?q=${encodeURIComponent(r)}`}><GitBranch size={14} /><code>{r}</code><ArrowUpRight size={13} /></Link>)}</div><div className="product-stats">{source === 'demo' && <span><ScanLine size={14} />{p.audits} 次审计</span>}{source === 'demo' && <span><ShieldAlert size={14} />{p.findings} 条发现</span>}</div></article>)}</div>{!products.length && <EmptyState />}</div>;
}
