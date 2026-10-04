import { request } from 'node:http';
import { duplexPair } from 'node:stream';

// 使用真正的 Node HTTP 编解码、连接池和请求流；连接只存在于测试进程内。
// 不绑定端口，不访问任何本机或远程服务。
export function memoryHttpRequester(server) {
  return (url, options, callback) => {
    options.agent.createConnection = () => {
      const [client, peer] = duplexPair();
      for (const socket of [client, peer]) {
        for (const method of ['setTimeout', 'setNoDelay', 'setKeepAlive', 'ref', 'unref']) socket[method] = () => socket;
        socket.remoteAddress = '127.0.0.1';
      }
      server.emit('connection', peer);
      return client;
    };
    return request(url, options, callback);
  };
}
