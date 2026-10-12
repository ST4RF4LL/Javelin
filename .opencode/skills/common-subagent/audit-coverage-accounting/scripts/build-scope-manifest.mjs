#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir, readlink, realpath, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const SCHEMA_VERSION = 1;
const LENSES = ["sink-driven", "control-driven", "config-driven"];
let fileSweepProfile = false;
const AUDIT_OUTPUT_EXCLUSIONS = new Map();
const INFRASTRUCTURE_EXCLUSIONS = new Map([
  [".git", "version-control-internals"],
  [".atlas", "local-code-facts-cache"],
  [".opencode", "audit-infrastructure"],
  ["reports", "audit-output"],
  ["tmp", "audit-runtime-output"],
]);
const NON_EXECUTABLE_DOCUMENT_PREFIXES = ["document/pdm/", "document/pos/"];
const NON_EXECUTABLE_METADATA_FILENAMES = new Set([".gitignore", "license", "manifest.mf"]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    i += 1;
  }
  for (const key of ["root", "audit-id", "output"]) {
    if (!args[key]) throw new Error(`Required argument missing: --${key}`);
  }
  args.mode ??= "auto";
  if (!["auto", "git", "filesystem"].includes(args.mode)) {
    throw new Error("--mode must be auto, git, or filesystem");
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(args["audit-id"])) {
    throw new Error("Invalid --audit-id");
  }
  return args;
}

