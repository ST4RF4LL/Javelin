import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { digestPath, writeStaticRun } from "./static-artifacts.mjs";

const ENGINE_NAMES = new Set(["auto", "semgrep", "opengrep"]);
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_SUMMARY_BYTES = 32 * 1024;
const LOCK_WAIT_MS = 30_000;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export async function resolveWorkspacePath(workspaceRoot, inputPath, { mustExist = true } = {}) {
  const root = await realpath(resolve(workspaceRoot));
  const candidate = resolve(root, inputPath);
  if (!isInside(root, candidate)) throw new Error(`Path escapes workspace: ${inputPath}`);
  if (mustExist) {
    const actual = await realpath(candidate);
    if (!isInside(root, actual)) throw new Error(`Symlink target escapes workspace: ${inputPath}`);
    return actual;
  }
  let ancestor = candidate;
  const missingSegments = [];
  while (true) {
    try {
      const actualAncestor = await realpath(ancestor);
      const actual = resolve(actualAncestor, ...missingSegments);
      if (!isInside(root, actual)) throw new Error(`Symlink target escapes workspace: ${inputPath}`);
      return actual;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missingSegments.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function resolveAllowedPath(baseRoot, inputPath, allowedRoots, { mustExist = true, label = "Path" } = {}) {
  const roots = await Promise.all(allowedRoots.map(root => realpath(resolve(root))));
  const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(baseRoot, inputPath);
  let actual;
  if (mustExist) {
    actual = await realpath(candidate);
  } else {
    let ancestor = candidate;
    const missingSegments = [];
    while (true) {
      try {
        actual = resolve(await realpath(ancestor), ...missingSegments);
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        missingSegments.unshift(basename(ancestor));
        ancestor = parent;
      }
    }
  }
  if (!roots.some(root => isInside(root, actual))) throw new Error(`${label} escapes allowed audit roots: ${inputPath}`);
  return actual;
}

function relativeArtifactPath(prefix, root, path) {
  const value = relative(root, path).replaceAll("\\", "/");
  return value ? `${prefix}/${value}` : prefix;
}

function truncateText(value, maxBytes) {
  const buffer = Buffer.from(String(value ?? ""), "utf8");
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  return `${buffer.subarray(0, Math.max(0, maxBytes - 32)).toString("utf8")}\n...[truncated ${buffer.length - maxBytes} bytes]`;
}

export function runProcess(command, args, {
  cwd,
  timeoutMs,
  env = {},
  stdoutLimitBytes = MAX_STDOUT_BYTES,
  stderrSummaryBytes = MAX_STDERR_SUMMARY_BYTES,
  stderrPath,
}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        SEMGREP_SEND_METRICS: "off",
        SEMGREP_ENABLE_VERSION_CHECK: "0",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderrTail = Buffer.alloc(0);
    let stderrBytes = 0;
    const stderrHash = createHash("sha256");
    let timedOut = false;
    let stdoutLimitExceeded = false;
    let settled = false;
    const stderrWriter = stderrPath ? createWriteStream(stderrPath, { flags: "w" }) : null;
    const stderrFinished = stderrWriter
      ? new Promise((resolveStream, rejectStream) => {
        stderrWriter.once("finish", resolveStream);
        stderrWriter.once("error", rejectStream);
      })
      : Promise.resolve();
    if (stderrWriter) child.stderr.pipe(stderrWriter);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);

    child.stdout.on("data", chunk => {
      const buffer = Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes <= stdoutLimitBytes) stdoutChunks.push(buffer);
      else if (!stdoutLimitExceeded) {
        stdoutLimitExceeded = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      }
    });
    child.stderr.on("data", chunk => {
      const buffer = Buffer.from(chunk);
      stderrBytes += buffer.length;
      stderrHash.update(buffer);
      stderrTail = Buffer.concat([stderrTail, buffer]);
      if (stderrTail.length > stderrSummaryBytes) {
        stderrTail = stderrTail.subarray(stderrTail.length - stderrSummaryBytes);
      }
    });
    child.on("error", error => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", async code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try {
        await stderrFinished;
      } catch (error) {
        reject(error);
        return;
      }
      if (timedOut) {
        reject(new Error(`Static-analysis process timed out after ${timeoutMs} ms`));
        return;
      }
      if (stdoutLimitExceeded) {
        reject(new Error(`Static-analysis JSON exceeded the ${stdoutLimitBytes}-byte safety limit`));
        return;
      }
      resolvePromise({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: stderrTail.toString("utf8"),
        stderrBytes,
        stderrSha256: stderrBytes > 0 ? stderrHash.digest("hex") : null,
        stderrTruncated: stderrBytes > stderrTail.length,
      });
    });
  });
}

