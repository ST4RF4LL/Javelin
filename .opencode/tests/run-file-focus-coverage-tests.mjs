import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileFocusCoverage } from "../web/dynamic-validation-observatory/file-focus-coverage.mjs";
import { AuditRunner } from "../web/dynamic-validation-observatory/audit-runner.mjs";

const id = "audit-file-coverage", scope = "a".repeat(64);
const audit = { id, source_baseline: { scope_digest: scope } };
const manifest = { audit_id: id, root: "/project", scope_digest: scope, complete: true, exclusions: [], errors: [],
  files: ["src/auth.py", "src/auth-extra.py", "README.md", "images/icon.png"].map((path, index) => ({ file_id: `file:${index}`, path, type: "file", sha256: "b".repeat(64) })) };
const task = (task_id, paths, extra = {}) => ({ task_id, title: `专项 ${task_id}`, kind: "focus_area", domain: "python", status: "PENDING", code_refs: paths.map(path => ({ path, line: 10 })), ...extra });
const board = tasks => ({ protocol: "task-board.v1", audit_id: id, scope_digest: scope, tasks, api_sources: [], publication: { state: "OPEN" } });

test("完整清单默认灰色；同文件多定位和多 Focus Area 只计一次，任务状态不影响黄色关联", () => {
  const result = fileFocusCoverage({ audit, manifest, board: board([
    task("one", ["src/auth.py", "./src/auth.py"], { status: "GAP" }),
    task("two", ["/project/src/auth.py"], { status: "FAILED" }),
    task("api", ["src/auth-extra.py"], { kind: "api" }),
  ]) });
  assert.equal(result.summary.total_files, 4); assert.equal(result.summary.associated_files, 1);
  assert.equal(result.summary.unassociated_files, 3); assert.equal(result.summary.association_percentage, 25);
  assert.equal(result.items.find(file => file.path === "src/auth.py").focus_areas.length, 2);
  assert.equal(result.items.find(file => file.path === "src/auth.py").focus_areas[0].locations.length, 1);
  assert.equal(result.items.find(file => file.path === "src/auth-extra.py").association, "unassociated");
  assert.equal(result.items.find(file => file.path === "images/icon.png").association, "unassociated");
});

test("跨平台路径精确匹配，目录、通配符、前缀相似路径和越界引用不会涂黄文件", () => {
  const result = fileFocusCoverage({ audit, manifest: { ...manifest, root: "C:\\project" }, board: board([
    task("refs", ["C:\\project\\src\\auth.py", "src/", "src/*.py", "../src/auth-extra.py", "C:\\project-other\\README.md"]),
    task("missing", []),
  ]) });
  assert.equal(result.summary.associated_files, 1); assert.equal(result.summary.unmatched_references, 4);
  assert.equal(result.summary.unlocated_focus_areas, 1);
});

test("搜索、关联筛选、分页不改变全局分母；越界页回落，空结果正常返回", () => {
  const fixture = { audit, manifest, board: board([task("one", ["src/auth.py"])]) };
  const result = fileFocusCoverage({ ...fixture, q: "SRC/", limit: 1, offset: 999 });
  assert.equal(result.total, 2); assert.equal(result.offset, 1); assert.equal(result.items.length, 1);
  assert.equal(result.summary.total_files, 4); assert.equal(result.summary.associated_files, 1);
  const yellow = fileFocusCoverage({ ...fixture, association: "associated" });
  assert.equal(yellow.total, 1); assert.equal(yellow.items[0].path, "src/auth.py");
  const empty = fileFocusCoverage({ ...fixture, q: "does-not-exist" });
  assert.equal(empty.total, 0); assert.equal(empty.next_offset, null); assert.equal(empty.offset, 0);
});

test("其他审计或源码版本的面板不能混入；重复文件清单拒绝统计", () => {
  assert.throws(() => fileFocusCoverage({ audit, manifest, board: { ...board([]), audit_id: "other" } }), /不一致/);
  assert.throws(() => fileFocusCoverage({ audit, manifest: { ...manifest, scope_digest: "other" }, board: board([]) }), /不一致/);
  assert.throws(() => fileFocusCoverage({ audit, manifest: { ...manifest, files: [...manifest.files, manifest.files[0]] }, board: board([]) }), /重复/);
});

test("历史任务无关联数据时明确区分未知与零关联", () => {
  const result = fileFocusCoverage({ audit, manifest, board: null });
  assert.equal(result.association_available, false); assert.equal(result.items.length, 4);
  const empty = fileFocusCoverage({ audit, manifest, board: board([]) });
  assert.equal(empty.association_available, true); assert.equal(empty.summary.associated_files, 0);
});

test("Runner 只读投影，重复读取能看到新发布定位，不启动任务或改写源码/面板", async t => {
  const root = await mkdtemp(join(tmpdir(), "file-focus-coverage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baselinePath = join(root, "baseline.json"), boardPath = join(root, "board.json");
  await writeFile(baselinePath, JSON.stringify(manifest)); await writeFile(boardPath, JSON.stringify(board([])));
  const row = { ...audit, paths: { reports_root: root }, source_baseline: { ...audit.source_baseline, path: baselinePath }, task_protocol: "task-board.v1", task_board_path: boardPath };
  const receiver = { audits: new Map([[id, row]]) };
  const load = options => AuditRunner.prototype.fileCoveragePage.call(receiver, id, options);
  const bytes = await readFile(baselinePath, "utf8");
  assert.equal((await load()).summary.associated_files, 0);
  await writeFile(boardPath, JSON.stringify(board([task("added", ["src/auth.py"])])));
  const before = await readFile(boardPath, "utf8");
  const result = await load({ audit: "untrusted-query", manifest: "untrusted-query", board: "untrusted-query" });
  assert.equal(result.summary.associated_files, 1);
  assert.equal(await readFile(baselinePath, "utf8"), bytes); assert.equal(await readFile(boardPath, "utf8"), before);
  row.source_baseline = null;
  assert.equal((await load()).available, false);
  await assert.rejects(() => AuditRunner.prototype.fileCoveragePage.call(receiver, "missing"), /未找到/);
});