function normalizePath(path) {
  return path.split(sep).join("/").replace(/^\.\//, "");
}

function stableId(prefix, value) {
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

async function inspectFile(path) {
  return await new Promise((resolveInspection, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    let sampled = 0;
    let binary = false;
    stream.on("data", chunk => {
      hash.update(chunk);
      if (sampled >= 8192 || binary) return;
      const length = Math.min(chunk.length, 8192 - sampled);
      for (let index = 0; index < length; index += 1) {
        if (chunk[index] === 0) {
          binary = true;
          break;
        }
      }
      sampled += length;
    });
    stream.on("error", reject);
    stream.on("end", () => resolveInspection({ sha256: hash.digest("hex"), binary }));
  });
}

async function mapLimit(items, limit, operation) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      await operation(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const CLASSIFIERS = [
  { exts: [".java"], owner: "java-source-auditor", kind: "source", parser: "javac-java" },
  { exts: [".kt", ".kts"], owner: "java-source-auditor", kind: "source", parser: "joern-kotlin" },
  { exts: [".groovy"], owner: "java-source-auditor", kind: "source", parser: null, inventoryState: "unsupported", inventoryReason: "no-configured-groovy-ast-cpg-extractor" },
  { exts: [".scala"], owner: "java-source-auditor", kind: "source", parser: null, inventoryState: "unsupported", inventoryReason: "no-configured-scala-ast-cpg-extractor" },
  { exts: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"], owner: "web-source-auditor", kind: "source", parser: "joern-js" },
  { exts: [".jsp", ".jspx", ".html", ".htm", ".ftl", ".ftlh", ".vm", ".mustache", ".hbs", ".vue", ".svelte"], owner: "web-source-auditor", kind: "template", parser: "embedded-web" },
  { exts: [".css", ".scss", ".sass", ".less"], owner: "web-source-auditor", kind: "web-resource", parser: null },
  { exts: [".graphql", ".gql", ".proto", ".wsdl"], owner: "platform-security-auditor", kind: "interface-spec", parser: null },
  { exts: [".py", ".pyw"], owner: "python-source-auditor", kind: "source", parser: "joern-python" },
  { exts: [".c", ".h"], owner: "c-cpp-source-auditor", kind: "source", parser: "joern-c" },
  { exts: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"], owner: "c-cpp-source-auditor", kind: "source", parser: "joern-cpp" },
  { exts: [".gradle"], owner: "platform-security-auditor", kind: "build-source", parser: null, inventoryState: "unsupported", inventoryReason: "no-configured-groovy-ast-cpg-extractor" },
  { exts: [".sql"], owner: "platform-security-auditor", kind: "database-source", parser: null, inventoryState: "unsupported", inventoryReason: "no-configured-sql-procedure-ast-extractor" },
  { exts: [".xml", ".yml", ".yaml", ".json", ".json5", ".toml", ".ini", ".conf", ".cfg", ".properties", ".env", ".tf", ".hcl"], owner: "platform-security-auditor", kind: "configuration", parser: null },
  { exts: [".md", ".adoc", ".rst", ".txt"], owner: "platform-security-auditor", kind: "documentation", parser: null },
];

function classify(path, binary) {
  if (binary) return { owner_agent: "platform-security-auditor", content_kind: "binary", parser: null, inventory_state: "not-applicable", inventory_reason: "binary-artifact-outside-source-function-universe" };
  const base = path.toLowerCase().split("/").at(-1);
  const normalized = path.toLowerCase();
  if (NON_EXECUTABLE_METADATA_FILENAMES.has(base) || NON_EXECUTABLE_DOCUMENT_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return { owner_agent: "platform-security-auditor", content_kind: "documentation", parser: null, inventory_state: "not-applicable", inventory_reason: "known-non-executable-document-or-metadata" };
  }
  if (normalized.startsWith("document/sql/") && extname(base) === ".sql") {
    return { owner_agent: "platform-security-auditor", content_kind: "database-schema", parser: null, inventory_state: "not-applicable", inventory_reason: "declarative-database-schema-reviewed-as-file-not-function" };
  }
  if (base === "jenkinsfile") {
    return { owner_agent: "platform-security-auditor", content_kind: "build-source", parser: null, inventory_state: "unsupported", inventory_reason: "no-configured-groovy-ast-cpg-extractor" };
  }
  if (["dockerfile", "makefile", "procfile", "pom.xml"].includes(base)) {
    return { owner_agent: "platform-security-auditor", content_kind: "configuration", parser: null, inventory_state: "not-applicable", inventory_reason: "declarative-build-or-runtime-configuration" };
  }
  const ext = extname(base);
  if ([".sh", ".bash", ".zsh"].includes(ext)) {
    return { owner_agent: "platform-security-auditor", content_kind: "deployment-script", parser: null, inventory_state: "not-applicable", inventory_reason: "deployment-script-reviewed-as-file-and-interface-source-not-function" };
  }
  const hit = CLASSIFIERS.find(item => item.exts.includes(ext));
  if (hit) return {
    owner_agent: hit.owner,
    content_kind: hit.kind,
    parser: hit.parser,
    inventory_state: hit.inventoryState ?? (hit.parser ? "required" : "not-applicable"),
    inventory_reason: hit.inventoryReason ?? (hit.parser ? "configured-ast-or-cpg-extractor" : "known-non-function-source-type"),
  };
  return { owner_agent: "platform-security-auditor", content_kind: "unknown-text", parser: null, inventory_state: "unsupported", inventory_reason: "unknown-text-may-contain-uninventoried-functions" };
}

function gitTrackedFiles(root) {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached"], { encoding: "buffer" });
  if (result.status !== 0) return new Set();
  return new Set(result.stdout.toString("utf8").split("\0").filter(Boolean).map(normalizePath));
}

function gitScopeFiles(root) {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], { encoding: "buffer" });
  if (result.status !== 0) return null;
  const files = [...new Set(result.stdout.toString("utf8").split("\0").filter(Boolean).map(normalizePath))].sort();
  if (files.length === 0) {
    const ignoredRoot = spawnSync("git", ["-C", root, "check-ignore", "--quiet", "."]);
    if (ignoredRoot.status === 0) return null;
  }
  return files;
}

function gitIgnoredPaths(root) {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--", "."], { encoding: "buffer" });
  if (result.status !== 0) return [];
  return [...new Set(result.stdout.toString("utf8").split("\0").filter(Boolean).map(path => normalizePath(path).replace(/\/$/, "")))].sort();
}

function infrastructureExclusion(path) {
  const rootName = path.split("/")[0];
  return INFRASTRUCTURE_EXCLUSIONS.get(rootName) ?? null;
}

async function walk(root) {
  const files = [];
  const symlinks = [];
  const exclusions = [];
  const errors = [];

  async function visit(absDir, relDir) {
    let dir;
    try {
      dir = await opendir(absDir);
    } catch (error) {
      errors.push({ path: relDir || ".", operation: "opendir", error: error.message });
      return;
    }
    const entries = [];
    for await (const entry of dir) entries.push(entry);
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const rel = normalizePath(relDir ? `${relDir}/${entry.name}` : entry.name);
      const abs = resolve(absDir, entry.name);
      if (AUDIT_OUTPUT_EXCLUSIONS.has(rel)) {
        exclusions.push({ path: rel, reason: AUDIT_OUTPUT_EXCLUSIONS.get(rel) });
        continue;
      }
      if (entry.name === ".git") {
        exclusions.push({ path: rel, reason: "version-control-internals" });
        continue;
      }
      if ((!relDir || fileSweepProfile) && entry.isDirectory() && INFRASTRUCTURE_EXCLUSIONS.has(entry.name)) {
        exclusions.push({ path: rel, reason: INFRASTRUCTURE_EXCLUSIONS.get(entry.name) });
        continue;
      }
      try {
        const info = await lstat(abs);
        if (info.isSymbolicLink()) {
          symlinks.push({
            file_id: stableId("file", rel),
            path: rel,
            type: "symlink",
            link_target: await readlink(abs),
            size: info.size,
            owner_agent: "platform-security-auditor",
            content_kind: "symlink",
            function_parser: null,
            function_inventory_state: "not-applicable",
            function_inventory_reason: "symlink-not-followed-file-target-reviewed-separately-if-in-scope",
            function_inventory_required: false,
            review_required: true,
            required_lenses: LENSES,
          });
        } else if (info.isDirectory()) {
          await visit(abs, rel);
        } else if (info.isFile()) {
          files.push({ abs, rel, info });
        } else {
          errors.push({ path: rel, operation: "classify", error: "unsupported-filesystem-entry" });
        }
      } catch (error) {
        errors.push({ path: rel, operation: "lstat", error: error.message });
      }
    }
  }

  await visit(root, "");
  return { files, symlinks, exclusions, errors };
}

async function walkGitScope(root, candidates) {
  const files = [];
  const symlinks = [];
  const exclusions = [];
  const errors = [];
  const excludedRoots = new Set();

  for (const rel of candidates) {
    const infrastructureReason = infrastructureExclusion(rel);
    if (infrastructureReason) {
      const rootName = rel.split("/")[0];
      if (!excludedRoots.has(rootName)) {
        exclusions.push({ path: rootName, reason: infrastructureReason });
        excludedRoots.add(rootName);
      }
      continue;
    }
    const abs = resolve(root, rel);
    try {
      const info = await lstat(abs);
      if (info.isSymbolicLink()) {
        symlinks.push({
          file_id: stableId("file", rel),
          path: rel,
          type: "symlink",
          link_target: await readlink(abs),
          size: info.size,
          owner_agent: "platform-security-auditor",
          content_kind: "symlink",
          function_parser: null,
          function_inventory_state: "not-applicable",
          function_inventory_reason: "symlink-not-followed-file-target-reviewed-separately-if-in-scope",
          function_inventory_required: false,
          review_required: true,
          required_lenses: LENSES,
        });
      } else if (info.isFile()) {
        files.push({ abs, rel, info });
      } else if (info.isDirectory()) {
        exclusions.push({ path: rel, reason: "gitlink-or-directory-entry-reviewed-via-dependency-metadata" });
      } else {
        errors.push({ path: rel, operation: "classify", error: "unsupported-filesystem-entry" });
      }
    } catch (error) {
      if (error.code === "ENOENT") exclusions.push({ path: rel, reason: "tracked-path-absent-from-working-tree" });
      else errors.push({ path: rel, operation: "lstat", error: error.message });
    }
  }

  for (const path of gitIgnoredPaths(root)) {
    if (infrastructureExclusion(path) || exclusions.some(item => item.path === path)) continue;
    exclusions.push({ path, reason: "gitignore-policy" });
  }
  exclusions.sort((a, b) => a.path.localeCompare(b.path));
  return { files, symlinks, exclusions, errors };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.profile && args.profile !== "file-sweep") throw new Error("Unknown scope profile");
  if (args.profile === "file-sweep") {
    fileSweepProfile = true;
    INFRASTRUCTURE_EXCLUSIONS.clear();
    for (const [name, reason] of [[".git", "版本控制内部数据"], [".atlas", "代码索引缓存"], ["node_modules", "已安装第三方依赖"], [".venv", "Python 虚拟环境"], ["__pycache__", "Python 字节码缓存"]]) INFRASTRUCTURE_EXCLUSIONS.set(name, reason);
    args.mode = "filesystem";
  }
  const root = fileSweepProfile ? await realpath(args.root) : resolve(args.root);
  const output = resolve(args.output);
  if (fileSweepProfile) {
    for (const key of ["audit-reports-root", "audit-tmp-root", "audit-workspace-root", "audit-state-root"]) {
      if (!args[key]) continue;
      const rel = relative(root, await realpath(args[key]).catch(() => resolve(args[key])));
      if (!rel) throw new Error("审计运行数据目录不能与被测源码根目录重合。");
      if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) continue;
      AUDIT_OUTPUT_EXCLUSIONS.set(normalizePath(rel), "平台实际审计输出或运行状态目录");
    }
  }
  const tracked = gitTrackedFiles(root);
  const gitCandidates = args.mode === "filesystem" ? null : gitScopeFiles(root);
  if (args.mode === "git" && gitCandidates === null) throw new Error("--mode git requires a Git worktree");
  const useGitScope = gitCandidates !== null;
  const walked = useGitScope ? await walkGitScope(root, gitCandidates) : await walk(root);
  const records = [...walked.symlinks];

  await mapLimit(walked.files, 16, async item => {
    try {
      const inspection = await inspectFile(item.abs);
      const classification = classify(item.rel, inspection.binary);
      records.push({
        file_id: stableId("file", item.rel),
        path: item.rel,
        type: "file",
        size: item.info.size,
        sha256: inspection.sha256,
        tracked_by_git: tracked.has(item.rel),
        owner_agent: classification.owner_agent,
        content_kind: classification.content_kind,
        function_parser: classification.parser,
        function_inventory_state: classification.inventory_state,
        function_inventory_reason: classification.inventory_reason,
        function_inventory_required: classification.inventory_state === "required",
        review_required: true,
        required_lenses: LENSES,
      });
    } catch (error) {
      walked.errors.push({ path: item.rel, operation: "read-or-hash", error: error.message });
    }
  });

  records.sort((a, b) => a.path.localeCompare(b.path));
  const digestInput = records.map(r => `${r.path}\0${r.type}\0${r.sha256 ?? r.link_target ?? ""}`).join("\n");
  const manifest = {
    schema_version: SCHEMA_VERSION,
    audit_id: args["audit-id"],
    root,
    scope_digest: createHash("sha256").update(digestInput).digest("hex"),
    policy: {
      ...(fileSweepProfile ? { profile: "file-sweep", description: "逐文件扫描包含 Git 忽略的本机文件，显式排除依赖安装目录、版本控制、索引缓存及平台实际运行数据目录；不按 reports/tmp/.opencode 目录名排除业务文件。", audit_output_paths: [...AUDIT_OUTPUT_EXCLUSIONS.keys()] } : {}),
      enumeration: useGitScope ? "git-index-plus-untracked-nonignored" : "recursive-filesystem-walk",
      requested_mode: args.mode,
      ignored_content: useGitScope ? "excluded-by-gitignore-and-recorded-as-scope-exclusions" : "included",
      excluded_root_directories: Object.fromEntries(INFRASTRUCTURE_EXCLUSIONS),
      all_discovered_files_require_review: true,
      lenses: LENSES,
    },
    summary: {
      files: records.length,
      regular_files: records.filter(r => r.type === "file").length,
      symlinks: records.filter(r => r.type === "symlink").length,
      function_inventory_required: records.filter(r => r.function_inventory_required).length,
      function_inventory_unsupported: records.filter(r => r.function_inventory_state === "unsupported").length,
      untracked_files: records.filter(r => r.type === "file" && !r.tracked_by_git).length,
      exclusions: walked.exclusions.length,
      errors: walked.errors.length,
    },
    files: records,
    exclusions: walked.exclusions,
    errors: walked.errors,
    complete: walked.errors.length === 0,
  };
  manifest.manifest_digest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output, ...manifest.summary, complete: manifest.complete })}\n`);
  if (!manifest.complete) process.exitCode = 2;
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
