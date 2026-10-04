import { readdir, lstat, readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep, extname } from "node:path";
import { createHash } from "node:crypto";
import { LOCATORS } from "./profile.mjs";

export const hash = value => createHash("sha256").update(value).digest("hex");
export const digest = value => hash(JSON.stringify(value));
export const check = (condition, message) => { if (!condition) throw new Error(message); };
export const inside = (root, target) => { const rel = relative(root, target); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
export const LIMITS = { files: 2000, entries: 20000, file_bytes: 256 * 1024, total_bytes: 16 * 1024 * 1024, cues: 600 };
const ignored = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "vendor", "dist", "build"]);
const extensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".java", ".rs", ".cs", ".php", ".rb", ".sh", ".json", ".yaml", ".yml", ".toml", ".md"]);

export async function sourceBytes(root, path) {
  check(typeof path === "string" && path && !isAbsolute(path) && !path.split(/[\\/]/).includes(".."), "源码定位路径无效。");
  const target = resolve(root, path), stat = await lstat(target);
  check(inside(root, await realpath(target)) && stat.isFile() && !stat.isSymbolicLink() && stat.size <= LIMITS.file_bytes, "源码定位越界、为链接或超过读取限制。");
  const bytes = await readFile(target);
  check(bytes.length <= LIMITS.file_bytes && !bytes.includes(0), "源码文件不是可读取文本。");
  return bytes;
}

export async function inventory(sourceRoot, limits = LIMITS) {
  const root = await realpath(sourceRoot), files = [], cues = [], gaps = [], skipped = {};
  let entries = 0, bytesRead = 0, stopped = false;
  const skip = reason => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  async function walk(dir, depth = 0) {
    if (stopped) return;
    if (depth > 64) { skip("DEPTH_LIMIT"); return; }
    let children;
    try { children = await readdir(dir, { withFileTypes: true }); } catch { skip("UNREADABLE_DIRECTORY"); return; }
    for (const entry of children.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (stopped) break;
      if (++entries > limits.entries || files.length >= limits.files || bytesRead >= limits.total_bytes) { skip("INVENTORY_LIMIT"); stopped = true; break; }
      const absolute = resolve(dir, entry.name), path = relative(root, absolute).split(sep).join("/");
      if (entry.isSymbolicLink()) { skip("SYMLINK"); continue; }
      if (entry.isDirectory()) { if (ignored.has(entry.name)) skip("EXCLUDED_DIRECTORY"); else await walk(absolute, depth + 1); continue; }
      if (!entry.isFile() || !extensions.has(extname(entry.name).toLowerCase())) { skip("UNSUPPORTED_FILE"); continue; }
      let bytes;
      try {
        if ((await lstat(absolute)).size > limits.file_bytes) { skip("FILE_SIZE_LIMIT"); continue; }
        bytes = await sourceBytes(root, path);
      } catch { skip("UNREADABLE_OR_BINARY"); continue; }
      if (bytesRead + bytes.length > limits.total_bytes) { skip("BYTE_LIMIT"); stopped = true; break; }
      bytesRead += bytes.length;
      const lines = bytes.toString("utf8").split(/\r?\n/), sha256 = hash(bytes);
      files.push({ path, sha256, lines: lines.length, bytes: bytes.length });
      lines.forEach((line, index) => {
        const tags = LOCATORS.filter(([, pattern]) => pattern.test(line)).map(([tag]) => tag);
        if (!tags.length) return;
        if (cues.length >= limits.cues) { skip("CUE_LIMIT"); return; }
        cues.push({ cue_id: `cue-${hash(`${path}:${index + 1}`).slice(0, 16)}`, path, line: index + 1, sha256, tags });
      });
    }
  }
  await walk(root);
  for (const [reason, count] of Object.entries(skipped)) gaps.push({ reason, count });
  return { source_root: root, method: "BOUNDED_LEXICAL_LOCATORS", automatic_vulnerability_verdict: false,
    files, cues, skipped: gaps, limits, bytes_read: bytesRead,
    claim_boundary: "仅为有界源码定位，不证明调用关系、控制缺失或项目安全；未读取与未解析范围须由 Agent 保留缺口。" };
}