function engineCommands(engine, environment = process.env) {
  if (!ENGINE_NAMES.has(engine)) throw new Error(`Unsupported engine: ${engine}`);
  const semgrep = environment.SEMGREP_BIN || "semgrep";
  const opengrep = environment.OPENGREP_BIN || "opengrep";
  if (engine === "semgrep") return [{ engine: "semgrep", command: semgrep }];
  if (engine === "opengrep") return [{ engine: "opengrep", command: opengrep }];
  const preferred = environment.SEMGREP_ENGINE || "auto";
  if (!ENGINE_NAMES.has(preferred)) throw new Error(`Unsupported SEMGREP_ENGINE: ${preferred}`);
  if (preferred === "semgrep") return [{ engine: "semgrep", command: semgrep }, { engine: "opengrep", command: opengrep }];
  return [{ engine: "opengrep", command: opengrep }, { engine: "semgrep", command: semgrep }];
}

export async function probeEngines({ workspaceRoot, environment = process.env }) {
  const probes = [];
  for (const candidate of engineCommands("auto", environment)) {
    try {
      const result = await runProcess(candidate.command, ["--version"], {
        cwd: workspaceRoot,
        timeoutMs: 10_000,
        env: environment,
      });
      probes.push({
        ...candidate,
        available: result.code === 0,
        version: result.code === 0 ? truncateText(result.stdout.trim() || result.stderr.trim(), 1_000) : null,
        error: result.code === 0 ? null : truncateText(`exit-${result.code}: ${result.stderr.trim()}`, 1_000),
      });
    } catch (error) {
      probes.push({ ...candidate, available: false, version: null, error: truncateText(error.message, 1_000) });
    }
  }
  return probes;
}

export async function selectEngine({ workspaceRoot, engine = "auto", environment = process.env }) {
  const failures = [];
  for (const candidate of engineCommands(engine, environment)) {
    try {
      const result = await runProcess(candidate.command, ["--version"], {
        cwd: workspaceRoot,
        timeoutMs: 10_000,
        env: environment,
      });
      if (result.code === 0) {
        return {
          ...candidate,
          version: truncateText(result.stdout.trim() || result.stderr.trim() || "unknown", 1_000),
        };
      }
      failures.push(truncateText(`${candidate.engine}: exit ${result.code} ${result.stderr.trim()}`, 1_000));
    } catch (error) {
      failures.push(truncateText(`${candidate.engine}: ${error.message}`, 1_000));
    }
  }
  throw new Error(`No usable Semgrep/OpenGrep binary found (${failures.join("; ")})`);
}

function severityLevel(value) {
  const severity = String(value ?? "").toUpperCase();
  if (["ERROR", "CRITICAL", "HIGH"].includes(severity)) return "error";
  if (["WARNING", "WARN", "MEDIUM"].includes(severity)) return "warning";
  return "note";
}

export function semgrepJsonToSarif(payload, { engine, version, commandLine, workspaceRoot }) {
  const rules = new Map();
  const results = [];
  for (const finding of payload.results ?? []) {
    const ruleId = finding.check_id ?? "semgrep/unknown";
    const message = finding.extra?.message ?? finding.message ?? ruleId;
    if (!rules.has(ruleId)) {
      rules.set(ruleId, {
        id: ruleId,
        name: ruleId,
        shortDescription: { text: String(message).slice(0, 200) },
        properties: {
          severity: finding.extra?.severity ?? null,
          metadata: finding.extra?.metadata ?? {},
        },
      });
    }
    const start = finding.start ?? {};
    const end = finding.end ?? {};
    const rawFindingPath = finding.path ?? "unknown";
    const normalizedRoot = workspaceRoot ? resolve(workspaceRoot) : null;
    const normalizedFindingPath = isAbsolute(String(rawFindingPath))
      && normalizedRoot
      && isInside(normalizedRoot, resolve(String(rawFindingPath)))
      ? relative(normalizedRoot, resolve(String(rawFindingPath)))
      : String(rawFindingPath);
    const artifactUri = normalizedFindingPath.replaceAll("\\", "/");
    const result = {
      ruleId,
      level: severityLevel(finding.extra?.severity),
      message: { text: String(message) },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: artifactUri },
          region: {
            startLine: start.line ?? 1,
            startColumn: start.col ?? 1,
            endLine: end.line ?? start.line ?? 1,
            endColumn: end.col ?? start.col ?? 1,
          },
        },
      }],
      properties: {
        engine,
        metavars: finding.extra?.metavars ?? {},
        lines: finding.extra?.lines ?? null,
        validation_state: finding.extra?.validation_state ?? null,
      },
    };
    if (finding.extra?.fingerprint) {
      result.partialFingerprints = { semgrepFingerprint: finding.extra.fingerprint };
    }
    results.push(result);
  }
  return {
    version: "2.1.0",
    "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: {
        driver: {
          name: engine === "opengrep" ? "OpenGrep" : "Semgrep",
          version,
          informationUri: engine === "opengrep" ? "https://www.opengrep.dev/" : "https://semgrep.dev/",
          rules: [...rules.values()],
        },
      },
      invocations: [{
        executionSuccessful: (payload.errors?.length ?? 0) === 0,
        commandLine,
        properties: { errors: payload.errors ?? [] },
      }],
      results,
    }],
  };
}

