export function normalizeModernOrigin(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error("新版工作台地址必须是 HTTP(S) origin。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("新版工作台地址必须是不含路径、凭据和查询参数的 HTTP(S) origin。");
  }
  return url.origin;
}

export function createWorkbenchUiHandler(origin) {
  const modernOrigin = normalizeModernOrigin(origin);
  return (request, response, url) => {
    if (request.method !== "GET") return false;
    if (url.pathname === "/api/v1/workbench-ui") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ modernUrl: modernOrigin ? "/workbench" : null }));
      return true;
    }
    if (url.pathname === "/workbench" && modernOrigin) {
      response.writeHead(302, { Location: `${modernOrigin}/`, "Cache-Control": "no-store" });
      response.end();
      return true;
    }
    return false;
  };
}
