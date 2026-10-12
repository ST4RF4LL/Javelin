import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const check = (ok, message) => { if (!ok) throw Object.assign(new Error(message), { statusCode: 422 }); };
const digest = value => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
export const SWEEP_PROTOCOL = "file-sweep.v1";
export const SWEEP_STATES = ["PENDING", "READING", "BROWSED", "GAP", "EXCLUDED"];
const terminal = new Set(["BROWSED", "GAP", "EXCLUDED"]);
export const taskKindForStrategy = strategy => strategy === "file_sweep" ? "focus_area" : strategy;

export function createFileSweep(manifest, board) {
  check(manifest.audit_id === board.audit_id && manifest.scope_digest === board.scope_digest && manifest.complete === true && Array.isArray(manifest.files), "逐文件清单必须完整且绑定本次冻结源码范围。");
  const ids = new Set(), paths = new Set();
  const files = manifest.files.map(file => {
    check(typeof file.file_id === "string" && !ids.has(file.file_id) && typeof file.path === "string" && file.path && !isAbsolute(file.path) && !/^[a-z]:/i.test(file.path) && !file.path.includes("\\") && !file.path.split("/").some(part => ["..", ".", ""].includes(part)) && !paths.has(file.path), "文件清单包含无效或重复标识／路径。");
    ids.add(file.file_id); paths.add(file.path);
    const excluded = file.type !== "file" || file.content_kind === "binary";
    check(excluded || /^[a-f0-9]{64}$/.test(file.sha256 ?? ""), "文本文件缺少冻结摘要。");
    return { file_id: file.file_id, path: file.path, sha256: file.sha256 ?? null, size: file.size ?? null,
      content_kind: file.content_kind ?? "unknown-text", status: excluded ? "EXCLUDED" : "PENDING",
      reason: excluded ? file.type !== "file" ? "符号链接或非普通文件不跟随读取。" : "二进制文件不进入逐文件文本浏览。" : null,
      attempt_id: null, read_ranges: [], line_count: null, summary: null, task_ids: [] };
  });
  return { protocol: SWEEP_PROTOCOL, scope_digest: manifest.scope_digest, manifest_digest: digest(JSON.stringify(manifest)),
    policy: manifest.policy ?? {}, exclusions: manifest.exclusions ?? [], files };
}

export function sweepSummary(board) {
  const sweep = board.file_sweep;
  if (!sweep) return null;
  const count = status => sweep.files.filter(file => file.status === status).length;
  const total = sweep.files.length - count("EXCLUDED"), browsed = count("BROWSED"), gap = count("GAP");
  return { protocol: SWEEP_PROTOCOL, total_files: sweep.files.length, eligible_files: total, browsed_files: browsed,
    pending_files: count("PENDING"), reading_files: count("READING"), gap_files: gap, excluded_files: count("EXCLUDED"),
    scope_exclusions: sweep.exclusions.length, complete: sweep.files.every(file => terminal.has(file.status)),
    browse_percentage: total ? Math.round(browsed / total * 10000) / 100 : 0,
    published_areas: board.tasks.length, linked_files: sweep.files.filter(file => file.task_ids.length).length };
}

function ledger(board, open = true) {
  check(board.mining_strategy === "file_sweep" && board.file_sweep?.protocol === SWEEP_PROTOCOL, "当前任务未初始化逐文件浏览清单。");
  if (open) check(board.publication.state === "OPEN" && !board.final_report, "文件浏览发布阶段已经封存。");
  return board.file_sweep;
}
export function filePage(board, { status = "all", offset = 0, limit = 25 } = {}) {
  const sweep = ledger(board, false);
  check(status === "all" || SWEEP_STATES.includes(status), "文件浏览状态无效。");
  const rows = sweep.files.filter(file => status === "all" || file.status === status);
  const start = Math.max(0, Math.floor(Number(offset) || 0)), size = Math.min(100, Math.max(1, Math.floor(Number(limit) || 25)));
  return { summary: sweepSummary(board), total: rows.length, items: rows.slice(start, start + size), next_offset: start + size < rows.length ? start + size : null };
}
export function claimFile(board, { file_id: id } = {}) {
  const sweep = ledger(board);
  const file = id ? sweep.files.find(row => row.file_id === id) : sweep.files.find(row => row.status === "PENDING");
  if (!file && !id) return null;
  check(file && ["PENDING", "READING"].includes(file.status), "文件不存在或已经完成浏览记录。");
  if (file.status === "PENDING") Object.assign(file, { status: "READING", attempt_id: `browse-${randomUUID()}`, started_at: now() });
  return structuredClone(file);
}
function activeFile(board, input) {
  const file = ledger(board).files.find(row => row.file_id === input.file_id);
  check(file?.status === "READING" && file.attempt_id === input.attempt_id, "文件浏览尝试已失效，请重新领取。");
  return file;
}

