import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson, check, controlledBytes, digest, hash } from "./contract.mjs";
import { claimFile, completeFile, readFilePage, recordFileRead } from "./file-sweep.mjs";
import { estimateTokens } from "./review-batches.mjs";

export const FILE_BATCH_PROTOCOL = "file-screening-batches.v1";
const compactTask = task => ({ task_id: task.task_id, title: task.title, domain: task.domain, code_refs: task.code_refs.slice(0, 8),
  code_refs_total: task.code_refs.length, root_cause: task.root_cause });
const configFile = path => /(?:^|\/)(?:[^/]*\.(?:json|jsonc|toml|ya?ml|lock)|[^/]*config[^/]*|\.env[^/]*|requirements[^/]*\.txt|[^/]*settings\.py)$/i.test(path);

// Reuse source facts only. Every file is still read in the current audit; cached
// findings, prior verdicts and old task IDs never substitute for that work.
export class FileFactsCache {
  constructor({ root, rulesDigest }) { this.root = root; this.rulesDigest = rulesDigest; }
  context(board) {
    return digest((board.file_sweep?.files ?? []).filter(file => configFile(file.path)).map(file => [file.path, file.sha256]).sort());
  }
  path(file) { return join(this.root, `${hash(file.path)}.${file.sha256}.${this.rulesDigest}.json`); }
  async get(file, board, sourceRoot) {
    try {
      const value = JSON.parse(await readFile(this.path(file), "utf8"));
      if (value.protocol !== FILE_BATCH_PROTOCOL || value.sha256 !== file.sha256 || value.path !== file.path
        || value.rules_digest !== this.rulesDigest || value.context_digest !== this.context(board)) return null;
      for (const dep of value.dependencies) {
        if (!board.file_sweep.files.some(row => row.path === dep.path && row.sha256 === dep.sha256)) return null;
        if (hash(await controlledBytes(sourceRoot, dep.path, 32 * 1024 * 1024)) !== dep.sha256) return null;
      }
      return { facts: value.facts, source_audit_id: value.audit_id, dependencies: value.dependencies };
    } catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError || error.statusCode === 422) return null; throw error; }
  }
  async put(file, board, input) {
    if (!input.facts) return;
    check(typeof input.facts === "object" && !Array.isArray(input.facts) && JSON.stringify(input.facts).length <= 4000, "文件事实记录须为不超过 4000 字符的对象。");
    const facts = Object.fromEntries(["responsibility", "inputs", "sensitive_operations", "controls"].filter(key => input.facts[key] != null).map(key => [key, input.facts[key]]));
    if (!Object.keys(facts).length) return;
    check(Array.isArray(input.related_files ?? []) && (input.related_files ?? []).length <= 40, "文件事实最多关联 40 个源码依赖。");
    const dependencies = [...new Set(input.related_files ?? [])].map(path => {
      const dependency = board.file_sweep.files.find(row => row.path === path);
      check(dependency?.sha256, "关联文件必须属于冻结的源码范围。");
      return { path, sha256: dependency.sha256 };
    });
    await atomicJson(this.path(file), { protocol: FILE_BATCH_PROTOCOL, audit_id: board.audit_id, path: file.path, sha256: file.sha256,
      rules_digest: this.rulesDigest, context_digest: this.context(board), dependencies, facts });
  }
}

