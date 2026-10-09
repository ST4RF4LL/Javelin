#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isProxyEnvironmentVariable } from "./opencode-runtime-config.mjs";
import { startSharedRun } from "./opencode-shared-run.mjs";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const specPath = process.argv[2];
if (!specPath || !isAbsolute(specPath)) fail("tmux launcher 需要绝对 spec 路径。");

let spec;
try {
  spec = JSON.parse(await readFile(specPath, "utf8"));
} catch (error) {
  fail(`无法读取 tmux launcher spec：${error.message}`);
}

if (typeof spec.command !== "string" || !spec.command || !Array.isArray(spec.args) || !spec.args.every(value => typeof value === "string")) {
  fail("tmux launcher spec 的 command/args 非法。");
}
if (typeof spec.cwd !== "string" || !isAbsolute(spec.cwd)) fail("tmux launcher spec 的 cwd 必须是绝对路径。");
if (spec.diagnostic_path !== undefined && (typeof spec.diagnostic_path !== "string" || !isAbsolute(spec.diagnostic_path))) {
  fail("tmux launcher spec 的 diagnostic_path 必须是绝对路径。");
}
if (spec.exit_path !== undefined && (typeof spec.exit_path !== "string" || !isAbsolute(spec.exit_path))) {
  fail("tmux launcher spec 的 exit_path 必须是绝对路径。");
}

const environment = {};
for (const [key, value] of Object.entries(spec.environment ?? {})) {
  if ((!/^OPENCODE_[A-Z0-9_]+$/.test(key) && !/^AUDIT_[A-Z0-9_]+$/.test(key) && !isProxyEnvironmentVariable(key)) || typeof value !== "string") fail(`tmux launcher 环境变量非法：${key}`);
  environment[key] = value;
}

const diagnostic = spec.diagnostic_path
  ? createWriteStream(spec.diagnostic_path, { flags: "w", encoding: "utf8", mode: 0o600 })
  : null;
diagnostic?.on("error", () => {});

if (spec.shared_server === true) {
  if (!isAbsolute(spec.state_directory ?? '') || !/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(spec.audit_id ?? '')) fail('共享服务的任务绑定非法。');
  let result;
  try {
    result = await startSharedRun(spec, { environment: { ...process.env, ...environment }, output(chunk) {
      process.stdout.write(chunk); diagnostic?.write(chunk);
    } });
  } catch (error) {
    const message = `共享 OpenCode 启动或执行失败：${error.message}`;
    process.stderr.write(`${message}\n`); diagnostic?.write(`${message}\n`);
    result = { code: 1, signal: null, error: message };
  }
  if (spec.exit_path) await writeFile(spec.exit_path, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (diagnostic) await new Promise(resolve => diagnostic.end(resolve));
  process.exit(Number.isInteger(result.code) ? result.code : 1);
}

const child = spawn(spec.command, spec.args, {
  cwd: spec.cwd,
  env: { ...process.env, ...environment },
  stdio: diagnostic ? ["inherit", "pipe", "pipe"] : "inherit",
  shell: false,
  windowsHide: true,
});

if (diagnostic) {
  for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.on("data", chunk => {
      output.write(chunk);
      diagnostic.write(chunk);
    });
  }
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}

let finished = false;
function finish(code, signal, errorMessage = null) {
  if (finished) return;
  finished = true;
  const exit = async () => {
    if (spec.exit_path) {
      try {
        await writeFile(spec.exit_path, `${JSON.stringify({ code: Number.isInteger(code) ? code : null, signal: signal ?? null, error: errorMessage })}\n`, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        process.stderr.write(`tmux launcher 无法写入退出状态：${error.message}\n`);
      }
    }
    process.exit(Number.isInteger(code) ? code : 1);
  };
  if (diagnostic) diagnostic.end(exit);
  else void exit();
}

child.once("error", error => {
  const message = `tmux launcher 启动失败：${error.message}`;
  process.stderr.write(`${message}\n`);
  diagnostic?.write(`${message}\n`);
  finish(1, null, message);
});
child.once("close", (code, signal) => {
  finish(code, signal);
});
