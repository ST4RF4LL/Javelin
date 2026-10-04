export function initProductMemoryUI({ state, api, element, table, status, toast, loadProducts, loadFindingsPage, openAuditDialog, document = globalThis.document, window = globalThis.window }) {
  const $ = id => document.getElementById(id);
  const local = { generation: 0, refreshSequence: 0, memorySequence: 0, productId: null, tree: null, busy: null, offset: 0, issueOffset: 0, todoOffset: 0, findingSequence: 0, selectedRepos: new Set() };
  const labels = { DETACHED: '已解除关联', UNAVAILABLE: '不可用', INTERRUPTED: '已中断', DISPATCHING: '派发中', PRESENT: '可用', MISSING: '目录缺失', UNKNOWN: '尚未确定', SCANNING: '发现中', READY: '已发现', PARTIAL: '部分完成', PENDING: '待执行', RUNNING: '运行中', COMPLETED: '已完成', FAILED: '失败', GAP: '存在缺口', PAUSED: '已暂停', CANCELLED: '已取消', CANCELLING: '取消中', UNREVIEWED: '未判断', TRUE_POSITIVE: '真实漏洞', FALSE_POSITIVE: '误报', INSUFFICIENT_EVIDENCE: '证据不足', OPEN: '未完成', FIX_IN_PROGRESS: '修复中', FIX_CLAIMED: '声称已修复', FIX_VERIFIED: '人工核查已修复', REOPENED: '重新出现', RISK_ACCEPTED: '接受风险', OBSERVED: '本轮观察', REVIEWED: '已复核', PROPOSED: '待证实', LEGACY_UNBOUND: '历史记录，版本待核对', ANSWERED: '已有回答', RESOLVED: '已解决', DEFERRED: '后续处理', STALE: '已过期', CLAIMED: '处理中' };
  const label = value => labels[value] ?? value;
  const prefix = p => `/api/v2/products/${encodeURIComponent(p)}`;
  const action = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) });
  const button = (title, callback, primary = false) => { const b = element('button', `button ${primary ? 'primary' : 'secondary'}`, title); b.type = 'button'; b.addEventListener('click', () => Promise.resolve().then(callback).catch(e => toast(e.message))); return b; };
  const input = (name, placeholder = '', value = '') => { const i = element('input'); i.name = name; i.placeholder = placeholder; i.value = value; return i; };
  const field = (title, control) => { const l = element('label', '', title); l.append(control); return l; };
  const select = values => { const s = element('select'); for (const [value, title] of values) { const o = element('option', '', title); o.value = value; s.append(o); } return s; };
  const panel = (title, hint) => { const a = element('article', 'panel product-memory-panel'); a.append(element('h2', '', title)); if (hint) a.append(element('p', 'muted', hint)); return a; };
  const host = $('product-memory-workspace');
  const treePanel = panel('产品目录与 Repo', '目录自动发现后纳入产品；选择产品、模块或 Repo 开始联合静态审计。');
  const toolbar = element('div', 'memory-toolbar'), rootInput = input('root', '产品或组件的主机绝对目录');
  const treeBody = element('div', 'data-table');
  toolbar.append(rootInput, button('绑定目录', async () => { await action(`${prefix(state.selectedProductId)}/roots`, { path: rootInput.value }); rootInput.value = ''; await refresh(true); }), button('刷新目录树', async () => { for (const root of local.tree?.roots ?? []) await action(`${prefix(state.selectedProductId)}/roots/${root.id}/refresh`, {}); await refresh(true); }), button('审计整个产品', () => openCampaign({}), true));
  treePanel.append(toolbar, treeBody);
  const campaignsPanel = panel('产品级审计批次', '各 Repo 独立执行，产品批次汇总跨 Repo 分析、证据与剩余待办。');
  const campaignsBody = element('div', 'memory-campaigns'); campaignsPanel.append(campaignsBody);
  const memoryPanel = panel('长期记忆', '历史结论保留版本与理由，下一轮需要核查当前源码。');
  const memoryBar = element('div', 'memory-toolbar'), repoFilter = select([['', '产品内全部 Repo']]), kindFilter = select([['', '全部记录'], ['interface', '接口'], ['asset', '价值资产'], ['coverage', '覆盖记录'], ['finding', '漏洞观察'], ['relation', '调用与关系'], ['lesson', '经验'], ['gap', '缺口'], ['inventory', '清单完整性']]), queryInput = input('query', '检索接口、资产、问题或判断依据');
  const memoryBody = element('div'), memoryPagination = element('div', 'memory-toolbar');
  memoryBar.append(repoFilter, kindFilter, queryInput, button('查询记忆', () => { local.offset = 0; return loadMemory(); }));
  memoryPanel.append(memoryBar, memoryBody, memoryPagination);
  const issuesPanel = panel('跨轮次问题与人工判断', '问题保留每轮观察；重复、同类、共同根因与整改状态分别记录。'), issuesBody = element('div', 'data-table'); issuesPanel.append(issuesBody);
  const todosPanel = panel('产品长期待办', '寻找入口、检查同类问题、验证修复和补全链路；未解决的工作保留到后续审计。'), todosBody = element('div'); todosPanel.append(todosBody);
  host?.append(treePanel, campaignsPanel, memoryPanel, issuesPanel, todosPanel);

  function valid(product, generation) { return product === state.selectedProductId && generation === local.generation; }
  async function refresh(force = false) {
    if (!host || !state.selectedProductId || state.view !== 'projects') return;
    const product = state.selectedProductId;
    if (local.productId !== product) {
      local.productId = product; local.generation++; local.offset = 0; local.issueOffset = 0; local.todoOffset = 0; local.tree = null; local.selectedRepos.clear();
      for (const node of [treeBody, campaignsBody, memoryBody, issuesBody, todosBody]) node.replaceChildren(element('p', 'muted', '正在加载…'));
    }
    if (local.busy && !force) return local.busy;
    const generation = local.generation, sequence = ++local.refreshSequence, run = (async () => {
      const [tree, campaigns, issues, todos] = await Promise.all([api(`${prefix(product)}/tree`), api(`${prefix(product)}/product-audits?limit=20`), api(`${prefix(product)}/issues?limit=30&offset=${local.issueOffset}`), api(`${prefix(product)}/memory/todos?limit=30&offset=${local.todoOffset}`)]);
      if (!valid(product, generation) || sequence !== local.refreshSequence) return;
      local.tree = tree; renderTree(tree); renderCampaigns(campaigns.items); renderIssues(issues); renderTodos(todos);
      await loadMemory();
    })(); local.busy = run;
    try { await run; } catch (error) { if (valid(product, generation)) treeBody.replaceChildren(element('p', 'notice error', error.message)); }
    finally { if (local.busy === run) local.busy = null; }
  }
  function renderTree(tree) {
    const oldFilter = repoFilter.value;
    repoFilter.replaceChildren(...select([['', '产品内全部 Repo'], ...tree.nodes.filter(n => n.kind === 'repo').map(n => [n.id, n.name])]).children); repoFilter.value = oldFilter;
    const [grid, body] = table(['模块 / Repo', '目录', '类型与状态', '操作']);
    for (const node of tree.nodes) {
      const row = element('tr'), title = element('td', '', `${node.kind === 'repo' ? '▣' : '▸'} ${node.name}`); title.style.paddingLeft = `${12 + Math.max(0, node.relative_path.split('/').length - 1) * 18}px`;
      const type = node.kind === 'repo' ? node.source_kind === 'git' ? 'Git Repo' : '源码 Repo' : node.kind === 'candidate' ? '待识别目录' : '模块';
      row.append(title, element('td', 'mono', node.path), element('td', '', `${type} · ${label(node.status)}`));
      const actions = element('td', 'memory-row-actions');
      if (node.status === 'PRESENT') actions.append(button('审计此范围', () => openCampaign({ node_id: node.id, title: node.name })));
      if (node.kind === 'repo') actions.append(button('版本与差异', () => showRepo(node)));
      const root = tree.roots.find(r => r.id === node.root_id);
      if (root) {
        const kind = select([['', '调整识别边界'], ['repo', '设为 Repo'], ['module', '设为模块'], ['ignore', '忽略'], ['auto', '恢复自动识别']]);
        kind.addEventListener('change', async () => { if (!kind.value) return; try { await action(`${prefix(state.selectedProductId)}/roots/${root.id}/boundary`, { version: root.version, relative_path: node.relative_path, kind: kind.value }); await refresh(true); } catch (error) { toast(error.message); } }); actions.append(kind);
      }
      row.append(actions); body.append(row);
    }
    const notes = tree.roots.map(root => element('p', 'muted', `${root.path} · ${label(root.status)} · 目录代次 ${root.generation}${root.discovery?.gaps?.length ? ` · ${root.discovery.gaps.length} 项识别缺口` : ''}`));
    treeBody.replaceChildren(...notes, tree.nodes.length ? grid : element('p', 'empty-state', '绑定目录后会自动发现 Repo。已有测试对象仍可继续使用。'));
  }
  function modal(title) {
    const dialog = element('dialog', 'memory-dialog'), article = element('article', 'report-dialog-body');
    const head = element('div', 'dialog-heading'); head.append(element('h2', '', title), button('关闭', () => dialog.close())); article.append(head); dialog.append(article); document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal(); return { dialog, article };
  }
  async function openCampaign(selection) {
    if (!state.runtime?.runner?.enabled) { toast('请先启用审计执行器。'); return; }
    const productId = state.selectedProductId, { dialog, article } = modal(`联合静态审计${selection.title ? ` · ${selection.title}` : ''}`);
    const form = element('form', 'memory-form'), name = input('name', '批次名称', `${selection.title ?? state.products.find(p => p.id === productId)?.name ?? '产品'} 联合审计`);
    name.required = true;
    const model = select((state.modelSettings?.options ?? [{ value: 'default', label: '默认' }]).map(o => [o.value, o.label])); model.value = state.modelSettings?.selected_model ?? 'default';
    const mode = select([['full', '使用历史事实、人工理由与产品经验'], ['facts_only', '仅参考接口、资产与结构事实'], ['off', '不读取历史记忆'], ['blind', '盲审：隔离历史漏洞经验']]);
    const notes = element('textarea'); notes.maxLength = 8000; const error = element('p', 'notice error'); error.hidden = true;
    const submit = element('button', 'button primary', '创建产品审计批次'); submit.type = 'submit';
    form.append(field('批次名称', name), field('模型', model), field('历史记忆', mode), field('审计重点（可选）', notes), element('p', 'muted', '冻结当前选中 Repo 与源码版本。跨 Repo 补审限于本轮范围；动态测试沿用单 Repo 的授权入口。'), error, submit);
    form.addEventListener('submit', async event => { event.preventDefault(); submit.disabled = true;
      try { await action(`${prefix(productId)}/product-audits`, { ...(selection.node_id ? { node_id: selection.node_id } : {}), name: name.value, model: model.value, memory_mode: mode.value, additional_instructions: notes.value }); dialog.close(); toast('产品审计批次已创建'); await refresh(true); }
      catch (cause) { error.textContent = cause.message; error.hidden = false; } finally { submit.disabled = false; } }); article.append(form);
  }
  function renderCampaigns(campaigns) {
    campaignsBody.replaceChildren();
    for (const campaign of campaigns) {
      const card = element('article', 'memory-run'); card.append(element('h3', '', campaign.name), element('p', 'muted', `${label(campaign.status)} · ${campaign.spec.repos.length} 个 Repo · ${campaign.progress.completed}/${campaign.progress.total} 项交付 · ${campaign.progress.gaps} 项缺口`));
      const detail = element('details'), summary = element('summary', '', '查看 Repo、补审与跨 Repo 分析进度'); detail.append(summary);
      for (const job of campaign.jobs) detail.append(element('p', '', `${job.spec.name ?? '跨 Repo 分析'} · ${job.kind} · ${label(job.status)}${job.error ? `：${job.error}` : ''}`)); card.append(detail);
      const actions = element('div', 'memory-toolbar');
      for (const [act, title] of campaign.status === 'RUNNING' ? [['pause', '暂停'], ['cancel', '取消']] : campaign.status === 'PAUSED' ? [['resume', '继续'], ['cancel', '取消']] : []) actions.append(button(title, async () => { await action(`${prefix(campaign.product_id)}/product-audits/${campaign.id}/actions`, { action: act, version: campaign.version }); await refresh(true); }));
      if (campaign.report) actions.append(button('产品报告', async () => { const report = await api(`${prefix(campaign.product_id)}/product-audits/${campaign.id}/report`); const { article } = modal(campaign.name); article.append(element('pre', 'memory-document', report.markdown)); }));
      card.append(actions); campaignsBody.append(card);
    }
    if (!campaigns.length) campaignsBody.append(element('p', 'muted', '尚未创建产品级批次。'));
  }
  async function showRepo(repo) {
    const productId = state.selectedProductId, payload = await api(`${prefix(productId)}/repos/${repo.id}/snapshots?limit=100`);
    const { article } = modal(`${repo.name} · 版本与差异`);
    if (!payload.items.length) { article.append(element('p', '', '该 Repo 尚无审计快照。')); return; }
    const options = payload.items.map(s => [s.id, `${new Date(s.created_at).toLocaleString()} · ${s.digest.slice(0, 10)} · ${s.summary.file_count ?? '未知'} 文件${s.complete ? '' : ' · 不完整'}`]);
    const before = select(options), after = select(options), kind = select([['files', '文件'], ['interface', '接口'], ['asset', '资产']]); before.selectedIndex = Math.min(1, options.length - 1);
    const output = element('div'); article.append(field('对比基线', before), field('当前版本', after), field('比较内容', kind), button('比较', async () => {
      const result = await action(`${prefix(productId)}/repos/${repo.id}/compare`, { before: before.value, after: after.value, kind: kind.value, limit: 100 });
      output.replaceChildren(element('p', '', `新增 ${result.summary.ADDED} · 减少 ${result.summary.REMOVED} · 变化 ${result.summary.MODIFIED} · 未变化 ${result.summary.UNCHANGED} · 未知 ${result.summary.UNKNOWN}`), element('p', 'muted', result.comparable ? '当前清单可比较。' : '清单范围或完整性不足，未观察到的内容保持未知。'));
      for (const row of result.changes) output.append(element('p', 'mono', `${row.status} · ${row.key}`));
      if (result.total > result.changes.length) output.append(element('p', 'muted', `显示前 ${result.changes.length}/${result.total} 项；完整差异可通过分页接口读取。`));
    }), output);
  }
  async function loadMemory() {
    const productId = state.selectedProductId, generation = local.generation, sequence = ++local.memorySequence;
    const q = new URLSearchParams({ limit: '30', offset: String(local.offset) }); if (repoFilter.value) q.set('repo_id', repoFilter.value); if (kindFilter.value) q.set('kind', kindFilter.value); if (queryInput.value.trim()) q.set('query', queryInput.value.trim());
    const data = await api(`${prefix(productId)}/memory/search?${q}`); if (!valid(productId, generation) || sequence !== local.memorySequence) return;
    memoryBody.replaceChildren(element('p', 'muted', `共 ${data.total} 条 · 当前显示 ${data.items.length} 条`));
    for (const row of data.items) {
      const detail = element('details', 'memory-observation'); detail.append(element('summary', '', `${row.title} · ${row.kind} · ${label(row.trust)}`), element('p', 'mono muted', `${row.repo_id} / ${row.snapshot_id} / ${row.audit_id}`), element('pre', 'memory-document', JSON.stringify({ data: row.data, evidence_refs: row.evidence_refs }, null, 2))); memoryBody.append(detail);
    }
    const prev = button('上一页', () => { local.offset = Math.max(0, local.offset - 30); return loadMemory(); }); prev.disabled = local.offset === 0;
    const next = button('下一页', () => { local.offset += 30; return loadMemory(); }); next.disabled = data.next_offset == null;
    memoryPagination.replaceChildren(prev, next);
  }
  function renderIssues(data) {
    const [grid, body] = table(['问题', '人工判断', '整改状态', '重复关系', '操作']);
    for (const issue of data.items) { const row = element('tr'); row.append(element('td', '', issue.title), element('td', '', label(issue.human_verdict)), element('td', '', label(issue.remediation)), element('td', 'mono', issue.duplicate_of ?? '—')); const actions = element('td'); actions.append(button('历史与判断', async () => { const productId = state.selectedProductId; const value = await api(`${prefix(productId)}/issues/${issue.id}`); if (productId !== state.selectedProductId) return; const { article } = modal(issue.title), content = element('div'); article.append(content); renderIssue(content, value, productId); })); row.append(actions); body.append(row); }
    issuesBody.replaceChildren(element('p', 'muted', `共 ${data.total} 个问题；当前显示 ${data.items.length} 个。`), grid, pager(data, 'issueOffset'));
  }
  function pager(data, key) {
    const bar = element('div', 'memory-toolbar'), prev = button('上一页', () => { local[key] = Math.max(0, local[key] - 30); return refresh(true); }), next = button('下一页', () => { local[key] += 30; return refresh(true); });
    prev.disabled = local[key] === 0; next.disabled = local[key] + data.items.length >= data.total; bar.append(prev, next); return bar;
  }
  function renderTodos(data) {
    todosBody.replaceChildren();
    for (const todo of data.items) {
      const detail = element('details', 'memory-observation'); detail.append(element('summary', '', `${todo.question} · ${label(todo.status)}`), element('p', 'mono', todo.id), element('pre', 'memory-document', JSON.stringify({ requirements: todo.data, answers: todo.answers }, null, 2)));
      const reason = input('reason', '完成、暂缓或重新打开的具体理由'); const actions = element('div', 'memory-toolbar'); actions.append(reason);
      for (const [act, title] of [['resolve', '标记已解决'], ['defer', '留待后续'], ['reopen', '重新打开']]) actions.append(button(title, async () => { await action(`${prefix(state.selectedProductId)}/memory/todos/${todo.id}/actions`, { action: act, version: todo.version, reason: reason.value }); await refresh(true); })); detail.append(actions); todosBody.append(detail);
    }
    if (!data.items.length) todosBody.append(element('p', 'muted', '当前没有产品待办。'));
    todosBody.append(pager(data, 'todoOffset'));
  }
  function renderIssue(container, issue, productId) {
    container.replaceChildren(element('h3', '', '人工判断与跨轮次跟踪'), element('p', 'mono muted', `${issue.id} · ${issue.observations.length} 次观察 · 版本 ${issue.version}`));
    const form = element('form', 'memory-form'), verdict = select(['UNREVIEWED', 'TRUE_POSITIVE', 'FALSE_POSITIVE', 'INSUFFICIENT_EVIDENCE'].map(v => [v, label(v)])), remediation = select(['OPEN', 'FIX_IN_PROGRESS', 'FIX_CLAIMED', 'FIX_VERIFIED', 'REOPENED', 'RISK_ACCEPTED'].map(v => [v, label(v)]));
    verdict.value = issue.human_verdict; remediation.value = issue.remediation;
    const duplicate = input('duplicate', '同一问题的 Issue ID（可选）', issue.duplicate_of ?? ''), reason = element('textarea'); reason.required = true; reason.maxLength = 4000; reason.placeholder = '说明判断依据、有效守卫、成立条件或修复证据。';
    const conditions = input('conditions', '本判断适用的版本、配置或入口条件（可选）');
    const submit = element('button', 'button primary', '保存判断与理由'); submit.type = 'submit'; const error = element('p', 'notice error'); error.hidden = true;
    form.append(field('人工判断', verdict), field('整改状态', remediation), field('重复问题', duplicate), field('适用条件', conditions), field('判断理由（必填）', reason), error, submit);
    form.addEventListener('submit', async event => { event.preventDefault(); submit.disabled = true;
      try { const updated = await action(`${prefix(productId)}/issues/${issue.id}/feedback`, { version: issue.version, human_verdict: verdict.value, remediation: remediation.value, duplicate_of: duplicate.value.trim() || null, reason: reason.value, scope: { kind: 'CURRENT_OBSERVATIONS', conditions: conditions.value } }); renderIssue(container, updated, productId); toast('判断及理由已保存；原审计报告保持封存。'); if (state.view === 'findings') await loadFindingsPage(state.findingPage); else await refresh(true); }
      catch (cause) { error.textContent = cause.message; error.hidden = false; } finally { submit.disabled = false; } }); container.append(form);
    const history = element('details'); history.open = true; history.append(element('summary', '', `反馈历史（${issue.feedback.length}）`));
    for (const event of issue.feedback) history.append(element('p', '', `${new Date(event.created_at).toLocaleString()} · ${event.actor} · ${label(event.data.after.human_verdict)} / ${label(event.data.after.remediation)}：${event.reason}`));
    container.append(history);
    const observations = element('details'); observations.append(element('summary', '', '历次观察与系统结论'));
    for (const o of issue.observations) observations.append(element('p', '', `${o.audit_id} · ${o.snapshot_id} · ${o.data.system_verdict ?? label(o.trust)} · ${o.title}`)); container.append(observations);
    const relations = element('details'); relations.append(element('summary', '', '同一问题、共同根因、同类模式与组合链路'));
    for (const relation of issue.relations) {
      const entry = element('div', 'memory-observation'); entry.append(element('p', '', `${relation.kind} · ${relation.status} · ${relation.from_id} → ${relation.to_id}：${relation.reason}`));
      const rationale = input('relation-reason', '确认或撤销关联的依据'); entry.append(rationale);
      for (const [flag, title] of relation.status === 'CONFIRMED' ? [['revoke', '撤销关联']] : [['confirmed', '确认关联']]) entry.append(button(title, async () => { await action(`${prefix(productId)}/issues/${relation.from_id}/relations`, { to_id: relation.to_id, kind: relation.kind, reason: rationale.value, expected_status: relation.status, [flag]: true }); renderIssue(container, await api(`${prefix(productId)}/issues/${issue.id}`), productId); }));
      relations.append(entry);
    }
    const relationKind = select([['SAME_ISSUE', '同一问题实例'], ['SAME_ROOT_CAUSE', '共同根因'], ['SAME_PATTERN', '同类风险'], ['COMPOSES_WITH', '组成调用链']]), related = input('related-issue', '关联问题的 Issue ID'), relationReason = input('relation-reason', '关系成立的源码、版本与边界依据');
    relations.append(relationKind, related, relationReason, button('登记人工关联', async () => { await action(`${prefix(productId)}/issues/${issue.id}/relations`, { to_id: related.value.trim(), kind: relationKind.value, reason: relationReason.value, confirmed: true }); renderIssue(container, await api(`${prefix(productId)}/issues/${issue.id}`), productId); })); container.append(relations);
    const question = input('todo-question', '例如：寻找可到达该操作的外部入口'), type = select([['FIND_ENTRYPOINT', '寻找入口'], ['CHECK_PATTERN', '检查同类问题'], ['VERIFY_FIX', '验证修复'], ['VERIFY_GUARD', '复查误报依据'], ['COMPLETE_CHAIN', '补全链路']]);
    const todoBar = element('div', 'memory-toolbar'); todoBar.append(type, question, button('创建产品待办', async () => { await action(`${prefix(productId)}/memory/todos`, { origin_repo_id: issue.repo_id, origin_observation_id: issue.observations.at(-1)?.id, type: type.value, question: question.value }); toast('产品待办已保存。'); })); container.append(todoBar);
  }
  async function openFinding(finding) {
    const seq = ++local.findingSequence, container = $('finding-memory'); container.replaceChildren(element('p', 'muted', '正在读取历史问题与人工反馈…'));
    const productId = finding.provenance?.product_id;
    if (!productId) { container.replaceChildren(element('p', 'muted', '该发现尚无可核对的产品归属。')); return; }
    try { const issue = await api(`${prefix(productId)}/findings/${encodeURIComponent(finding.resource_id)}/memory`); if (seq === local.findingSequence && state.selectedFindingResourceId === finding.resource_id) renderIssue(container, issue, productId); }
    catch (error) { if (seq === local.findingSequence) container.replaceChildren(element('p', 'notice', `历史关联暂不可用：${error.message}`)); }
  }
  const timer = setInterval(() => { if (state.view === 'projects' && !document.hidden) refresh().catch(() => {}); }, 7000);
  const destroy = () => { clearInterval(timer); local.generation++; local.findingSequence++; window.removeEventListener?.('pagehide', destroy); };
  window.addEventListener('pagehide', destroy, { once: true });
  return { refresh, openFinding, label, destroy };
}
