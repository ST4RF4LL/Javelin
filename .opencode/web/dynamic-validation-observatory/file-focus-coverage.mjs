import { posix } from "node:path";

const error = message => Object.assign(new Error(message), { statusCode: 409 });

// Project references onto the frozen manifest only. Never read a source path
// supplied by a task or infer coverage from prompts, reports, or task completion.
function relativeReference(value, root) {
  if (typeof value !== "string" || !value || value.includes("\0")) return null;
  const path = value.replaceAll("\\", "/");
  const base = String(root ?? "").replaceAll("\\", "/").replace(/\/+$/, "");
  let relative = path;
  if (path.startsWith("/") || /^[a-z]:\//i.test(path)) {
    const normalized = posix.normalize(path);
    if (!base || !normalized.startsWith(`${base}/`)) return null;
    relative = normalized.slice(base.length + 1);
  }
  const normalized = posix.normalize(relative);
  return normalized === ".." || normalized.startsWith("../") || normalized === "." ? null : normalized;
}

export function fileFocusCoverage({ audit, manifest, board, offset = 0, limit = 100, q = "", association = "all" }) {
  if (manifest.audit_id !== audit.id || manifest.scope_digest !== audit.source_baseline.scope_digest || !Array.isArray(manifest.files)) {
    throw error("文件清单与本次审计的源码范围不一致，无法统计文件关联。");
  }
  if (board && (board.audit_id !== audit.id || board.scope_digest !== manifest.scope_digest)) {
    throw error("任务面板与文件清单的源码范围不一致，无法统计文件关联。");
  }
  const files = new Map();
  for (const file of manifest.files) {
    const path = relativeReference(file.path, manifest.root);
    if (!path || files.has(path)) throw error("文件清单包含无效或重复路径，无法统计文件关联。");
    files.set(path, { file_id: file.file_id, path, type: file.type, size: file.size ?? null,
      sha256: file.sha256 ?? null, content_kind: file.content_kind ?? null, focus_areas: [] });
  }
  const tasks = (board?.tasks ?? []).filter(task => task.kind === "focus_area");
  const unmatched = [];
  for (const task of tasks) {
    const linked = new Map();
    for (const ref of task.code_refs ?? []) {
      const path = relativeReference(ref.path, manifest.root), file = path && files.get(path);
      if (!file) {
        unmatched.push({ task_id: task.task_id, title: task.title, path: ref.path,
          reason: "未匹配到本次文件清单中的具体文件（目录或通配符不会自动标记其下所有文件）。" });
        continue;
      }
      if (!linked.has(path)) {
        const area = { task_id: task.task_id, title: task.title, domain: task.domain, status: task.status, locations: [] };
        linked.set(path, area); file.focus_areas.push(area);
      }
      const location = { line: ref.line ?? null, symbol: ref.symbol ?? null };
      const locations = linked.get(path).locations;
      if (!locations.some(item => item.line === location.line && item.symbol === location.symbol)) locations.push(location);
    }
  }
  const rows = [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const row of rows) row.association = row.focus_areas.length ? "associated" : "unassociated";
  const associated = rows.filter(row => row.association === "associated").length;
  const needle = String(q).trim().toLocaleLowerCase();
  const filtered = rows.filter(row => (association === "all" || row.association === association) && (!needle || row.path.toLocaleLowerCase().includes(needle)));
  const size = Math.min(200, Math.max(1, Math.floor(Number(limit) || 100)));
  const requested = Math.max(0, Math.floor(Number(offset) || 0));
  const start = Math.min(requested, Math.max(0, Math.ceil(filtered.length / size) - 1) * size);
  return {
    protocol: "file-focus-coverage.v1", audit_id: audit.id, available: true,
    scope_digest: manifest.scope_digest, inventory_complete: manifest.complete === true,
    association_available: Boolean(board), publication: board?.publication?.state ?? null,
    summary: { total_files: rows.length, associated_files: associated, unassociated_files: rows.length - associated,
      association_percentage: rows.length ? Math.round(associated / rows.length * 10000) / 100 : 0,
      focus_areas: tasks.length, unlocated_focus_areas: tasks.filter(task => !task.code_refs?.length).length,
      unmatched_references: unmatched.length, exclusions: manifest.exclusions?.length ?? 0, inventory_errors: manifest.errors?.length ?? 0 },
    unmatched_references: unmatched.slice(0, 100),
    total: filtered.length, offset: start, limit: size, items: filtered.slice(start, start + size),
    next_offset: start + size < filtered.length ? start + size : null,
  };
}
