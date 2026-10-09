import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { lookup as dnsLookup } from "node:dns";
import { check, httpUrl } from "./contract.mjs";

const READ = new Set(["list_pages", "select_page", "take_snapshot", "list_console_messages", "get_console_message", "list_network_requests", "get_network_request"]);
const NAVIGATE = new Set(["navigate_page", "new_page", "close_page"]);
const INTERACT = new Set(["click", "fill", "fill_form", "press_key", "hover", "handle_dialog"]);
const FORBIDDEN_ARGUMENTS = new Set(["initScript", "filePath", "file_path", "requestFilePath", "responseFilePath"]);

function controllerTool(tool, identities) {
  const schema = tool.inputSchema ?? { type: "object" };
  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([key]) => !FORBIDDEN_ARGUMENTS.has(key)));
  const required = (schema.required ?? []).filter(key => !FORBIDDEN_ARGUMENTS.has(key));
  // The headless controller has no user-selected Network panel request.
  // Require the actual reqid returned by list_network_requests instead.
  if (tool.name === "get_network_request") required.push("reqid");
  return { ...tool, inputSchema: { ...schema, properties: { ...properties, identity_id: { type: "string", enum: identities } },
    required: [...new Set([...required, "identity_id"])] } };
}

function browserResult(name, result) {
  // MCP 1.8.0 catches navigation failures inside its handler and returns a
  // regular response. Preserve the diagnostic but do not count it as success.
  if (name === "navigate_page" && /^Unable to (?:navigate(?: back| forward)? in the selected page|reload the selected page):/m.test(result?.structuredContent?.message ?? "")) {
    return { ...result, isError: true };
  }
  // Page titles/text are untrusted and cannot replace typed navigation evidence.
  // MCP 1.8.0 makes structuredContent opt-in; detect a launch/config regression
  // at the browser boundary instead of silently rejecting CONTACT later.
  if (["new_page", "navigate_page", "list_pages"].includes(name) && !result?.isError
    && !Array.isArray(result?.structuredContent?.pages)) {
    return { ...result, isError: true, error: { code: "BROWSER_STRUCTURED_OUTPUT_MISSING",
      message: "浏览器未返回结构化页面记录，平台无法确认访问结果；请检查 Chrome DevTools MCP 的结构化输出配置。" } };
  }
  return result;
}

export function targetLookup(hostname, options, callback) {
  if (hostname.toLowerCase() !== "localhost") return dnsLookup(hostname, options, callback);
  // Node's automatic family selection requests an array when options.all is true.
  if (options?.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
  else callback(null, "127.0.0.1", 4);
}

export function authorizedConnectTarget(authority, origins) {
  if (typeof authority !== "string") return null;
  const url = httpUrl(`https://${authority}`);
  if (!url || !origins.includes(url.origin)) return null;
  const port = Number(url.port || 443);
  // URL.host omits :443; CONNECT carries an explicit port even for that default.
  if (authority.toLowerCase() !== `${url.hostname}:${port}`) return null;
  return { host: url.hostname === "localhost" ? "127.0.0.1" : url.hostname.replace(/^\[|\]$/g, ""), port };
}

// Chromium must send even loopback requests through this exact-origin gate.
// Redirects/subresources outside the operator-authorized origins are rejected.
export async function createOriginProxy(origins) {
  const allowed = new Set(origins); const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); return socket; };
  const permitted = value => { const url = httpUrl(value); return url && allowed.has(url.origin) ? url : null; };
  const server = http.createServer((request, response) => {
    const url = permitted(request.url);
    if (!url) { response.writeHead(403).end("Origin not authorized"); return; }
    const headers = { ...request.headers, host: url.host }; delete headers["proxy-authorization"]; delete headers["proxy-connection"];
    const upstream = (url.protocol === "https:" ? https : http).request(url, { method: request.method, headers,
      lookup: targetLookup }, reply => {
      response.writeHead(reply.statusCode, reply.headers); reply.pipe(response);
    });
    upstream.on("socket", track); upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on("aborted", () => upstream.destroy()); response.on("close", () => upstream.destroy()); request.pipe(upstream);
  });
  server.on("connection", track);
  server.on("connect", (request, client, head) => {
    const target = authorizedConnectTarget(request.url, origins);
    if (!target) { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const upstream = track(net.connect(target, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    }));
    upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy()); client.on("close", () => upstream.destroy());
  });
  server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let closing;
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => closing ??= (async () => {
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  })() };
}