export async function nextFileBatch(store, sourceRoot, { target_tokens = 12_000, max_files = 20 } = {}, cache = null) {
  check(Number.isInteger(target_tokens) && target_tokens >= 1000 && target_tokens <= 24_000, "文件批次输入预算须为 1000 至 24000 个估算 token。");
  check(Number.isInteger(max_files) && max_files >= 1 && max_files <= 20, "每批最多领取 20 个文件。");
  return store.mutate(async board => {
    check(board.file_sweep && board.publication.state === "OPEN", "文件浏览阶段不存在或已经封存。");
    const selected = board.file_sweep.files.filter(row => row.status === "PENDING");
    const files = []; let used = 0;
    for (const candidate of selected) {
      if (files.length >= max_files || files.length && target_tokens - used < 500) break;
      const file = claimFile(board, { file_id: candidate.file_id });
      const record = board.file_sweep.files.find(row => row.file_id === file.file_id);
      const start = record.resume_note && record.reviewed_through ? record.reviewed_through + 1 : 1;
      try {
        const page = await readFilePage(board, sourceRoot, { ...file, start_line: start, limit: 10_000 }, { maximumLines: 10_000 });
        let cachedFacts = null;
        if (cache) try { cachedFacts = await cache.get(file, board, sourceRoot); } catch { /* A cache failure never blocks fresh source review. */ }
        const related = board.tasks.filter(task => task.code_refs.some(ref => ref.path === file.path)).slice(0, 8).map(compactTask);
        const entry = { ...page, content: "", resume_note: record.resume_note ?? null, cached_facts: cachedFacts,
          related_task_ids: related.map(task => task.task_id), related_tasks: related };
        // Source and continuation notes take precedence over optional hints.
        const remaining = target_tokens - used;
        if (estimateTokens(entry) > remaining / 2) entry.cached_facts = null;
        while (entry.related_tasks.length && estimateTokens(entry) > remaining / 2) entry.related_tasks.pop();
        if (files.length && estimateTokens(entry) + 200 > remaining) { record.status = "PENDING"; record.attempt_id = null; break; }
        const lines = page.content ? page.content.split("\n") : [];
        let count = 0, cost = estimateTokens(entry) + 100;
        while (count < lines.length) {
          const next = estimateTokens(lines[count]) + 1;
          if (count && cost + next + used > target_tokens) break;
          cost += next; count++;
        }
        page.content = lines.slice(0, count).join("\n");
        page.end_line = page.line_count ? start + count - 1 : 0;
        page.next_line = page.end_line < page.line_count ? page.end_line + 1 : null;
        recordFileRead(board, page); record.last_chunk_end = page.end_line; delete record.read_error;
        Object.assign(entry, page);
        used += estimateTokens(entry); files.push(entry);
      } catch (error) {
        record.read_error = String(error.message).slice(0, 1000);
        files.push({ file_id: file.file_id, attempt_id: file.attempt_id, path: file.path, read_error: record.read_error });
      }
    }
    return { protocol: FILE_BATCH_PROTOCOL, files, estimated_tokens: used,
      pending_files: board.file_sweep.files.filter(row => row.status === "PENDING").length,
      reading_files: board.file_sweep.files.filter(row => row.status === "READING").length,
      instruction: "本批使用全新短会话。初筛只保存紧凑事实和疑点，后续深入分析交给 Focus Area worker。完整文件提交 BROWSED；未读完提交 CONTINUE 与 resume_note；预算不足提交 DEFERRED 并请求 defer。历史事实仅供定位，不能替代当前源码判断。" };
  });
}

export async function completeFileBatch(store, sourceRoot, { results } = {}, cache = null) {
  check(Array.isArray(results) && results.length > 0 && results.length <= 20 && new Set(results.map(row => row.file_id)).size === results.length, "批次提交须包含 1 至 20 个不同文件。");
  const cached = [];
  const result = await store.mutate(async board => {
    const recorded = [];
    for (const input of results) {
      const file = board.file_sweep?.files.find(row => row.file_id === input.file_id);
      check(file && file.attempt_id === input.attempt_id, "文件批次尝试已失效。");
      if (["BROWSED", "GAP"].includes(file.status)) { completeFile(board, input); recorded.push(file.file_id); continue; }
      check(file.status === "READING", "文件不在本次浏览尝试中。");
      if (["CONTINUE", "DEFERRED"].includes(input.outcome)) {
        if (input.outcome === "CONTINUE") {
          check(file.last_chunk_end > 0 && file.last_chunk_end < file.line_count && typeof input.resume_note === "string" && input.resume_note.trim() && input.resume_note.length <= 2000,
            "分段继续须保存不超过 2000 字符的源码事实、疑点和未完成项；到文件末尾请提交浏览结果。");
          file.resume_note = input.resume_note.trim(); file.reviewed_through = file.last_chunk_end;
        }
        file.status = "PENDING"; file.attempt_id = null;
      } else {
        if (input.outcome === "BROWSED") await readFilePage(board, sourceRoot, { ...input, start_line: 1, limit: 1 });
        completeFile(board, input);
        if (input.outcome === "BROWSED" && input.facts) cached.push({ file: structuredClone(file), input });
      }
      recorded.push(file.file_id);
    }
    return { recorded };
  });
  const warnings = [];
  if (cache) for (const row of cached) try { await cache.put(row.file, store.snapshot(), row.input); } catch (error) { warnings.push(`${row.file.path}：事实缓存未保存，${error.message}`); }
  return { ...result, ...(warnings.length ? { warnings } : {}) };
}

export function relatedTasks(board, { paths = [], root_cause = null, task_id = null, offset = 0 } = {}) {
  check(Array.isArray(paths) && paths.length <= 40 && paths.every(path => typeof path === "string"), "查询最多提供 40 个文件路径。");
  check(root_cause === null || root_cause && typeof root_cause === "object" && ["path", "symbol", "weakness", "trust_boundary", "preconditions"].every(key => typeof root_cause[key] === "string"), "根因查询须包含文件、符号、弱点、边界与前提文本。");
  check(task_id === null || typeof task_id === "string" && task_id.trim(), "指定任务查询须提供任务编号。");
  const matches = board.tasks.filter(task => task_id ? task.task_id === task_id : root_cause && task.root_cause && ["path", "symbol", "weakness", "trust_boundary", "preconditions"].every(key => task.root_cause[key] === root_cause[key].trim())
    || task.code_refs.some(ref => paths.includes(ref.path)));
  const start = Math.max(0, Number(offset) || 0);
  return { total: matches.length, items: matches.slice(start, start + 20).map(task => ({ ...compactTask(task), ...(task_id ? { code_refs: task.code_refs } : {}) })), next_offset: start + 20 < matches.length ? start + 20 : null };
}
