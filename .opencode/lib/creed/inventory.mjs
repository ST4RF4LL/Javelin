import { readFile, realpath, lstat } from 'node:fs/promises';
import { extname, resolve, relative, isAbsolute, sep } from 'node:path';
import { check, hash, digest, METHOD_VERSION } from './common.mjs';

export const EXTRACTOR_VERSION = 'creed-ast-grep.v1';
const LANGUAGES = {
  '.js': ['JavaScript', 'javascript', 'web'], '.mjs': ['JavaScript', 'javascript', 'web'], '.cjs': ['JavaScript', 'javascript', 'web'],
  '.jsx': ['Tsx', 'javascript', 'web'], '.ts': ['TypeScript', 'typescript', 'web'], '.mts': ['TypeScript', 'typescript', 'web'],
  '.cts': ['TypeScript', 'typescript', 'web'], '.tsx': ['Tsx', 'typescript', 'web'],
  '.java': ['java', 'java', 'java'], '.py': ['python', 'python', 'python'], '.pyi': ['python', 'python', 'python'], '.pyw': ['python', 'python', 'python'],
  '.c': ['c', 'c', 'c-cpp'], '.h': ['cpp', 'cpp', 'c-cpp'], '.cpp': ['cpp', 'cpp', 'c-cpp'], '.cc': ['cpp', 'cpp', 'c-cpp'],
  '.cxx': ['cpp', 'cpp', 'c-cpp'], '.hpp': ['cpp', 'cpp', 'c-cpp'], '.hh': ['cpp', 'cpp', 'c-cpp'], '.hxx': ['cpp', 'cpp', 'c-cpp'],
};
const FUNCTION_KINDS = new Set(['function_declaration', 'function_expression', 'generator_function_declaration', 'generator_function',
  'arrow_function', 'method_definition', 'function_definition', 'method_declaration', 'constructor_declaration',
  'compact_constructor_declaration', 'lambda_expression', 'lambda']);
let parserPromise;
export function normalizeCreedOptions(input = {}) {
  check(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => ['paths', 'symbols'].includes(key)), 'CREED 范围选项无效。');
  const values = (key, maximum) => {
    const rows = input[key] ?? [];
    check(Array.isArray(rows) && rows.length <= 200 && rows.every(row => typeof row === 'string' && row.trim() && row.length <= maximum && !/[\x00-\x1f\x7f]/u.test(row)), `CREED ${key} 必须为有效文本列表。`);
    return [...new Set(rows.map(row => row.trim()))];
  };
  const requested = values('paths', 1000).map(path => path.replaceAll('\\', '/'));
  check(requested.every(path => path && !isAbsolute(path) && !/^[a-z]:/i.test(path) && !path.split('/').includes('..') && !/[?*\[\]{}]/u.test(path)), 'CREED 路径须为源码根内的相对文件或目录，不支持通配符。');
  const paths = [...new Set(requested.map(path => path.split('/').filter(part => part && part !== '.').join('/') || '.'))];
  return { paths, symbols: values('symbols', 400) };
}
async function parser() {
  if (!parserPromise) parserPromise = (async () => {
    const api = await import('@ast-grep/napi'), registrations = {}, unavailable = new Set();
    for (const name of ['java', 'python', 'c', 'cpp']) {
      try { registrations[name] = { ...(await import(`@ast-grep/lang-${name}`)).default }; }
      catch { unavailable.add(name); }
    }
    if (Object.keys(registrations).length) api.registerDynamicLanguage(registrations);
    // A missing native grammar must remain a coverage gap, never a regex fallback.
    for (const name of Object.keys(registrations)) {
      try { api.parse(name, ''); } catch { unavailable.add(name); }
    }
    return { ...api, unavailable };
  })();
  return parserPromise;
}

export async function frozenFile(sourceRoot, file, maxBytes = 4 * 1024 * 1024) {
  check(typeof file.path === 'string' && file.path && !isAbsolute(file.path) && !file.path.split(/[\\/]/).includes('..'), 'CREED 源码路径必须位于冻结源码根内。');
  const root = await realpath(sourceRoot), path = resolve(root, file.path), info = await lstat(path);
  const actual = relative(root, await realpath(path));
  check(info.isFile() && !info.isSymbolicLink() && actual && actual !== '..' && !actual.startsWith(`..${sep}`) && !isAbsolute(actual), 'CREED 源码必须为范围内的普通文件。');
  check(info.size > 0 && info.size <= maxBytes, '源码为空或超过函数提取大小上限。', 'FILE_SIZE_LIMIT');
  const bytes = await readFile(path);
  check(bytes.length <= maxBytes && /^[a-f0-9]{64}$/i.test(file.sha256 ?? file.file_sha256 ?? '') && hash(bytes) === (file.sha256 ?? file.file_sha256), '源码摘要与冻结清单不一致。', 'SOURCE_CHANGED');
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { check(false, '源码不是有效 UTF-8，未进行有损转换。', 'SOURCE_ENCODING'); }
  check(!source.includes('\0'), '二进制内容不进行函数提取。', 'SOURCE_BINARY');
  return source;
}

