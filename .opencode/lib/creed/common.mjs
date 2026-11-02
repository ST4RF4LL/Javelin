import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const METHOD_VERSION = 'creed-assumptions.v1';
export const PROMPT_VERSION = 'creed-zh.v2';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const digest = value => hash(JSON.stringify(value));
export function check(condition, message, code = 'creed-invalid') {
  if (!condition) throw Object.assign(new Error(message), { code, statusCode: 422 });
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
