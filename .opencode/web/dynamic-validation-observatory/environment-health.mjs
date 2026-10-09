import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { arch, homedir, platform as osPlatform } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { resolveExecutablePath, resolvedOpenCodeExecutables } from "./executable-resolution.mjs";

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 30_000;
const VERSION_TIMEOUT_MS = 8_000;

function oneLine(value) {
  return String(value ?? "").split(/\r?\n/).map(line => line.trim()).find(Boolean)?.slice(0, 240) ?? null;
}

async function probeExecutable({ id, label, category, command, args = ["--version"], requiredFor = [], environment, platform, execute, resolveCommand = resolveExecutablePath }) {
  const resolved = await resolveCommand(command, environment, platform);
  if (!resolved) {
    return { id, label, category, status: "unavailable", version: null, command: basename(command || id), required_for: requiredFor, detail: "未找到可执行文件。" };
  }
  let version = null;
  let detail = "可执行文件已就绪。";
  if (args === null) return { id, label, category, status: "ready", version, command: basename(resolved), required_for: requiredFor, detail };
  try {
    const result = await execute(resolved, args, { encoding: "utf8", timeout: VERSION_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: environment, windowsHide: true });
    version = oneLine(result.stdout) ?? oneLine(result.stderr);
  } catch (error) {
    version = oneLine(error.stdout) ?? oneLine(error.stderr);
    detail = version ? "可执行文件已就绪；版本命令返回非零状态。" : "可执行文件已就绪；未能读取版本信息。";
  }
  return { id, label, category, status: "ready", version, command: basename(resolved), required_for: requiredFor, detail };
}

async function readPackageComponent(projectRoot) {
  try {
    const manifest = JSON.parse(await readFile(join(projectRoot, ".opencode", "node_modules", "@modelcontextprotocol", "sdk", "package.json"), "utf8"));
    return { id: "project_dependencies", label: "项目 Node.js 依赖", category: "基础运行时", status: "ready", version: manifest.version ?? null, command: "npm ci --prefix .opencode", required_for: ["workbench", "static", "dynamic"], detail: "MCP SDK 等项目依赖已安装。" };
  } catch {
    return { id: "project_dependencies", label: "项目 Node.js 依赖", category: "基础运行时", status: "unavailable", version: null, command: "npm ci --prefix .opencode", required_for: ["workbench", "static", "dynamic"], detail: "依赖不完整，请执行 npm ci --prefix .opencode。" };
  }
}

async function inspectMcpConfiguration(configPaths) {
  const states = { chrome_devtools: false, valid_configs: 0, invalid_configs: 0 };
  for (const path of [...new Set(configPaths.filter(Boolean))]) {
    try {
      const config = JSON.parse(await readFile(path, "utf8"));
      states.valid_configs += 1;
      states.chrome_devtools ||= config.mcp?.["chrome-devtools"]?.enabled === true && Array.isArray(config.mcp["chrome-devtools"].command);
    } catch {
      states.invalid_configs += 1;
    }
  }
  return states;
}