function symbolName(node) {
  const own = node.field('name');
  if (own) return own.text();
  let declarator = node.field('declarator');
  for (let depth = 0; declarator && depth < 8; depth++) {
    const child = declarator.field('declarator');
    if (!child) return declarator.text().slice(0, 300);
    declarator = child;
  }
  const parent = node.parent();
  if (['variable_declarator', 'pair', 'assignment_expression'].includes(parent?.kind())) return (parent.field('name') ?? parent.field('key') ?? parent.field('left'))?.text() ?? null;
  return null;
}

export async function extractFunctions(source, { path, fileSha256 = hash(source), maxFunctionBytes = 48000 } = {}) {
  const language = LANGUAGES[extname(path).toLowerCase()];
  if (!language) return { functions: [], gaps: [{ path, code: 'UNSUPPORTED_LANGUAGE', reason: '当前 CREED 提取器尚不支持此源码语言。' }] };
  const api = await parser();
  check(!api.unavailable.has(language[0]), `缺少 ${language[1]} 函数解析库，请检查平台依赖安装。`, 'PARSER_UNAVAILABLE');
  const root = api.parse(language[0], source).root(), nodes = [], errors = [], stack = [root];
  let visited = 0;
  while (stack.length) {
    const node = stack.pop();
    check(++visited <= 500000, '源码语法树超过受控提取上限。', 'AST_SIZE_LIMIT');
    const range = node.range();
    if (node.kind() === 'ERROR' || range.start.index === range.end.index && node !== root) errors.push(range);
    if (FUNCTION_KINDS.has(node.kind()) && node.field('body')) nodes.push(node);
    const children = node.children();
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
  }
  const functions = [], gaps = errors.length ? [{ path, code: 'PARSE_ERROR', reason: '源码存在语法解析缺口，仅提取不与错误区域相交的完整函数。' }] : [];
  for (const node of nodes) {
    const wrapped = node.parent()?.kind() === 'decorated_definition' ? node.parent() : node;
    const range = wrapped.range(), code = wrapped.text();
    if (errors.some(error => error.start.index < range.end.index && error.end.index >= range.start.index)) continue;
    const startLine = range.start.line + 1, endLine = startLine + code.split('\n').length - 1;
    if (Buffer.byteLength(code) > maxFunctionBytes) { gaps.push({ path, start_line: startLine, end_line: endLine, code: 'FUNCTION_SIZE_LIMIT', reason: '完整函数超过单次分析上限，未截断或标为已分析。' }); continue; }
    // Validate offsets against the exact node text before persisting a source map.
    let startIndex = range.start.index, endIndex = range.end.index;
    if (source.slice(startIndex, endIndex) !== code) {
      // Older bindings expose UTF-8 byte indices. Preserve exact source, not guessed offsets.
      const bytes = Buffer.from(source), prefix = bytes.subarray(0, startIndex).toString('utf8');
      check(bytes.subarray(startIndex, endIndex).toString('utf8') === code, '解析器源码位置不能映射回原文件。', 'SOURCE_MAPPING');
      startIndex = prefix.length; endIndex = startIndex + code.length;
    }
    const sourceSha256 = hash(code), functionId = `function-${hash(`${path}\0${startIndex}\0${endIndex}\0${sourceSha256}`).slice(0, 32)}`;
    const symbol = (symbolName(node) || `<anonymous@${startLine}:${range.start.column + 1}>`).slice(0, 400);
    const containers = node.ancestors().filter(parent => ['class_declaration', 'class_definition', 'class_specifier', 'namespace_definition'].includes(parent.kind()))
      .map(parent => parent.field('name')?.text()).filter(Boolean).reverse();
    functions.push({ function_id: functionId, path, symbol, qualified_symbol: [...containers, symbol].join('.').slice(0, 400),
      language: language[1], domain: language[2], start_line: startLine, end_line: endLine, start_index: startIndex, end_index: endIndex,
      file_sha256: fileSha256, source_sha256: sourceSha256, extractor_version: EXTRACTOR_VERSION });
  }
  return { functions, gaps };
}

