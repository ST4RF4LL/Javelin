import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, lstat, realpath, readFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';

export const PROTOCOL = 'product-memory.v1';
export const now = () => new Date().toISOString();
export const uid = kind => `${kind}-${randomUUID()}`;
export function check(value, message, statusCode = 422, code = 'product-memory-invalid') {
  if (!value) throw Object.assign(new Error(message), { statusCode, code });
}
export function text(value, label, max = 4000, optional = false) {
  check(typeof value === 'string' && !value.includes('\0') && value.length <= max && (optional || value.trim()), `${label}无效。`);
  return value.trim();
}
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, stable(value[k])]));
  return value;
}
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(stable(value))).digest('hex');
export const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
export function page(input = {}) {
  const limit = Number(input.limit ?? 30), offset = Number(input.offset ?? 0);
  check(Number.isInteger(limit) && limit > 0 && limit <= 100 && Number.isInteger(offset) && offset >= 0, '分页参数无效。');
  return { limit, offset };
}
export function within(root, path, allowRoot = true) {
  const rel = relative(resolve(root), resolve(path));
  return (allowRoot || rel !== '') && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function relativePath(path) {
  check(typeof path === 'string' && path && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0') && path.split('/').every(p => p && p !== '..' && p !== '.'), '位置必须使用源码范围内的相对路径。');
  return path;
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
export async function readBound(root, reference, max = 8 * 1024 * 1024) {
  relativePath(reference.path);
  const path = resolve(root, reference.path), base = await realpath(root);
  const stat = await lstat(path);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= max && within(base, await realpath(path), false), '证据路径、大小或类型无效。');
  const bytes = await readFile(path);
  check(bytes.length <= max && hash(bytes) === reference.sha256, '证据内容与摘要不一致。');
  return bytes;
}
