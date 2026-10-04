import { readdir, lstat, realpath, readFile, open } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import { check, hash, within } from './contract.mjs';

const SKIP = new Set(['.git', '.svn', '.hg', 'node_modules', '.venv', 'venv', '__pycache__', '.idea', '.vscode', '.atlas', 'dist', 'build', 'target', '.next']);
const MANIFESTS = new Set(['package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'pyproject.toml', 'setup.py', 'go.mod', 'Cargo.toml', 'composer.json', 'CMakeLists.txt', 'Makefile', 'Gemfile']);
const SOURCE = /\.(?:[cm]?[jt]sx?|java|py|go|rs|php|c|cc|cpp|h|hpp|cs|rb|swift|kt|scala)$/i;

export async function discoverTree(root, { overrides = {}, maxDirectories = 20000, maxDepth = 32, maxMs = 30000 } = {}) {
  const base = await realpath(root), nodes = [], gaps = [], started = Date.now(); let visited = 0;
  async function visit(path, depth, parent) {
    const rel = relative(base, path).split('\\').join('/') || '.';
    const override = overrides[rel];
    if (override === 'ignore') return;
    if (++visited > maxDirectories || depth > maxDepth || Date.now() - started > maxMs) { gaps.push({ path: rel, reason: '目录发现达到预算限制。' }); return; }
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { gaps.push({ path: rel, reason: '目录不可读取。' }); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const names = new Set(entries.map(e => e.name));
    const git = entries.some(e => e.name === '.git' && (e.isDirectory() || e.isFile()));
    const markers = entries.filter(e => e.isFile() && MANIFESTS.has(e.name)).map(e => e.name);
    const sourceFiles = entries.filter(e => e.isFile() && SOURCE.test(e.name));
    const layout = names.has('src') || names.has('Source') || names.has('sources');
    const detected = git || markers.length || sourceFiles.length || layout;
    const kind = override === 'repo' ? 'repo' : override === 'module' ? 'module' : detected ? 'repo' : 'module';
    const details = { markers, git_marker: git, source_layout: layout, boundary: override ? 'USER' : git ? 'GIT' : detected ? 'SOURCE_HEURISTIC' : 'DIRECTORY' };
    if (names.has('.gitmodules')) { details.nested_repositories = 'NEEDS_BOUNDARY_REVIEW'; gaps.push({ path: rel, reason: '存在子模块声明；当前按一个 Repo 审计，需要分开时请显式调整模块边界。' }); }
    if (kind === 'module' && (sourceFiles.length || markers.length)) gaps.push({ path: rel, reason: '显式模块边界下的直属文件未单独登记为 Repo，请核对覆盖范围。' });
    const item = { relative_path: rel, parent_path: parent, path, name: basename(path), kind, source_kind: kind === 'repo' ? git ? 'git' : 'directory' : null, details };
    nodes.push(item);
    if (kind === 'repo') return;
    const children = entries.filter(e => e.isDirectory() && !SKIP.has(e.name));
    for (const entry of entries.filter(e => e.isSymbolicLink())) gaps.push({ path: `${rel}/${entry.name}`, reason: '目录发现未跟随符号链接。' });
    for (const child of children) await visit(join(path, child.name), depth + 1, rel);
    if (!children.length && !detected) { item.kind = 'candidate'; item.details.reason = '没有足够信息识别源码根，可手动设为 Repo 或忽略。'; }
  }
  await visit(base, 0, null);
  return { nodes, gaps, complete: gaps.length === 0, visited, elapsed_ms: Date.now() - started };
}

export async function sourceSnapshot(root, { maxFiles = 100000, maxBytes = 1024 * 1024 * 1024, maxMs = 120000, excludedRoots = [] } = {}) {
  const base = await realpath(root), files = [], gaps = [], excluded = [], started = Date.now(); let bytes = 0, entriesSeen = 0;
  async function visit(path) {
    if (excludedRoots.some(p => within(p, path))) { excluded.push({ path: relative(base, path), reason: 'NESTED_REPO' }); return; }
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { gaps.push({ path: relative(base, path), reason: '目录不可读取。' }); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path2 = join(path, entry.name), rel = relative(base, path2).split('\\').join('/');
      if (++entriesSeen > maxFiles * 3 || files.length >= maxFiles || bytes > maxBytes || Date.now() - started > maxMs) { gaps.push({ path: rel, reason: '源码基线达到预算限制。' }); return; }
      if (SKIP.has(entry.name) && entry.isDirectory()) { excluded.push({ path: rel, reason: 'DEPENDENCY_OR_BUILD' }); continue; }
      if (entry.isSymbolicLink()) { excluded.push({ path: rel, reason: 'SYMLINK_NOT_READ' }); continue; }
      if (entry.isDirectory()) { await visit(path2); continue; }
      if (!entry.isFile()) { excluded.push({ path: rel, reason: 'NON_REGULAR' }); continue; }
      let file;
      try {
        const before = await lstat(path2);
        check(!before.isSymbolicLink() && within(base, await realpath(path2)), '源码路径已变化。');
        if (before.size + bytes > maxBytes) { gaps.push({ path: rel, reason: '源码字节预算不足。' }); continue; }
        file = await open(path2, 'r');
        const opened = await file.stat();
        check(opened.ino === before.ino && opened.dev === before.dev && opened.isFile(), '源码文件身份已变化。');
        const { createHash } = await import('node:crypto'); const digest = createHash('sha256');
        let read = 0, newlines = 0, lastByte = null; const buffer = Buffer.alloc(128 * 1024);
        while (true) {
          const result = await file.read(buffer, 0, buffer.length, null); if (!result.bytesRead) break;
          read += result.bytesRead; check(read <= before.size && Date.now() - started <= maxMs, '读取期间文件变化或预算耗尽。'); digest.update(buffer.subarray(0, result.bytesRead));
          for (let i = 0; i < result.bytesRead; i++) if (buffer[i] === 10) newlines++; lastByte = buffer[result.bytesRead - 1];
        }
        const after = await file.stat(); const finalPath = await lstat(path2);
        check(read === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && finalPath.ino === before.ino && !finalPath.isSymbolicLink(), '读取期间源码变化。');
        files.push({ path: rel, sha256: digest.digest('hex'), size: read, line_count: newlines + (read && lastByte !== 10 ? 1 : 0) }); bytes += read;
      } catch (error) { gaps.push({ path: rel, reason: error.message }); }
      finally { await file?.close(); }
    }
  }
  await visit(base);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  let branchHint = null;
  try { const gitStat = await lstat(join(base, '.git')); if (gitStat.isDirectory() && !gitStat.isSymbolicLink()) branchHint = (await readFile(join(base, '.git', 'HEAD'), 'utf8')).trim().slice(0, 300); } catch {}
  const binding = { protocol: 'repo-source-snapshot.v1', files, excluded, gaps };
  return { ...binding, digest: hash(binding), source_root: base, branch_hint: branchHint, complete: gaps.length === 0, file_count: files.length, total_bytes: bytes };
}
