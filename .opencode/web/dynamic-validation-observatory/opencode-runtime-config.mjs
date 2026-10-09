import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export const PROXY_ENVIRONMENT_VARIABLES = Object.freeze([
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
]);

const PROXY_ENVIRONMENT_VARIABLE_SET = new Set(PROXY_ENVIRONMENT_VARIABLES);

export function isProxyEnvironmentVariable(key) {
  return typeof key === "string" && PROXY_ENVIRONMENT_VARIABLE_SET.has(key);
}

export function proxyEnvironmentFrom(environment = process.env) {
  const values = {};
  for (const key of PROXY_ENVIRONMENT_VARIABLES) {
    const value = environment?.[key];
    if (typeof value === "string" && value) values[key] = value;
  }
  return values;
}

function commandPath(value, engineRoot) {
  if (typeof value !== "string" || isAbsolute(value)) return value;
  if (!value.startsWith("./") && !value.startsWith("../") && !value.startsWith(".opencode/") && !value.startsWith(".opencode\\")) return value;
  return resolve(engineRoot, value);
}

export function configureTaskReviewPermissions(config, { workspaceRoot, reportsRoot }) {
  // OpenCode checks absolute write targets, including the workspace symlink.
  const edit = { "*": "deny" };
  for (const directory of [resolve(workspaceRoot, "reports", "validation"), resolve(reportsRoot, "validation")]) {
    edit[`${directory.replaceAll("\\", "/")}/**`] = "allow";
  }
  config.agent ??= {};
  const role = "vulnerability-validator", agent = config.agent[role] ?? {};
  config.agent[role] = { ...agent, permission: { ...agent.permission, edit } };
}

export async function buildOpenCodeEnvironment(configPath, baseEnvironment = process.env) {
  const absoluteConfigPath = resolve(configPath);
  const configDirectory = dirname(absoluteConfigPath);
  const engineRoot = resolve(configDirectory, "..");
  const config = JSON.parse(await readFile(absoluteConfigPath, "utf8"));
  const mcp = {};
  for (const [id, definition] of Object.entries(config.mcp ?? {})) {
    if (!definition || definition.type !== "local" || !Array.isArray(definition.command)) continue;
    mcp[id] = {
      ...definition,
      command: definition.command.map(value => commandPath(value, engineRoot)),
    };
  }
  return {
    ...baseEnvironment,
    OPENCODE_CONFIG: absoluteConfigPath,
    OPENCODE_CONFIG_DIR: configDirectory,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp, subagent_depth: 2 }),
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  };
}
