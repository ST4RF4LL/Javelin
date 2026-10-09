import { buildAuditTerminalUrl } from './terminal-url.js';
import { normalizeAuditEvents } from '../public/audit-event-adapter.js';
import './audit-monitor.css';

// Keep child windows independent of task-detail mounts, isolated by browser window.
const terminalWindows = new WeakMap();
const STATES = { running: '执行中', pending: '等待中', completed: '工具已完成', error: '错误', failed: '失败', ended: '单步结束', success: '成功' };
const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '—';

// Preserve event selection and scroll state across task/SSE refreshes.
export function replaceAuditSections(panel, sections, pinned) {
  if (pinned?.parentNode === panel) {
    for (const node of [...panel.childNodes]) if (node !== pinned) node.remove();
    for (const section of sections) if (section !== pinned) panel.insertBefore(section, pinned);
  } else panel.replaceChildren(...sections);
}

export function createAuditMonitor({ document, window, audit, renderOriginalEvent, serverUrl = 'http://127.0.0.1:4184/' }) {
  const el = (tag, className = '', text = '') => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const button = (text, action, className = '') => {
    const node = el('button', `monitor-button ${className}`, text); node.type = 'button'; node.addEventListener('click', action); return node;
  };
  let disposed = false, currentView = 'events', terminalUrl = '', terminalKey = '';
  const popupId = `${serverUrl}|${audit.id}`;
  if (!terminalWindows.has(window)) terminalWindows.set(window, new Map());
  const popups = terminalWindows.get(window);
  let following = true, syncingScroll = false, eventError = '', terminalError = '', downloadUrl;
  let lastEventSync = null;
  let records = new Map(), rendered = new Map(), rawItems = new Map();
  const eventViews = new Map(['events', 'original'].map(view => [view, { scrollTop: 0, expanded: new Map() }]));
  const panel = el('section', 'audit-monitor'); panel.dataset.auditId = audit.id;
  const heading = el('header', 'monitor-heading');
  const headingText = el('div'); headingText.append(el('p', 'eyebrow', 'LIVE AUDIT MONITOR'), el('h3', '', '运行监控'));
  const summary = el('span', 'monitor-summary'); heading.append(headingText, summary);
  const toolbar = el('div', 'monitor-toolbar'), tabs = el('div', 'monitor-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '运行监控视图');
  const controls = el('div', 'monitor-actions');
  const indicator = el('span', 'monitor-connection', 'JSON 事件监控'); indicator.setAttribute('role', 'status');
  const openTerminal = button('交互终端 ↗', openTerminalWindow, 'monitor-open-terminal');
  const fallback = el('a', 'monitor-button monitor-popup-fallback', '在新标签页打开终端');
  fallback.target = '_blank'; fallback.rel = 'noopener noreferrer';
  const fullscreen = button('全屏', () => {
    const node = panel.getRootNode();
    const exit = node.fullscreenElement || document.fullscreenElement;
    if (exit) void document.exitFullscreen?.().catch(() => {});
    else void panel.requestFullscreen?.().catch(() => {});
  });
  const download = button('导出当前视图', () => {
    const content = [...records.values()]
      .filter(matches).map(x => `${x.occurred_at || ''} [${x.task_id || '主 Agent'}] ${x.label}\n${x.body || ''}${x.detail ? `\n参数：${x.detail}` : ''}`).join('\n\n');
    if (!content) return;
    if (downloadUrl) window.URL.revokeObjectURL(downloadUrl);
    downloadUrl = window.URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const link = el('a'); link.href = downloadUrl; link.download = `${audit.id}-${currentView}.txt`; link.click();
  });
  controls.append(indicator, openTerminal, fullscreen, download); toolbar.append(tabs, controls);
  const notice = el('p', 'monitor-notice'); notice.hidden = true; notice.setAttribute('role', 'status');
  const eventsPane = el('div', 'monitor-events-pane'); eventsPane.setAttribute('role', 'tabpanel'); eventsPane.setAttribute('aria-label', '任务事件');
  const filters = el('div', 'monitor-filters');
  const tasks = el('select', 'monitor-select'); tasks.setAttribute('aria-label', '按子任务筛选事件');
  const allTasks = el('option', '', '全部 Agent'); allTasks.value = ''; tasks.append(allTasks);
  const search = el('input', 'monitor-search'); search.type = 'search'; search.placeholder = '搜索工具、输出或任务'; search.setAttribute('aria-label', '搜索运行事件');
  const follow = button('跟随最新', () => { following = !following; updateFollow(); if (following) scrollToEnd(); }, 'monitor-follow');
  const count = el('span', 'monitor-event-count'); filters.append(tasks, search, follow, count);
  const viewport = el('div', 'monitor-event-viewport'); viewport.tabIndex = 0; viewport.setAttribute('aria-label', '任务事件列表');
  const empty = el('p', 'monitor-empty', '正在读取任务事件…'); viewport.append(empty);
  const foot = el('p', 'monitor-caption', '当前页面最多保留最近 500 条事件。单步结束或工具完成不代表整个审计完成。');
  eventsPane.append(filters, viewport, foot);
  const updated = el('footer', 'monitor-footer', '等待事件同步');
  panel.append(heading, toolbar, notice, eventsPane, updated);
  const tabButtons = new Map();
  for (const [view, text] of [['events', '任务事件'], ['original', '原始 JSON']]) {
    const tab = button(text, () => setView(view)); tab.setAttribute('role', 'tab'); tab.dataset.view = view;
    tabs.append(tab); tabButtons.set(view, tab);
  }
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const names = [...tabButtons.keys()], i = names.indexOf(currentView);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? names.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length;
    setView(names[index]); tabButtons.get(names[index]).focus();
  });
  function updateFollow() { follow.classList.toggle('is-active', following); follow.setAttribute('aria-pressed', String(following)); follow.textContent = following ? '跟随最新' : '继续跟随'; }
  function scrollToEnd() {
    syncingScroll = true;
    window.requestAnimationFrame(() => { if (!disposed && following) viewport.scrollTop = viewport.scrollHeight; window.requestAnimationFrame(() => { syncingScroll = false; }); });
  }
  viewport.addEventListener('scroll', () => {
    if (syncingScroll) return;
    if (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 60) { following = false; updateFollow(); }
  });
  function matches(item) {
    const task = item.task_id || '__main__', needle = search.value.trim().toLowerCase();
    return (!tasks.value || task === tasks.value) && (!needle || [item.task_id, item.label, item.tool, item.body, item.detail].join(' ').toLowerCase().includes(needle));
  }
  function eventNode(item) {
    if (currentView === 'original' && renderOriginalEvent) {
      // Reasoning is an activity marker, including in the fallback display.
      return renderOriginalEvent(item.kind === 'reasoning' || item.content_omitted ? { ...item, body: '推理活动（正文不展示）', detail: '' } : rawItems.get(item.event_key) || item, true);
    }
    const card = el('article', `monitor-event monitor-${item.kind || 'raw'}`); card.dataset.eventKey = item.event_key;
    const head = el('header', 'monitor-event-head');
    head.append(el('time', '', time(item.occurred_at)), el('span', 'monitor-agent', item.task_id || '主 Agent'), el('strong', '', item.label || '运行输出'));
    if (item.status) head.append(el('span', `monitor-event-state is-${item.status}`, STATES[item.status] || item.status));
    card.append(head);
    if (item.body) card.append(el('pre', 'monitor-event-output', item.body));
    if (item.detail) { const details = el('details', 'monitor-event-detail'); details.append(el('summary', '', '调用参数'), el('pre', '', item.detail)); card.append(details); }
    if (!item.body && !item.detail && item.kind === 'reasoning') card.append(el('p', 'monitor-event-meta', 'Agent 正在处理上下文'));
    return card;
  }
  function saveEventView(view) {
    const state = eventViews.get(view);
    if (!state) return;
    state.scrollTop = viewport.scrollTop;
    state.expanded.clear();
    for (const [key, node] of rendered) {
      const open = [...node.querySelectorAll('details')].flatMap((details, index) => details.open ? [index] : []);
      if (open.length) state.expanded.set(key, new Set(open));
    }
  }
  function drawEvents(reset = false) {
    if (disposed) return;
    const saved = eventViews.get(currentView);
    const scroll = reset ? saved?.scrollTop ?? 0 : viewport.scrollTop;
    if (reset) { rendered.clear(); viewport.replaceChildren(empty); }
    let visible = 0;
    for (const [key, item] of records) {
      let node = rendered.get(key);
      if (!node) {
        node = eventNode(item);
        const expanded = saved?.expanded.get(key);
        if (expanded) [...node.querySelectorAll('details')].forEach((details, index) => { details.open = expanded.has(index); });
        rendered.set(key, node); viewport.append(node);
      }
      node.hidden = !matches(item); if (!node.hidden) visible++;
    }
    for (const [key, node] of rendered) if (!records.has(key)) { node.remove(); rendered.delete(key); }
    empty.hidden = visible > 0; empty.textContent = records.size ? '没有匹配的事件。' : '当前没有可显示的事件。';
    count.textContent = `${visible} / ${records.size} 条`;
    if (following) scrollToEnd(); else viewport.scrollTop = scroll;
  }
  tasks.addEventListener('change', () => drawEvents()); search.addEventListener('input', () => drawEvents());
  function updateNotice() {
    const messages = [terminalError, eventError && `事件更新失败：${eventError}。已保留上次结果。`].filter(Boolean);
    notice.textContent = messages.join(' '); notice.hidden = !messages.length;
    if (terminalError && terminalUrl) { fallback.href = terminalUrl; notice.append(fallback); }
  }
  function openTerminalWindow() {
    if (disposed || !terminalUrl || openTerminal.disabled) return;
    terminalError = '';
    // Prune closed windows without closing any still-active attachment.
    for (const [id, entry] of popups) if (entry.child.closed) popups.delete(id);
    try {
      let entry = popups.get(popupId);
      if (!entry) {
        // Open synchronously in the user gesture, then detach reverse opener access.
        const child = window.open('', '_blank', 'popup=yes,width=1280,height=820,resizable=yes,scrollbars=yes');
        if (!child) throw new Error('popup-blocked');
        child.opener = null;
        entry = { child, key: '' }; popups.set(popupId, entry);
      }
      if (entry.key !== terminalKey) { entry.child.location.replace(terminalUrl); entry.key = terminalKey; }
      entry.child.focus();
    } catch {
      terminalError = '未能打开终端子窗口，请允许此站点弹出窗口，或使用下方链接。任务和事件监控继续运行。';
    }
    updateNotice();
  }
  function setView(view) {
    const changed = currentView !== view;
    if (changed) saveEventView(currentView);
    currentView = view;
    panel.dataset.view = view;
    for (const [key, tab] of tabButtons) { tab.setAttribute('aria-selected', String(view === key)); tab.tabIndex = view === key ? 0 : -1; }
    if (changed) drawEvents(true);
    updateNotice();
  }
  function setAudit(next) {
    if (disposed) return;
    const board = next.task_board;
    summary.textContent = board ? `已交付 ${board.reported ?? board.done ?? 0} / ${board.total ?? 0} · 运行 ${board.running ?? 0} · 待执行 ${board.pending ?? 0}` : '';
    const source = next.terminal;
    const shared = source?.shared_server === true;
    const active = source?.live && next.status === 'running';
    const key = active && shared ? `${serverUrl}|opencode:${next.id}|${source.server_generation || next.provider_session_id || ''}` : '';
    if (key !== terminalKey) terminalError = '';
    terminalKey = key; terminalUrl = '';
    if (key) {
      try { terminalUrl = buildAuditTerminalUrl({ serverUrl, auditId: next.id, generation: shared ? source.server_generation : undefined }); }
      catch { terminalError = '终端连接地址无效，请检查终端服务配置。'; }
    }
    openTerminal.disabled = !terminalUrl;
    openTerminal.textContent = '交互终端 ↗';
    openTerminal.title = !terminalUrl
      ? '此任务没有运行中的终端。暂停或中断的任务请先恢复。'
      : shared ? '在独立子窗口连接此任务的同一 OpenCode 会话；关闭窗口后任务继续运行。'
      : '在独立子窗口查看旧任务的原始输出；此连接只读。';
    indicator.textContent = key ? 'JSON 事件监控' : next.status === 'paused' ? '任务已暂停' : '终端已归档';
    updateNotice();
  }
  function syncedFooter() {
    updated.textContent = lastEventSync ? `事件同步于 ${time(lastEventSync)} · JSON 事件监控 · 任务状态以工作包交付为准` : '事件已连接 · 等待首次同步';
  }
  function setEvents(items) {
    if (disposed) return;
    eventError = '';
    const normalized = normalizeAuditEvents(items);
    normalized.forEach((item, i) => { records.set(item.event_key, item); rawItems.set(item.event_key, items[i]); });
    while (records.size > 500) {
      const key = records.keys().next().value; records.delete(key); rawItems.delete(key);
      for (const state of eventViews.values()) state.expanded.delete(key);
    }
    const selection = tasks.value, taskIds = [...new Set([...records.values()].map(x => x.task_id || '__main__'))];
    tasks.replaceChildren(allTasks);
    for (const id of taskIds) { const option = el('option', '', id === '__main__' ? '主 Agent' : id); option.value = id; tasks.append(option); }
    tasks.value = taskIds.includes(selection) ? selection : '';
    lastEventSync = new Date().toISOString(); syncedFooter();
    drawEvents(); updateNotice();
  }
  updateFollow(); setView('events'); setAudit(audit);
  return { element: panel, auditId: audit.id, setAudit, setEvents,
    setEventsError(message) { if (!disposed) { eventError = message; updateNotice(); } },
    setConnection(value) {
      if (disposed) return;
      if (value === 'reconnecting') updated.textContent = '事件连接正在重连 · 保留上次结果';
      else if (value === 'connected') syncedFooter();
    },
    destroy() { if (disposed) return; disposed = true; records.clear(); rendered.clear(); rawItems.clear(); eventViews.clear(); if (downloadUrl) window.URL.revokeObjectURL(downloadUrl); },
  };
}