export class ChromeRuntimeBrowser {
  constructor(authorization, { clientFactory = null } = {}) {
    this.authorization = authorization; this.sessions = new Map(); this.startingClients = new Set(); this.proxy = null; this.clientFactory = clientFactory; this.closed = false;
    this.sessionStarts = new Map(); this.clientClosures = new WeakMap();
  }
  async session(id) {
    check(!this.closed && this.authorization.identities.some(identity => identity.id === id), "browser-identity-invalid");
    if (this.sessions.has(id)) return this.sessions.get(id);
    if (!this.sessionStarts.has(id)) this.sessionStarts.set(id, this.createSession(id));
    return this.sessionStarts.get(id);
  }
  closeClient(client) {
    if (!this.clientClosures.has(client)) this.clientClosures.set(client, Promise.resolve().then(() => client.close()));
    return this.clientClosures.get(client);
  }
  async createSession(id) {
    this.proxyPromise ??= createOriginProxy(this.authorization.origins);
    this.proxy = await this.proxyPromise;
    if (this.closed) { await this.proxy.close(); throw new Error("runtime-browser-closed-during-startup"); }
    const client = this.clientFactory ? await this.clientFactory(id) : new Client({ name: "runtime-testing-controller", version: "1.0.0" });
    if (this.closed) { await this.closeClient(client); throw new Error("runtime-browser-closed-during-startup"); }
    this.startingClients.add(client);
    if (!this.clientFactory) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => typeof value === "string" && !/(proxy|AUDIT_.*TOKEN|AUDIT_TEST_ENVIRONMENT)/i.test(key)));
      const transport = new StdioClientTransport({ command: process.platform === "win32" ? "npx.cmd" : "npx", args: ["--yes", "chrome-devtools-mcp@1.8.0",
        "--isolated=true", "--headless=true", "--experimental-structured-content=true", "--redact-network-headers=true", "--no-usage-statistics", "--no-performance-crux",
        `--chrome-arg=--proxy-server=${this.proxy.url}`, "--chrome-arg=--proxy-bypass-list=<-loopback>",
        "--chrome-arg=--disable-quic", "--chrome-arg=--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--chrome-arg=--disable-background-networking"], env, stderr: "ignore" });
      try { await client.connect(transport); } catch (error) { this.startingClients.delete(client); await this.closeClient(client).catch(() => {}); await transport.close().catch(() => {}); throw error; }
    }
    let tools;
    try {
      check(!this.closed, "runtime-browser-closed-during-startup");
      tools = (await client.listTools()).tools;
    } catch (error) { this.startingClients.delete(client); await this.closeClient(client).catch(() => {}); throw error; }
    this.startingClients.delete(client);
    if (this.closed) { await this.closeClient(client); throw new Error("runtime-browser-closed-during-startup"); }
    const session = { client, tools }; this.sessions.set(id, session); return session;
  }
  allowed(name, packet) {
    return READ.has(name) || NAVIGATE.has(name) && packet.actions.includes("navigate")
      || INTERACT.has(name) && packet.actions.some(action => ["normal_interaction", "test_input", "test_mutation"].includes(action));
  }
  async tools(packet) {
    const session = await this.session(packet.identity_ids[0]);
    return session.tools.filter(tool => this.allowed(tool.name, packet)).map(tool => controllerTool(tool, packet.identity_ids));
  }
  async call(name, args, packet) {
    check(this.allowed(name, packet) && packet.identity_ids.includes(args.identity_id), "browser-tool-not-authorized");
    if (args.url != null) check(httpUrl(args.url) && this.authorization.origins.includes(new URL(args.url).origin), "browser-origin-not-authorized");
    // No arbitrary JS, raw CDP, file uploads/downloads, request interception, or global browser reset.
    check(!Object.keys(args).some(key => FORBIDDEN_ARGUMENTS.has(key)), "browser-script-or-file-operation-not-authorized");
    if (name === "get_network_request") check(Number.isInteger(args.reqid) && args.reqid > 0, "browser-network-request-id-required");
    const session = await this.session(args.identity_id); const { identity_id, ...arguments_ } = args;
    check(!this.closed, "runtime-browser-closed");
    const tool = session.tools.find(tool => tool.name === name);
    if (tool?.inputSchema?.required?.includes("pageId")) check(Number.isInteger(args.pageId) && args.pageId >= 0, "browser-page-id-required");
    return browserResult(name, await session.client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 45_000 }));
  }
  async close() {
    this.closing ??= this.closeOnce();
    return this.closing;
  }
  async closeOnce() {
    this.closed = true; const clients = new Set([...this.sessions.values()].map(session => session.client).concat([...this.startingClients]));
    const results = await Promise.allSettled([...clients].map(async client => {
      // This client owns an isolated browser; closing its MCP transport terminates only that owned session.
      await this.closeClient(client);
    }));
    if (this.proxyPromise) await this.proxyPromise.then(proxy => proxy.close(), () => {});
    this.sessions.clear();
    check(results.every(result => result.status === "fulfilled"), "browser-owned-session-close-failed");
  }
}