export async function buildCreedInventory({ sourceRoot, manifest, options = {}, maxFunctions = 5000, maxFunctionBytes = 48000 }) {
  check(manifest && Array.isArray(manifest.files) && typeof manifest.scope_digest === 'string', 'CREED 需要冻结的源码清单。');
  const selection = normalizeCreedOptions(options), maximum = maxFunctions;
  check(Number.isInteger(maximum) && maximum >= 1 && maximum <= 50000, 'CREED 函数数量上限无效。');
  const functions = [], gaps = [], files = [];
  for (const file of manifest.files) {
    if (file.type !== 'file' || file.review_required === false) continue;
    if (selection.paths.length && !selection.paths.some(path => path === '.' || file.path === path || file.path.startsWith(`${path}/`))) continue;
    if (['binary', 'documentation', 'configuration', 'web-resource', 'interface-spec', 'database-schema'].includes(file.content_kind)) {
      files.push({ path: file.path, status: 'NOT_APPLICABLE', function_ids: [], reason: '冻结清单将此文件分类为非函数源码。' }); continue;
    }
    try {
      if (!LANGUAGES[extname(file.path).toLowerCase()]) {
        files.push({ path: file.path, status: 'GAP', function_ids: [] });
        gaps.push({ path: file.path, code: 'UNSUPPORTED_LANGUAGE', reason: '当前 CREED 函数提取器未覆盖该语言；未计入已分析函数。' }); continue;
      }
      const source = await frozenFile(sourceRoot, file), extracted = await extractFunctions(source, { path: file.path, fileSha256: file.sha256, maxFunctionBytes });
      const selected = extracted.functions.filter(ref => !selection.symbols.length || selection.symbols.includes(ref.symbol) || selection.symbols.includes(ref.qualified_symbol));
      const accepted = selected.slice(0, Math.max(0, maximum - functions.length));
      if (accepted.length !== selected.length) extracted.gaps.push({ path: file.path, code: 'INVENTORY_LIMIT', reason: `已达到本轮 ${maximum} 个函数上限，另有 ${selected.length - accepted.length} 个函数未发布。`, omitted_functions: selected.length - accepted.length });
      functions.push(...accepted); gaps.push(...extracted.gaps);
      files.push({ path: file.path, file_sha256: file.sha256, status: extracted.gaps.length ? 'GAP' : 'ENUMERATED', function_ids: accepted.map(row => row.function_id), extracted_functions: extracted.functions.length });
    } catch (error) {
      gaps.push({ path: file.path, code: error.code ?? 'EXTRACTION_FAILED', reason: '函数提取失败：' + error.message });
      files.push({ path: file.path, status: 'GAP', function_ids: [] });
    }
  }
  const inventory = { protocol: 'creed-inventory.v1', method_version: METHOD_VERSION, extractor_version: EXTRACTOR_VERSION,
    scope_digest: manifest.scope_digest, options: selection, functions, gaps, files, complete: gaps.length === 0,
    summary: { functions: functions.length, files: files.length, gap_files: files.filter(row => row.status === 'GAP').length,
      omitted_functions: gaps.reduce((sum, row) => sum + (row.omitted_functions ?? 0), 0) } };
  return { ...inventory, inventory_digest: digest(inventory) };
}

export function creedTasks(inventory) {
  return inventory.functions.map(ref => ({ task_id: `creed-${ref.function_id.slice(9)}`, strategy_id: 'creed', kind: 'function', domain: ref.domain,
    source_ref: ref.function_id, source_refs: [{ strategy_id: 'creed', source_ref: ref.function_id }],
    code_refs: [{ path: ref.path, line: ref.start_line, symbol: ref.symbol }], creed: { protocol: 'creed.v1', function: ref },
    title: `${ref.symbol}：CREED 假设分析`.slice(0, 240), prompt: '分析此完整函数的行为、开发者安全假设、合理性与失效条件；外部条件未知时保留待核查项，不宣称动态验证。' }));
}

export async function readCreedFunction(sourceRoot, ref) {
  const source = await frozenFile(sourceRoot, { path: ref.path, sha256: ref.file_sha256 });
  check(Number.isInteger(ref.start_index) && Number.isInteger(ref.end_index) && ref.start_index >= 0 && ref.end_index > ref.start_index && ref.end_index <= source.length, 'CREED 函数范围无效。');
  const code = source.slice(ref.start_index, ref.end_index);
  check(hash(code) === ref.source_sha256 && source.slice(0, ref.start_index).split('\n').length === ref.start_line && ref.start_line + code.split('\n').length - 1 === ref.end_line, 'CREED 函数位置或内容与冻结清单不一致。', 'SOURCE_CHANGED');
  return code;
}
