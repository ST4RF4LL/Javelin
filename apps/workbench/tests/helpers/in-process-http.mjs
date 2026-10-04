import { PassThrough, Readable, Writable } from 'node:stream';

// 仅替换 socket；HTTP 请求/响应、原路由和新版流读取均使用实际代码。
export function inProcessRequester(handler, observe = () => {}) {
  return (url, config, callback) => {
    observe(url, config);
    const chunks = []; const incoming = new PassThrough(); let request; let headersSent = false;
    incoming.statusCode = 200; incoming.headers = {};
    const sendHeaders = () => { if (!headersSent) { headersSent = true; callback(incoming); } };
    incoming.setHeader = (key, value) => { incoming.headers[key.toLowerCase()] = String(value); };
    incoming.writeHead = (status, headers) => {
      incoming.statusCode = status;
      for (const [key, value] of Object.entries(headers || {})) incoming.setHeader(key, value);
      sendHeaders(); return incoming;
    };
    const end = incoming.end;
    incoming.end = (...args) => { sendHeaders(); return end.apply(incoming, args); };
    incoming.once('error', () => {});
    const outgoing = new Writable({
      autoDestroy: false,
      write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); },
      final(done) {
        done();
        request = Readable.from(chunks);
        request.method = config.method; request.url = url.pathname + url.search;
        request.headers = { host: url.host, ...config.headers };
        Promise.resolve().then(() => handler(request, incoming)).catch(error => { incoming.destroy(error); outgoing.destroy(error); });
      },
    });
    const abort = () => {
      const error = Object.assign(new Error('Request aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
      incoming.destroy(error); request?.destroy(); outgoing.destroy(error);
    };
    config.signal?.addEventListener('abort', abort, { once: true });
    incoming.once('close', () => config.signal?.removeEventListener('abort', abort));
    if (config.signal?.aborted) queueMicrotask(abort);
    return outgoing;
  };
}
