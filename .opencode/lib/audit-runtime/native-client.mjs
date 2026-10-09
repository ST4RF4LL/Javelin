import { ensureAuditService, readServiceConnection } from './service-process.mjs';

export function createNativeClient({ serviceRoot, fetcher = fetch, connection: suppliedConnection } = {}) {
  let connection = suppliedConnection;
  return {
    async call(operation, input) {
      if (!['register', 'heartbeat'].includes(operation)) throw new Error('会话服务操作无效。');
      if (!connection) {
        try { connection = await readServiceConnection(serviceRoot); }
        catch { await ensureAuditService({ serviceRoot }); connection = await readServiceConnection(serviceRoot); }
      }
      let response;
      try {
        response = await fetcher(`${connection.origin}/api/internal/agent-sessions/${operation}`, {
          method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(input), signal: AbortSignal.timeout(operation === 'register' ? 120_000 : 15_000), redirect: 'error',
        });
      } catch (error) {
        const origin = connection.origin; connection = null;
        if (!suppliedConnection && (error.cause?.code ?? error.code) === 'ECONNREFUSED') await ensureAuditService({ origin, serviceRoot });
        throw error;
      }
      const result = await response.json();
      if (!response.ok) { if (response.status === 403) connection = null; throw Object.assign(new Error(result.message || result.error || `会话服务请求失败：${response.status}`), { code: result.error, statusCode: response.status }); }
      return result;
    },
  };
}