// Only server-read ranges count as browsing evidence. A range is not a claim of semantic review.
export async function readFilePage(board, sourceRoot, input) {
  const file = activeFile(board, input);
  const root = await realpath(sourceRoot), path = resolve(root, file.path);
  const within = value => { const rel = relative(root, value); return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
  check(within(path), "文件路径超出冻结源码根。");
  const info = await lstat(path);
  check(info.isFile() && !info.isSymbolicLink() && within(await realpath(path)), "源码已变化或链接超出冻结范围。");
  check(info.size <= 32 * 1024 * 1024, "文件超过 32 MiB 浏览上限，请记录具体缺口。");
  const bytes = await readFile(path);
  check(digest(bytes) === file.sha256, "源码文件摘要已变化，不得将新内容计入本轮浏览。");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw Object.assign(new Error("文件不是有效 UTF-8，请记录编码缺口。"), { statusCode: 422 }); }
  const lines = text ? text.split(/\r?\n/) : [];
  if (text.endsWith("\n")) lines.pop();
  const start = input.start_line ?? 1, limit = input.limit ?? 120;
  check(Number.isInteger(start) && start >= 1 && start <= Math.max(1, lines.length) && Number.isInteger(limit) && limit >= 1 && limit <= 300, "读取行范围无效（每次最多 300 行）。");
  const selected = []; let length = 0;
  for (const line of lines.slice(start - 1, start - 1 + limit)) {
    if (length + line.length > 64_000) break;
    selected.push(line); length += line.length + 1;
  }
  check(!lines.length || selected.length, "单行超过浏览响应上限，请记录超长行缺口。");
  const end = lines.length ? start + selected.length - 1 : 0;
  return { file_id: file.file_id, attempt_id: file.attempt_id, path: file.path, sha256: file.sha256,
    start_line: lines.length ? start : 0, end_line: end, line_count: lines.length,
    next_line: end < lines.length ? end + 1 : null, content: selected.map((line, index) => `${start + index}: ${line}`).join("\n") };
}
export function recordFileRead(board, page) {
  const file = activeFile(board, page);
  file.line_count = page.line_count;
  const ranges = [...file.read_ranges, ...(page.line_count ? [[page.start_line, page.end_line]] : [])].sort((a, b) => a[0] - b[0]);
  file.read_ranges = [];
  for (const range of ranges) {
    const last = file.read_ranges.at(-1);
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]); else file.read_ranges.push(range);
  }
}
export function completeFile(board, input) {
  const existing = ledger(board).files.find(row => row.file_id === input.file_id);
  const outcome = input.outcome, summary = typeof input.summary === "string" ? input.summary.trim() : null, taskIds = input.task_ids ?? [];
  check(["BROWSED", "GAP"].includes(outcome) && typeof summary === "string" && summary.length > 0 && summary.length <= 6000, "浏览结果必须为 BROWSED/GAP，并提供具体中文判断或缺口。");
  check(Array.isArray(taskIds) && taskIds.length <= 100 && taskIds.every(id => typeof id === "string") && new Set(taskIds).size === taskIds.length, "关联 Focus Area 编号无效。");
  check(taskIds.every(id => board.tasks.some(task => task.task_id === id)), "关联的 Focus Area 尚未上榜，请先发布。");
  if (existing?.attempt_id === input.attempt_id && ["BROWSED", "GAP"].includes(existing.status)) {
    check(existing.status === outcome && existing.summary === summary && JSON.stringify(existing.task_ids) === JSON.stringify(taskIds), "重复浏览结果与已接收结果不同。");
    return { recorded: true, duplicate: true };
  }
  const file = activeFile(board, input);
  if (outcome === "BROWSED") check(file.line_count === 0 || file.line_count !== null && file.read_ranges.length === 1 && file.read_ranges[0][0] === 1 && file.read_ranges[0][1] === file.line_count, "文件尚未完整读取，不得标为已浏览；请继续分页读取或记录 GAP。");
  const generated = board.tasks.filter(task => task.source_ref === file.file_id);
  check(generated.every(task => taskIds.includes(task.task_id)), "浏览记录遗漏了本文件已经发布的 Focus Area。");
  Object.assign(file, { status: outcome, summary, task_ids: taskIds, reason: outcome === "GAP" ? summary : null, completed_at: now() });
  return { recorded: true };
}
export function assertSweepSealable(board) {
  if (board.mining_strategy !== "file_sweep") return;
  const sweep = ledger(board);
  check(sweepSummary(board).complete, "仍有未完成浏览的文件，请继续处理或明确登记缺口，不能提前结束发布。");
  check(board.tasks.every(task => sweep.files.some(file => file.task_ids.includes(task.task_id))), "存在未关联浏览记录的 Focus Area，不能封存发布。");
}
