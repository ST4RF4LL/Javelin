const messagePattern = /^(?:Error:\s*)?The operation timed out\.?$/i;

// Inspect provider error envelopes, never text/tool payloads quoting an error.
export function operationTimeout(value) {
  if (typeof value === 'string') {
    const line = value.replace(/\u001b\[[0-9;]*m/g, '').trim();
    try { value = JSON.parse(line); }
    catch { return messagePattern.test(line) ? { message: 'The operation timed out.' } : null; }
  }
  if (!value || typeof value !== 'object') return null;
  const event = value.type === 'session.error' ? value.properties : value;
  const error = value.type === 'session.error' || value.type === 'error' ? event?.error
    : !value.type && typeof value.name === 'string' ? value : null;
  const message = error?.data?.message ?? error?.message;
  if (typeof message !== 'string' || !messagePattern.test(message.trim())) return null;
  return { message: 'The operation timed out.', session_id: event?.sessionID ?? event?.session_id ?? null };
}

export function timeoutRecoveryPolicy(environment = {}) {
  const integer = (value, fallback, minimum, maximum) => {
    if (value == null || value === '') return fallback;
    const number = Number(value);
    return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
  };
  return { limit: integer(environment.AUDIT_TIMEOUT_MAX_RECOVERIES, 20, 0, 100),
    delay_ms: integer(environment.AUDIT_TIMEOUT_RETRY_DELAY_MS, 10_000, 0, 300_000) };
}

export const timeoutRetryDelay = (_attempt, policy) => policy.delay_ms;
export function waitForTimeoutRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('任务已停止。'));
    const abort = () => { clearTimeout(timer); reject(new Error('任务已停止。')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
