export function buildAuditTerminalUrl({ serverUrl, auditId, generation }) {
  const url = new URL(serverUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    !/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(auditId ?? '')) throw new TypeError('终端连接地址无效。');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/audits/${encodeURIComponent(auditId)}/`;
  url.search = ''; url.hash = '';
  if (generation) url.searchParams.set('generation', generation);
  return url.href;
}