async function acquireFileLock(lockPath) {
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return async () => {
        await handle.close();
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() - started >= LOCK_WAIT_MS) {
        throw new Error(`Timed out waiting for SARIF lock: ${basename(lockPath)}`);
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    }
  }
}

async function mergeSarif(outputPath, sarif) {
  await mkdir(dirname(outputPath), { recursive: true });
  const lockPath = `${outputPath}.lock`;
  const release = await acquireFileLock(lockPath);
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    let combined = sarif;
    try {
      const existing = JSON.parse(await readFile(outputPath, "utf8"));
      if (existing.version !== "2.1.0" || !Array.isArray(existing.runs)) throw new Error("Existing SARIF has an unsupported shape");
      combined = { ...existing, runs: [...existing.runs, ...sarif.runs] };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await writeFile(temporaryPath, `${JSON.stringify(combined, null, 2)}\n`, "utf8");
    await rename(temporaryPath, outputPath);
    return combined;
  } finally {
    await rm(temporaryPath, { force: true });
    await release();
  }
}

export async function runSemgrepScan({
  workspaceRoot,
  auditId,
  sessionId,
  agentName,
  targetPath,
  rulePaths,
  engine = "auto",
  sarifPath,
  jobs = 2,
  ruleTimeoutSeconds = 30,
  processTimeoutMs = 300_000,
  maxMemoryMb = 0,
  excludes = [],
  environment = process.env,
}) {
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(auditId)) throw new Error(`Invalid audit_id: ${auditId}`);
  if (!/^[a-z0-9][a-z0-9._:-]{2,255}$/i.test(sessionId)) throw new Error(`Invalid session_id: ${sessionId}`);
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(agentName)) throw new Error(`Invalid agent_name: ${agentName}`);
  if (!Array.isArray(rulePaths) || rulePaths.length === 0) throw new Error("At least one local rule path is required");
  const root = await realpath(resolve(workspaceRoot));
  const splitWorkspace = Boolean(environment.AUDIT_SOURCE_ROOT && environment.AUDIT_REPORTS_ROOT && environment.AUDIT_TMP_ROOT);
  const sourceRoot = splitWorkspace ? await realpath(resolve(environment.AUDIT_SOURCE_ROOT)) : root;
  const reportsRoot = splitWorkspace ? await realpath(resolve(environment.AUDIT_REPORTS_ROOT)) : null;
  const tmpRoot = splitWorkspace ? await realpath(resolve(environment.AUDIT_TMP_ROOT)) : null;
  const engineRoot = splitWorkspace && environment.AUDIT_ENGINE_ROOT ? await realpath(resolve(environment.AUDIT_ENGINE_ROOT)) : root;
  const target = splitWorkspace
    ? await resolveAllowedPath(root, targetPath, [sourceRoot], { label: "Scan target" })
    : await resolveWorkspacePath(root, targetPath);
  const rules = splitWorkspace
    ? await Promise.all(rulePaths.map(path => resolveAllowedPath(root, path, [engineRoot, sourceRoot, tmpRoot], { label: "Rule path" })))
    : await Promise.all(rulePaths.map(path => resolveWorkspacePath(root, path)));
  for (const rule of rules) {
    const info = await stat(rule);
    if (!info.isFile() && !info.isDirectory()) throw new Error(`Unsupported rule path: ${rule}`);
  }
  const selected = await selectEngine({ workspaceRoot: root, engine, environment });
  const targetDigest = await digestPath(target, {
    excludedPaths: splitWorkspace ? [reportsRoot, tmpRoot] : [join(root, "reports"), join(root, "tmp")],
  });
  const ruleDigests = await Promise.all(rules.map(path => digestPath(path)));
  const rulePackDigest = sha256(ruleDigests.sort().join("\n"));
  const rawDirectory = splitWorkspace
    ? await resolveAllowedPath(tmpRoot, join(auditId, "semgrep", sessionId), [tmpRoot], { mustExist: false, label: "Raw output" })
    : await resolveWorkspacePath(root, join("tmp", auditId, "semgrep", sessionId), { mustExist: false });
  await mkdir(rawDirectory, { recursive: true });
  const stderrTemporaryPath = join(rawDirectory, `.${selected.engine}.${process.pid}.${Date.now()}.stderr.log`);
  const args = ["scan", "--json"];
  if (selected.engine === "semgrep") args.push("--metrics=off");
  args.push("--jobs", String(jobs), "--timeout", String(ruleTimeoutSeconds));
  if (maxMemoryMb > 0) args.push("--max-memory", String(maxMemoryMb));
  for (const rule of rules) args.push("--config", rule);
  for (const pattern of excludes) {
    if (typeof pattern !== "string" || pattern.trim() === "" || pattern.includes("\0")) throw new Error("Invalid exclude pattern");
    args.push("--exclude", pattern);
  }
  args.push(target);
  let processResult;
  try {
    processResult = await runProcess(selected.command, args, {
      cwd: root,
      timeoutMs: processTimeoutMs,
      env: environment,
      stderrPath: stderrTemporaryPath,
    });
  } catch (error) {
    let retainedPath = null;
    try {
      if ((await stat(stderrTemporaryPath)).size > 0) {
        retainedPath = join(rawDirectory, `${selected.engine}.failed.${Date.now()}.stderr.log`);
        await rename(stderrTemporaryPath, retainedPath);
      } else {
        await rm(stderrTemporaryPath, { force: true });
      }
    } catch (fileError) {
      if (fileError.code !== "ENOENT") throw fileError;
    }
    const retained = retainedPath ? `; stderr retained at ${splitWorkspace ? relativeArtifactPath("tmp", tmpRoot, retainedPath) : relative(root, retainedPath)}` : "";
    throw new Error(`${truncateText(error.message, 2_000)}${retained}`);
  }

  let stderrOutputPath = null;
  if (processResult.stderrBytes > 0) {
    stderrOutputPath = join(rawDirectory, `${selected.engine}.${processResult.stderrSha256.slice(0, 16)}.stderr.log`);
    await rename(stderrTemporaryPath, stderrOutputPath);
  } else {
    await rm(stderrTemporaryPath, { force: true });
  }
  if (![0, 1].includes(processResult.code)) {
    const retained = stderrOutputPath ? `; stderr retained at ${splitWorkspace ? relativeArtifactPath("tmp", tmpRoot, stderrOutputPath) : relative(root, stderrOutputPath)}` : "";
    throw new Error(`${selected.engine} scan failed with exit ${processResult.code}${retained}`);
  }
  let payload;
  try {
    payload = JSON.parse(processResult.stdout);
  } catch (error) {
    const retained = stderrOutputPath ? `; stderr retained at ${splitWorkspace ? relativeArtifactPath("tmp", tmpRoot, stderrOutputPath) : relative(root, stderrOutputPath)}` : "";
    throw new Error(`${selected.engine} returned invalid JSON: ${truncateText(error.message, 1_000)}${retained}`);
  }
  const displayArgs = args.map(argument => {
    const value = String(argument);
    if (!isAbsolute(value)) return value;
    const absolute = resolve(value);
    if (isInside(sourceRoot, absolute)) return relative(sourceRoot, absolute).replaceAll("\\", "/") || ".";
    if (isInside(engineRoot, absolute)) return relative(engineRoot, absolute).replaceAll("\\", "/") || ".";
    if (splitWorkspace && isInside(tmpRoot, absolute)) return relativeArtifactPath("tmp", tmpRoot, absolute);
    if (splitWorkspace && isInside(reportsRoot, absolute)) return relativeArtifactPath("reports", reportsRoot, absolute);
    return value;
  });
  const commandLine = [selected.engine, ...displayArgs].join(" ");
  const rawBytes = `${JSON.stringify(payload, null, 2)}\n`;
  const rawOutputPath = join(rawDirectory, `${selected.engine}.${sha256(rawBytes).slice(0, 16)}.json`);
  await writeFile(rawOutputPath, rawBytes, "utf8");

  const requestedSarif = sarifPath ?? join("reports", "sarif", `${agentName}.${sessionId}.sarif`);
  let outputPath;
  let reportsSarifRoot;
  if (splitWorkspace) {
    reportsSarifRoot = await resolveAllowedPath(reportsRoot, "sarif", [reportsRoot], { mustExist: false, label: "SARIF root" });
    await mkdir(reportsSarifRoot, { recursive: true });
    const requested = isAbsolute(requestedSarif)
      ? requestedSarif
      : requestedSarif.replaceAll("\\", "/").startsWith("reports/")
        ? resolve(reportsRoot, requestedSarif.replaceAll("\\", "/").slice("reports/".length))
        : resolve(root, requestedSarif);
    outputPath = await resolveAllowedPath(root, requested, [reportsSarifRoot], { mustExist: false, label: "SARIF output" });
  } else {
    outputPath = await resolveWorkspacePath(root, requestedSarif, { mustExist: false });
    reportsSarifRoot = await resolveWorkspacePath(root, join("reports", "sarif"), { mustExist: false });
  }
  if (!isInside(reportsSarifRoot, outputPath)) throw new Error("SARIF output must stay under reports/sarif/");
  const sarifRun = semgrepJsonToSarif(payload, {
    engine: selected.engine,
    version: selected.version,
    commandLine,
    workspaceRoot: sourceRoot,
  });
  const immutable = await writeStaticRun({
    reportsRoot: splitWorkspace ? reportsRoot : join(root, "reports"),
    auditId,
    identity: {
      schema_version: "static-scan-identity.v1",
      capability: "source_pattern_scan",
      engine: selected.engine,
      engine_version: selected.version,
      target_path: relative(sourceRoot, target).replaceAll("\\", "/") || ".",
      target_digest: targetDigest,
      rule_pack_digest: rulePackDigest,
      options: { jobs, rule_timeout_seconds: ruleTimeoutSeconds, max_memory_mb: maxMemoryMb, excludes: [...excludes].sort() },
    },
    sarif: sarifRun,
    summary: {
      status: (payload.errors?.length ?? 0) > 0 ? "PARTIAL" : "SUCCESS",
      engine: selected.engine,
      engine_version: selected.version,
      findings: payload.results?.length ?? 0,
      errors: payload.errors?.length ?? 0,
      requested_rules: rules.map(path => relative(engineRoot, path).replaceAll("\\", "/")).sort(),
      executed_rules: rules.map(path => relative(engineRoot, path).replaceAll("\\", "/")).sort(),
      skipped_rules: [],
      target_files: payload.paths?.scanned?.length ?? null,
      parsed_files: payload.paths?.scanned?.length ?? null,
      skipped_files: payload.paths?.skipped?.length ?? null,
    },
  });
  const combinedSarif = await mergeSarif(outputPath, sarifRun);
  const sarifBytes = `${JSON.stringify(combinedSarif, null, 2)}\n`;
  return {
    engine: selected.engine,
    version: selected.version,
    audit_id: auditId,
    session_id: sessionId,
    target_path: relative(sourceRoot, target) || ".",
    rule_paths: rules.map(path => isInside(engineRoot, path) ? relative(engineRoot, path) : isInside(sourceRoot, path) ? relative(sourceRoot, path) : relativeArtifactPath("tmp", tmpRoot, path)),
    findings: payload.results?.length ?? 0,
    error_count: payload.errors?.length ?? 0,
    error_samples: (payload.errors ?? []).slice(0, 5).map(error => truncateText(
      typeof error === "string" ? error : JSON.stringify(error),
      500,
    )),
    raw_output_path: splitWorkspace ? relativeArtifactPath("tmp", tmpRoot, rawOutputPath) : relative(root, rawOutputPath),
    raw_output_sha256: sha256(rawBytes),
    stderr_path: stderrOutputPath ? (splitWorkspace ? relativeArtifactPath("tmp", tmpRoot, stderrOutputPath) : relative(root, stderrOutputPath)) : null,
    stderr_sha256: processResult.stderrSha256,
    stderr_bytes: processResult.stderrBytes,
    sarif_path: splitWorkspace ? relativeArtifactPath("reports", reportsRoot, outputPath) : relative(root, outputPath),
    sarif_sha256: sha256(sarifBytes),
    sarif_runs: combinedSarif.runs.length,
    scan_run_id: immutable.scan_run_id,
    run_manifest_path: splitWorkspace ? relativeArtifactPath("reports", reportsRoot, immutable.manifest_path) : relative(root, immutable.manifest_path),
    immutable_sarif_path: splitWorkspace ? relativeArtifactPath("reports", reportsRoot, immutable.sarif_path) : relative(root, immutable.sarif_path),
  };
}