async function chromeComponent({ environment, platform, execute, resolveCommand }) {
  const commands = platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", join(homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome")]
    : platform === "win32"
      ? [
          join(environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Google", "Chrome", "Application", "chrome.exe"),
          join(environment.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
          join(environment["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
        ]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const command of commands) {
    if (platform === "win32" || platform === "darwin") {
      const resolved = await resolveCommand(command, environment, platform);
      if (resolved) {
        return { id: "chrome", label: "Google Chrome", category: "动态验证", status: "ready", version: null, command: basename(resolved), required_for: ["dynamic"], detail: "已检测到 Chrome；不会为读取版本而启动浏览器进程。" };
      }
      continue;
    }
    const result = await probeExecutable({ id: "chrome", label: "Google Chrome", category: "动态验证", command, requiredFor: ["dynamic"], environment, platform, execute, resolveCommand });
    if (result.status === "ready") return result;
  }
  return { id: "chrome", label: "Google Chrome", category: "动态验证", status: "unavailable", version: null, command: "google-chrome", required_for: ["dynamic"], detail: "未找到可见 Chrome；静态审计不受影响。" };
}

async function terminalComponent({ environment, platform, execute, resolveCommand }) {
  return probeExecutable({ id: "ttyd", label: "ttyd Web 终端", category: "交互终端", command: environment.WORKBENCH_TTYD_BIN || "ttyd",
    requiredFor: ["terminal_monitor"], environment, platform, execute, resolveCommand });
}

async function openCodeComponent({ environment, platform, architecture, execute, resolveCommand }) {
  const commands = await resolvedOpenCodeExecutables({ command: environment.OPENCODE_BIN_PATH ?? environment.OPENCODE_BIN, environment, platform, architecture, resolveCommand });
  if (!commands.length) {
    return { id: "opencode", label: "OpenCode CLI", category: "Agent 运行时", status: "unavailable", version: null, command: platform === "win32" ? "opencode.exe" : "opencode", required_for: ["static", "dynamic"], detail: platform === "win32" ? "未找到可直接执行的 opencode.exe；可设置 OPENCODE_BIN_PATH。" : "未找到可执行文件。" };
  }
  return probeExecutable({ id: "opencode", label: "OpenCode CLI", category: "Agent 运行时", command: commands[0], requiredFor: ["static", "dynamic"], environment, platform, execute, resolveCommand: async value => value });
}

function configuredComponent(id, label, category, configured, requiredFor, detail) {
  return {
    id,
    label,
    category,
    status: configured ? "ready" : "unavailable",
    version: null,
    command: "opencode.json",
    required_for: requiredFor,
    detail: configured ? detail : "已登记仓库中未发现有效的启用配置。",
  };
}

function capability(id, label, componentIds, components, { anyOf = [], optional = false } = {}) {
  const byId = new Map(components.map(component => [component.id, component]));
  const missing = componentIds.filter(componentId => byId.get(componentId)?.status !== "ready");
  if (anyOf.length && !anyOf.some(componentId => byId.get(componentId)?.status === "ready")) missing.push(anyOf.join(" / "));
  return {
    id,
    label,
    status: missing.length ? (optional ? "skipped" : "blocked") : "ready",
    blockers: [...new Set(missing)],
    summary: missing.length ? (optional ? `缺少 ${[...new Set(missing)].length} 项可选组件，当前能力已跳过。` : `缺少 ${[...new Set(missing)].length} 项必要能力。`) : "必要组件均已就绪。",
  };
}

export class EnvironmentHealthService {
  constructor({ projectRoot, configPaths = [], environment = process.env, platform = osPlatform(), architecture = arch(), nodeVersion = process.versions.node, execute = execFileAsync, resolveCommand = resolveExecutablePath, cacheTtlMs = CACHE_TTL_MS } = {}) {
    this.projectRoot = projectRoot;
    this.configPaths = configPaths;
    this.environment = environment;
    this.platform = platform;
    this.architecture = architecture;
    this.nodeVersion = nodeVersion;
    this.execute = execute;
    this.resolveCommand = resolveCommand;
    this.cacheTtlMs = cacheTtlMs;
    this.cached = null;
    this.pending = null;
  }

  async snapshot({ force = false } = {}) {
    if (!force && this.cached && Date.now() - this.cached.generated_at_ms < this.cacheTtlMs) return this.cached.value;
    // A forced refresh bypasses the cache, but must not duplicate an in-flight probe batch.
    if (this.pending) return this.pending;
    this.pending = this.build().finally(() => { this.pending = null; });
    return this.pending;
  }

  async build() {
    const environment = this.environment;
    const platform = this.platform;
    const execute = this.execute;
    const resolveCommand = this.resolveCommand;
    const javaCommand = environment.JOERN_JAVA_BIN ? join(environment.JOERN_JAVA_BIN, platform === "win32" ? "java.exe" : "java") : environment.JAVA_HOME ? join(environment.JAVA_HOME, "bin", platform === "win32" ? "java.exe" : "java") : "java";
    const nodeMajor = Number(String(this.nodeVersion).split(".")[0]);
    const node = {
      id: "node", label: "Node.js", category: "基础运行时", status: nodeMajor >= 20 ? "ready" : "unavailable", version: this.nodeVersion,
      command: "node", required_for: ["workbench", "static", "dynamic"], detail: nodeMajor >= 20 ? "满足 Node.js 20+ 要求。" : "需要 Node.js 20 或更高版本。",
    };
    const [npm, git, opencode, ttyd, java, joern, joernParse, opengrep, semgrep, gitleaks, osvScanner, chrome, dependencies, mcp, bacPython] = await Promise.all([
      probeExecutable({ id: "npm", label: "npm", category: "基础运行时", command: platform === "win32" ? "npm.cmd" : "npm", requiredFor: ["workbench", "dynamic"], environment, platform, execute, resolveCommand }),
      probeExecutable({ id: "git", label: "Git", category: "基础运行时", command: "git", requiredFor: ["static", "dynamic"], environment, platform, execute, resolveCommand }),
      openCodeComponent({ environment, platform, architecture: this.architecture, execute, resolveCommand }),
      terminalComponent({ environment, platform, execute, resolveCommand }),
      probeExecutable({ id: "java", label: "Java", category: "深度静态分析（可选）", command: javaCommand, requiredFor: ["deep_dataflow"], environment, platform, execute, resolveCommand }),
      probeExecutable({ id: "joern", label: "Joern", category: "深度静态分析（可选）", command: environment.JOERN_BIN ?? "joern", args: null, requiredFor: ["deep_dataflow"], environment, platform, execute, resolveCommand }),
      probeExecutable({ id: "joern_parse", label: "joern-parse", category: "深度静态分析（可选）", command: environment.JOERN_PARSE_BIN ?? "joern-parse", args: ["--list-languages"], requiredFor: ["deep_dataflow"], environment, platform, execute, resolveCommand }),
      probeExecutable({ id: "opengrep", label: "OpenGrep", category: "静态分析", command: environment.OPENGREP_BIN ?? "opengrep", requiredFor: [], environment, platform, execute, resolveCommand }),
      probeExecutable({ id: "semgrep", label: "Semgrep", category: "静态分析", command: environment.SEMGREP_BIN ?? "semgrep", requiredFor: [], environment, platform, execute, resolveCommand }),
      probeExecutable({ id: "gitleaks", label: "Gitleaks", category: "静态分析（可选）", command: environment.GITLEAKS_BIN ?? "gitleaks", requiredFor: ["secret_scan"], environment, platform, execute, resolveCommand }),
      probeExecutable({ id: "osv_scanner", label: "OSV-Scanner", category: "静态分析（可选）", command: environment.OSV_SCANNER_BIN ?? "osv-scanner", requiredFor: ["dependency_scan"], environment, platform, execute, resolveCommand }),
      chromeComponent({ environment, platform, execute, resolveCommand }),
      readPackageComponent(this.projectRoot),
      inspectMcpConfiguration(this.configPaths),
      probeExecutable({ id: "bac_python", label: "Python（越权专项）", category: "静态分析（可选）", command: environment.AUDIT_BAC_PYTHON || (platform === "win32" ? "python" : "python3"), requiredFor: ["bac_analysis"], environment, platform, execute, resolveCommand }),
    ]);
    const chromeMcp = configuredComponent("chrome_devtools_mcp", "Chrome DevTools MCP", "动态验证", mcp.chrome_devtools, ["dynamic"], "隔离 Chrome DevTools MCP 已启用。" );
    const components = [node, npm, dependencies, git, opencode, ttyd, java, joern, joernParse, opengrep, semgrep, gitleaks, osvScanner, chrome, chromeMcp, bacPython];
    const capabilities = [
      capability("workbench", "工作台", ["node", "project_dependencies"], components),
      capability("static", "静态漏洞挖掘", ["node", "git", "opencode", "project_dependencies"], components, { anyOf: ["opengrep", "semgrep"] }),
      capability("source_pattern_scan", "源码模式扫描", [], components, { anyOf: ["opengrep", "semgrep"] }),
      capability("bac_analysis", "越权专项差分（可选）", ["node", "opencode", "bac_python"], components, { optional: true }),
      capability("secret_scan", "密钥泄漏扫描（可选）", ["gitleaks"], components, { optional: true }),
      capability("dependency_scan", "依赖漏洞扫描（可选）", ["osv_scanner"], components, { optional: true }),
      capability("deep_dataflow", "深度数据流分析（可选）", ["java", "joern", "joern_parse"], components, { optional: true }),
      capability("terminal_monitor", "ttyd 交互终端", ["node", "opencode", "ttyd"], components),
      capability("dynamic", "Web 动态验证", ["node", "npm", "git", "opencode", "project_dependencies", "chrome", "chrome_devtools_mcp"], components),
    ];
    const value = {
      generated_at: new Date().toISOString(),
      platform: { os: platform, arch: this.architecture, node: this.nodeVersion },
      configuration: { checked: this.configPaths.length, valid: mcp.valid_configs, invalid: mcp.invalid_configs },
      capabilities,
      components,
    };
    this.cached = { generated_at_ms: Date.now(), value };
    return value;
  }
}
