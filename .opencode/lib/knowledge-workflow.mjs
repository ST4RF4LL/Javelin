import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
export const platformRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bridge = fileURLToPath(new URL("./knowledge-workflow.py", import.meta.url));
const TRACKS = new Set(["coverage", "seeded-variant", "threat-model", "review", "blind"]);
const KINDS = new Set(["mechanism", "case", "rule", "detector", "weakness", "technique", "security-impact", "attack-surface", "type", "any"]);
const FILTERS = new Set(["weakness", "technique", "impact", "surface", "product", "technology", "engine", "status", "confidence", "rule_scope", "validation", "generalization"]);

export function knowledgeEnvironment(root = platformRoot, environment = process.env) {
  return {
    AUDIT_KNOWLEDGE_ROOT: resolve(root, environment.AUDIT_KNOWLEDGE_ROOT?.trim() || "../KnowledgeWorkFlow"),
    AUDIT_KNOWLEDGE_CLI: join(root, ".opencode", "scripts", "knowledge-query.mjs"),
  };
}

export function parseKnowledgeArgs(args) {
  const [command = "status", ...rest] = args;
  if (["--help", "-h"].includes(command)) return { help: true };
  const request = { command, filters: {}, limit: 5, offset: 0, kind: "mechanism", mode: "auto" };
  const seen = new Set();
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index]; const value = rest[index + 1];
    if (!/^--[a-z-]+$/.test(option) || !value || value.includes("\0")) throw new Error("查询参数无效。");
    const key = option.slice(2);
    if (key !== "filter" && seen.has(key)) throw new Error(`查询参数重复：${option}`);
    seen.add(key);
    if (key === "filter") {
      const split = value.indexOf("="); const field = value.slice(0, split); const term = value.slice(split + 1);
      if (split < 1 || !FILTERS.has(field) || !term || term.length > 256) throw new Error("筛选条件须为支持的 field=value。");
      (request.filters[field] ??= []).push(term);
    } else if (["root", "track", "query", "id", "kind", "mode"].includes(key)) request[key] = value;
    else if (["limit", "offset"].includes(key)) request[key] = Number(value);
    else throw new Error(`不支持的查询参数：${option}`);
  }
  if (!["status", "search", "show"].includes(command)) throw new Error("仅支持 status、search、show 只读操作。");
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 10 || !Number.isInteger(request.offset) || request.offset < 0 || request.offset > 100000) throw new Error("分页须为 limit=1–10、offset=0–100000。");
  if (!KINDS.has(request.kind) || !["auto", "exact", "keyword", "filter"].includes(request.mode)) throw new Error("检索集合或模式无效。");
  if (request.track && !TRACKS.has(request.track)) throw new Error("发现轨道无效。");
  if (command !== "status" && !request.track) throw new Error("检索须显式指定 --track；blind 轨道不加载知识种子。");
  if (command === "search" && request.mode !== "filter" && !request.query?.trim()) throw new Error("检索词不能为空；浏览集合使用 --mode filter。");
  if (command === "show" && !request.id?.trim()) throw new Error("详情查询须指定 --id。");
  if ((request.query?.length ?? 0) > 512 || (request.id?.length ?? 0) > 200) throw new Error("检索词或 ID 过长。");
  return request;
}

export async function queryKnowledge(request, { environment = process.env, execute = executeFile, host = process.platform } = {}) {
  const base = { schema_version: "audit-knowledge-query.v1", read_only: true, automatic_vulnerability_verdict: false };
  if (request.track === "blind" || environment.AUDIT_MEMORY_MODE === "blind") return { ...base, status: "SKIPPED", reason: "盲测轨道不加载知识库、历史案例或根因种子。" };
  if (environment.AUDIT_KNOWLEDGE_ENABLED === "false") return { ...base, status: "SKIPPED", reason: "知识库对接已关闭。" };
  const root = resolve(platformRoot, request.root || knowledgeEnvironment(platformRoot, environment).AUDIT_KNOWLEDGE_ROOT);
  try {
    await Promise.all(["src/knowledge_factory/kb_index.py", "knowledge/catalog/quality/mechanisms", "knowledge/detectors"].map(path => access(join(root, path))));
  } catch {
    return { ...base, status: "UNAVAILABLE", root, reason: "未找到新版知识库，请配置 AUDIT_KNOWLEDGE_ROOT；保留知识检索缺口并继续源码审计。" };
  }
  let python = environment.AUDIT_KNOWLEDGE_PYTHON;
  if (!python) {
    const local = join(root, ".venv", host === "win32" ? "Scripts/python.exe" : "bin/python");
    try { await access(local); python = local; } catch { python = host === "win32" ? "python" : "python3"; }
  }
  try {
    const { root: _root, ...query } = request;
    // No shell, server, target execution, bytecode cache, or dependency install.
    const result = await execute(python, ["-I", "-B", bridge, root, JSON.stringify(query)], {
      cwd: platformRoot, env: environment, shell: false, windowsHide: true,
      encoding: "utf8", timeout: 90000, maxBuffer: 1024 * 1024,
    });
    const response = JSON.parse(result.stdout);
    if (response.schema_version !== base.schema_version || response.read_only !== true
      || response.automatic_vulnerability_verdict !== false || !["READY", "PARTIAL", "STALE", "NOT_FOUND", "UNAVAILABLE"].includes(response.status)) throw new Error("bridge-response-invalid");
    return response;
  } catch {
    return { ...base, status: "UNAVAILABLE", root, reason: "知识检索器不可用、超时或版本不兼容。检查 Python、PyYAML 和知识库版本；不自动安装依赖，不将检索失败解释为没有风险。" };
  }
}
