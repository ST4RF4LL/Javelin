import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, isAbsolute, parse, relative, resolve } from "node:path";

export const UNDEFINED_PRODUCT_ID = "product-undefined";
const PRODUCT_ID = /^product-(?:undefined|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const TARGET_ID = /^(?:project-[a-f0-9]{12}|target-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const LEGACY_TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCOPE_ID = /^scope-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GLOB_INVALID = /(^\/|\\|(^|\/)\.\.?($|\/)|\{[^}]*\}|[!]|\*\*[^/]|[^/]\*\*)/;
const DEFAULT_LIMIT = 20;
const LIMITS = new Set([20, 30, 50, 100]);

function error(message, statusCode = 422, code = "product-input-invalid") {
  return Object.assign(new Error(message), { statusCode, code });
}

function now() { return new Date().toISOString(); }
function json(value, fallback = []) { try { return JSON.parse(value ?? JSON.stringify(fallback)); } catch { return fallback; } }
function normalizedText(value, label, maximum, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw error(`${label}不能为空。`);
    return "";
  }
  if (typeof value !== "string") throw error(`${label}必须是文本。`);
  const result = value.replace(/\r\n?/g, "\n").trim();
  if (required && !result) throw error(`${label}不能为空。`);
  if (result.length > maximum) throw error(`${label}不能超过 ${maximum} 个字符。`);
  if (result.includes("\0")) throw error(`${label}包含不允许的空字符。`);
  return result;
}
function normalizedTags(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw error("标签必须是数组。");
  const result = [...new Set(value.map(item => normalizedText(item, "标签", 60, { required: true })))];
  if (result.length > 20) throw error("标签最多 20 个。");
  return result;
}
function normalizedPatterns(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw error(`${label}必须是数组。`);
  if (value.length > 200) throw error(`${label}最多 200 条。`);
  return [...new Set(value.map(item => {
    const pattern = normalizedText(item, label, 512, { required: true }).normalize("NFC");
    if (GLOB_INVALID.test(pattern) || pattern.split("/").some(part => part === "" || part === "." || part === "..")) {
      throw error(`${label}包含不支持的范围模式：${pattern}`, 422, "scope-pattern-invalid");
    }
    return pattern;
  }))];
}
function pageInput(input = {}) {
  const page = Number(input.page ?? 1);
  const limit = Number(input.page_size ?? DEFAULT_LIMIT);
  if (!Number.isInteger(page) || page < 1 || !LIMITS.has(limit)) throw error("分页参数无效。", 422, "product-pagination-invalid");
  return { page, limit };
}
function toProduct(row) {
  if (!row) return null;
  const { tags_json: _tags, ...value } = row;
  return { ...value, system: Boolean(row.system), tags: json(row.tags_json), archived_at: row.archived_at ?? null };
}
function toScope(row) {
  return { id: row.id, name: row.name, path: row.path, include_patterns: json(row.include_patterns_json), exclude_patterns: json(row.exclude_patterns_json), role: row.role ?? "", description: row.description ?? "" };
}
function toTarget(row, scopes = []) {
  if (!row) return null;
  return {
    id: row.id,
    product_id: row.product_id,
    name: row.name,
    description: row.description ?? "",
    tags: json(row.tags_json),
    version_label: row.version_label ?? "",
    test_focus: row.test_focus ?? "",
    relationship_notes: row.relationship_notes ?? "",
    status: row.status,
    availability: row.availability ?? "unknown",
    availability_checked_at: row.availability_checked_at ?? null,
    availability_error: row.availability_error ?? null,
    origin: row.origin,
    storage_namespace: row.storage_namespace,
    version: row.version,
    operation_epoch: row.operation_epoch,
    ownership_generation: row.ownership_generation,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at ?? null,
    source_scopes: scopes,
  };
}
function targetSnapshot(target) {
  return {
    schema_version: 1,
    target_id: target.id,
    target_name: target.name,
    product_id: target.product_id,
    storage_namespace: target.storage_namespace,
    target_version: target.version,
    operation_epoch: target.operation_epoch,
    ownership_generation: target.ownership_generation,
    version_label: target.version_label,
    test_focus: target.test_focus,
    relationship_notes: target.relationship_notes,
    source_scopes: target.source_scopes.map(scope => ({
      id: scope.id,
      name: scope.name,
      path: scope.path,
      include_patterns: scope.include_patterns,
      exclude_patterns: scope.exclude_patterns,
      role: scope.role,
      description: scope.description,
    })),
  };
}
function snapshotDigest(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export class ProductStore {
  constructor({ path, platformRoot = null } = {}) {
    if (!path) throw new TypeError("产品目录库需要 path。");
    this.path = resolve(path);
    this.platformRoot = platformRoot ? resolve(platformRoot) : null;
    this.db = null;
    this.ready = this.initialize();
  }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path, { enableForeignKeyConstraints: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', tags_json TEXT NOT NULL DEFAULT '[]',
        system INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('active','archived')), version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS audit_targets (
        id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]', version_label TEXT NOT NULL DEFAULT '', test_focus TEXT NOT NULL DEFAULT '', relationship_notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('active','archived')), origin TEXT NOT NULL CHECK(origin IN ('ui','startup','legacy','temporary')),
        storage_namespace TEXT NOT NULL UNIQUE, version INTEGER NOT NULL DEFAULT 1, operation_epoch INTEGER NOT NULL DEFAULT 1,
        ownership_generation INTEGER NOT NULL DEFAULT 1, availability TEXT NOT NULL DEFAULT 'unknown' CHECK(availability IN ('available','unavailable','unknown')),
        availability_checked_at TEXT, availability_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS audit_targets_product_updated ON audit_targets(product_id, status, updated_at DESC, id);
      CREATE TABLE IF NOT EXISTS source_scopes (
        id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES audit_targets(id) ON DELETE CASCADE,
        name TEXT NOT NULL, path TEXT NOT NULL, include_patterns_json TEXT NOT NULL DEFAULT '[]', exclude_patterns_json TEXT NOT NULL DEFAULT '[]',
        role TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(target_id, name), UNIQUE(target_id, path)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS audit_target_links (
        audit_id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES audit_targets(id), product_id_at_creation TEXT NOT NULL,
        product_name_at_creation TEXT NOT NULL, snapshot_json TEXT NOT NULL, snapshot_digest TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS audit_target_links_target ON audit_target_links(target_id, audit_id);
      CREATE TABLE IF NOT EXISTS product_events (
        product_id TEXT NOT NULL REFERENCES products(id), sequence INTEGER NOT NULL, type TEXT NOT NULL, resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL, PRIMARY KEY(product_id, sequence)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS product_event_counters (product_id TEXT PRIMARY KEY REFERENCES products(id), next_sequence INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS target_operation_locks (
        target_id TEXT PRIMARY KEY REFERENCES audit_targets(id) ON DELETE CASCADE, holder TEXT NOT NULL UNIQUE, operation TEXT NOT NULL,
        acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL
      ) STRICT;
    `);
    // Availability is an observed catalog value. Listing targets does not touch
    // source paths, so the last explicit check is stored and displayed instead.
    for (const statement of [
      "ALTER TABLE audit_targets ADD COLUMN availability TEXT NOT NULL DEFAULT 'unknown'",
      "ALTER TABLE audit_targets ADD COLUMN availability_checked_at TEXT",
      "ALTER TABLE audit_targets ADD COLUMN availability_error TEXT",
    ]) {
      try { this.db.exec(statement); } catch (cause) {
        if (!String(cause.message).includes("duplicate column name")) throw cause;
      }
    }
    const created = now();
    this.db.prepare("INSERT OR IGNORE INTO products(id,name,description,tags_json,system,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(UNDEFINED_PRODUCT_ID, "未定义", "兼容历史项目、任务和不属于明确产品的临时审计。", "[]", 1, "active", 1, created, created);
    this.db.prepare("INSERT OR IGNORE INTO product_event_counters(product_id,next_sequence) VALUES(?,1)").run(UNDEFINED_PRODUCT_ID);
  }

  close() { this.db?.close(); this.db = null; }
  async transaction(callback) {
    await this.ready;
    const operation = (this.writeQueue ?? Promise.resolve()).catch(() => {}).then(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try { const value = await callback(); this.db.exec("COMMIT"); return value; }
      catch (cause) { try { this.db.exec("ROLLBACK"); } catch {} throw cause; }
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }
  async withTargetOperation(targetId, operation, callback) {
    await this.ready;
    if (!TARGET_ID.test(targetId ?? "") && !LEGACY_TARGET_ID.test(targetId ?? "")) throw error("审计对象 ID 格式非法。", 422, "target-id-invalid");
    const holder = randomUUID();
    const acquiredAt = now();
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await this.transaction(() => {
      this.db.prepare("DELETE FROM target_operation_locks WHERE expires_at<=?").run(acquiredAt);
      if (!this.db.prepare("SELECT id FROM audit_targets WHERE id=?").get(targetId)) throw error("审计对象不存在。", 404, "target-not-found");
      try {
        this.db.prepare("INSERT INTO target_operation_locks(target_id,holder,operation,acquired_at,expires_at) VALUES(?,?,?,?,?)")
          .run(targetId, holder, String(operation ?? "operation").slice(0, 80), acquiredAt, expiresAt);
      } catch (cause) {
        if (String(cause.message).includes("UNIQUE")) throw error("审计对象正在执行另一项操作，请稍后重试。", 409, "target-operation-busy");
        throw cause;
      }
      this.db.prepare("UPDATE audit_targets SET operation_epoch=operation_epoch+1 WHERE id=?").run(targetId);
    });
    try { return await callback(); }
    finally {
      await this.transaction(() => {
        this.db.prepare("DELETE FROM target_operation_locks WHERE target_id=? AND holder=?").run(targetId, holder);
      });
    }
  }
  event(productId, type, resourceType, resourceId, payload = {}) {
    const counter = this.db.prepare("SELECT next_sequence FROM product_event_counters WHERE product_id=?").get(productId);
    const sequence = counter?.next_sequence ?? 1;
    this.db.prepare("INSERT OR REPLACE INTO product_event_counters(product_id,next_sequence) VALUES(?,?)").run(productId, sequence + 1);
    this.db.prepare("INSERT INTO product_events(product_id,sequence,type,resource_type,resource_id,payload_json,occurred_at) VALUES(?,?,?,?,?,?,?)")
      .run(productId, sequence, type, resourceType, resourceId, JSON.stringify(payload), now());
    return sequence;
  }
  product(id) { return toProduct(this.db.prepare("SELECT * FROM products WHERE id=?").get(id)); }
  assertProduct(id, { writable = false } = {}) {
    if (!PRODUCT_ID.test(id ?? "")) throw error("产品 ID 格式非法。", 422, "product-id-invalid");
    const product = this.product(id);
    if (!product) throw error("产品不存在。", 404, "product-not-found");
    if (writable && product.status !== "active") throw error("产品已归档，不能执行此操作。", 409, "product-archived");
    return product;
  }
  async listProducts(input = {}) {
    await this.ready;
    const { page, limit } = pageInput(input);
    const query = normalizedText(input.q ?? "", "搜索条件", 120).toLowerCase();
    const status = input.status ?? "active";
    if (!["active", "archived", "all"].includes(status)) throw error("产品状态筛选无效。");
    const conditions = ["1=1"]; const values = [];
    if (status !== "all") { conditions.push("p.status=?"); values.push(status); }
    if (query) { conditions.push("(lower(p.name) LIKE ? OR lower(p.description) LIKE ? OR lower(p.tags_json) LIKE ?)"); values.push(`%${query}%`, `%${query}%`, `%${query}%`); }
    const where = conditions.join(" AND ");
    const count = this.db.prepare(`SELECT COUNT(*) AS count FROM products p WHERE ${where}`).get(...values).count;
    const items = this.db.prepare(`SELECT p.*, COUNT(t.id) AS target_count FROM products p LEFT JOIN audit_targets t ON t.product_id=p.id WHERE ${where} GROUP BY p.id ORDER BY p.system DESC, p.updated_at DESC, p.id LIMIT ? OFFSET ?`).all(...values, limit, (page - 1) * limit)
      .map(row => ({ ...toProduct(row), target_count: Number(row.target_count) }));
    return { items, count: Number(count), page, page_size: limit, total_pages: Math.max(1, Math.ceil(count / limit)) };
  }
  async createProduct(input) {
    return this.transaction(async () => {
      const name = normalizedText(input?.name, "产品名称", 120, { required: true });
      if (name === "未定义") throw error("“未定义”是系统内置产品名称。", 409, "product-name-reserved");
      const created = now(); const id = `product-${randomUUID()}`;
      try {
        this.db.prepare("INSERT INTO products(id,name,description,tags_json,system,status,version,created_at,updated_at) VALUES(?,?,?,?,0,'active',1,?,?)")
          .run(id, name, normalizedText(input?.description ?? "", "产品说明", 2000), JSON.stringify(normalizedTags(input?.tags)), created, created);
      } catch (cause) {
        if (String(cause.message).includes("UNIQUE")) throw error("产品名称已存在。", 409, "product-name-exists");
        throw cause;
      }
      this.db.prepare("INSERT INTO product_event_counters(product_id,next_sequence) VALUES(?,1)").run(id);
      this.event(id, "product.created", "product", id, {});
      return this.product(id);
    });
  }
  async updateProduct(id, input, expectedVersion) {
    return this.transaction(async () => {
      const product = this.assertProduct(id);
      if (product.system) throw error("系统内置产品不能编辑。", 409, "product-system-managed");
      if (Number(expectedVersion) !== product.version) throw error("产品版本已变化，请刷新后重试。", 412, "version-mismatch");
      const name = Object.hasOwn(input ?? {}, "name") ? normalizedText(input.name, "产品名称", 120, { required: true }) : product.name;
      if (name === "未定义") throw error("“未定义”是系统内置产品名称。", 409, "product-name-reserved");
      const updated = now();
      this.db.prepare("UPDATE products SET name=?,description=?,tags_json=?,version=version+1,updated_at=? WHERE id=?").run(name,
        Object.hasOwn(input ?? {}, "description") ? normalizedText(input.description, "产品说明", 2000) : product.description,
        Object.hasOwn(input ?? {}, "tags") ? JSON.stringify(normalizedTags(input.tags)) : JSON.stringify(product.tags), updated, id);
      this.event(id, "product.updated", "product", id, {}); return this.product(id);
    });
  }
  async productAction(id, action, expectedVersion) {
    return this.transaction(async () => {
      const product = this.assertProduct(id);
      if (product.system) throw error("系统内置产品不能归档或恢复。", 409, "product-system-managed");
      if (Number(expectedVersion) !== product.version) throw error("产品版本已变化，请刷新后重试。", 412, "version-mismatch");
      if (!["archive", "restore"].includes(action)) throw error("产品操作无效。", 422, "product-action-invalid");
      if (action === "archive" && product.status !== "active") return product;
      if (action === "restore" && product.status !== "archived") return product;
      const status = action === "archive" ? "archived" : "active"; const changed = now();
      this.db.prepare("UPDATE products SET status=?, archived_at=?, version=version+1, updated_at=? WHERE id=?").run(status, status === "archived" ? changed : null, changed, id);
      this.event(id, `product.${status}`, "product", id, {}); return this.product(id);
    });
  }
  async listTargets(productId, input = {}) {
    await this.ready; this.assertProduct(productId);
    const { page, limit } = pageInput(input); const query = normalizedText(input.q ?? "", "搜索条件", 120).toLowerCase();
    const status = input.status ?? "active"; if (!["active", "archived", "all"].includes(status)) throw error("对象状态筛选无效。");
    const conditions = ["product_id=?"]; const values = [productId];
    if (status !== "all") { conditions.push("status=?"); values.push(status); }
    if (query) { conditions.push("(lower(name) LIKE ? OR lower(description) LIKE ? OR lower(tags_json) LIKE ?)"); values.push(`%${query}%`, `%${query}%`, `%${query}%`); }
    const where = conditions.join(" AND "); const count = this.db.prepare(`SELECT COUNT(*) AS count FROM audit_targets WHERE ${where}`).get(...values).count;
    const rows = this.db.prepare(`SELECT * FROM audit_targets WHERE ${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...values, limit, (page - 1) * limit);
    const scopes = this.scopesFor(rows.map(row => row.id));
    return { items: rows.map(row => toTarget(row, scopes.get(row.id) ?? [])), count: Number(count), page, page_size: limit, total_pages: Math.max(1, Math.ceil(count / limit)) };
  }
  async targetIds(productId) {
    await this.ready; this.assertProduct(productId);
    return this.db.prepare("SELECT id FROM audit_targets WHERE product_id=? ORDER BY id").all(productId).map(row => row.id);
  }
  scopesFor(ids) {
    const result = new Map(ids.map(id => [id, []])); if (!ids.length) return result;
    const placeholders = ids.map(() => "?").join(",");
    for (const row of this.db.prepare(`SELECT * FROM source_scopes WHERE target_id IN (${placeholders}) ORDER BY target_id,position,id`).all(...ids)) result.get(row.target_id).push(toScope(row));
    return result;
  }
  getTarget(productId, targetId, { writable = false } = {}) {
    const product = this.assertProduct(productId, { writable });
    if (!TARGET_ID.test(targetId ?? "") && !LEGACY_TARGET_ID.test(targetId ?? "")) throw error("审计对象 ID 格式非法。", 422, "target-id-invalid");
    const row = this.db.prepare("SELECT * FROM audit_targets WHERE id=? AND product_id=?").get(targetId, product.id);
    if (!row) throw error("审计对象不存在。", 404, "target-not-found");
    if (writable && row.status !== "active") throw error("审计对象已归档，不能执行此操作。", 409, "target-archived");
    return toTarget(row, this.scopesFor([targetId]).get(targetId));
  }
  targetById(targetId) {
    if (!TARGET_ID.test(targetId ?? "") && !LEGACY_TARGET_ID.test(targetId ?? "")) return null;
    const row = this.db.prepare("SELECT * FROM audit_targets WHERE id=?").get(targetId);
    return row ? toTarget(row, this.scopesFor([targetId]).get(targetId)) : null;
  }
  async canonicalScope(scope, position, { allowPlatformManaged = false } = {}) {
    const name = normalizedText(scope?.name, "源码范围名称", 120, { required: true });
    if (typeof scope?.path !== "string" || !scope.path.trim() || !isAbsolute(scope.path)) throw error("源码范围必须是工作台主机上的绝对目录。", 422, "scope-path-invalid");
    let path; try { path = await realpath(scope.path.trim()); const info = await stat(path); if (!info.isDirectory()) throw new Error("not-directory"); }
    catch { throw error("源码范围不存在、不可读取或不是目录。", 422, "scope-directory-unavailable"); }
    if (path === parse(path).root) throw error("不能将文件系统根目录作为源码范围。", 422, "scope-path-too-broad");
    const platformRelative = this.platformRoot ? relative(path, this.platformRoot) : null;
    if (!allowPlatformManaged && this.platformRoot && (path === this.platformRoot || (platformRelative && !platformRelative.startsWith("..") && !isAbsolute(platformRelative)))) {
      throw error("不能将工作台平台目录或其祖先作为源码范围。", 422, "scope-path-platform-managed");
    }
    return { id: SCOPE_ID.test(scope?.id ?? "") ? scope.id : `scope-${randomUUID()}`, name, path, include_patterns: normalizedPatterns(scope?.include_patterns, "包含规则"), exclude_patterns: normalizedPatterns(scope?.exclude_patterns, "排除规则"), role: normalizedText(scope?.role ?? "", "范围角色", 120), description: normalizedText(scope?.description ?? "", "范围说明", 2000), position };
  }
  async canonicalScopes(value, options = {}) {
    if (!Array.isArray(value) || !value.length || value.length > 32) throw error("审计对象必须包含 1-32 个源码范围。", 422, "target-scopes-invalid");
    const scopes = []; for (let index = 0; index < value.length; index += 1) scopes.push(await this.canonicalScope(value[index], index, options));
    const paths = new Set(); const names = new Set();
    for (const scope of scopes) { if (paths.has(scope.path) || names.has(scope.name)) throw error("同一审计对象不能包含重复的范围路径或名称。", 409, "target-scope-duplicate"); paths.add(scope.path); names.add(scope.name); }
    for (const left of scopes) for (const right of scopes) {
      if (left === right) continue;
      const descendant = relative(left.path, right.path);
      if (descendant && !descendant.startsWith("..") && !isAbsolute(descendant)) throw error("同一审计对象的源码范围不能彼此包含。", 409, "target-scope-overlap");
    }
    return scopes;
  }
  async createTarget(productId, input, { origin = "ui", id = null, storageNamespace = null, allowPlatformManaged = false } = {}) {
    const scopes = await this.canonicalScopes(input?.source_scopes, { allowPlatformManaged });
    return this.transaction(async () => {
      this.assertProduct(productId, { writable: true }); const created = now(); const targetId = id ?? `target-${randomUUID()}`;
      if ((!id && !TARGET_ID.test(targetId)) || (id && !TARGET_ID.test(targetId) && !LEGACY_TARGET_ID.test(targetId))) throw error("审计对象 ID 格式非法。", 422, "target-id-invalid");
      const name = normalizedText(input?.name, "审计对象名称", 160, { required: true });
      this.db.prepare("INSERT INTO audit_targets(id,product_id,name,description,tags_json,version_label,test_focus,relationship_notes,status,origin,storage_namespace,version,operation_epoch,ownership_generation,availability,availability_checked_at,availability_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(targetId, productId, name, normalizedText(input?.description ?? "", "对象说明", 4000), JSON.stringify(normalizedTags(input?.tags)), normalizedText(input?.version_label ?? "", "版本备注", 240), normalizedText(input?.test_focus ?? "", "测试重点", 4000), normalizedText(input?.relationship_notes ?? "", "范围关系说明", 4000), "active", origin, storageNamespace ?? targetId, 1, 1, 1, "available", created, null, created, created);
      const insert = this.db.prepare("INSERT INTO source_scopes(id,target_id,name,path,include_patterns_json,exclude_patterns_json,role,description,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
      for (const scope of scopes) insert.run(scope.id, targetId, scope.name, scope.path, JSON.stringify(scope.include_patterns), JSON.stringify(scope.exclude_patterns), scope.role, scope.description, scope.position, created, created);
      this.event(productId, "target.created", "target", targetId, {}); return this.getTarget(productId, targetId);
    });
  }
  async updateTarget(productId, targetId, input, expectedVersion) {
    const scopeUpdate = Object.hasOwn(input ?? {}, "source_scopes");
    const scopes = scopeUpdate ? await this.canonicalScopes(input.source_scopes) : null;
    return this.transaction(async () => {
      const target = this.getTarget(productId, targetId, { writable: true });
      if (Number(expectedVersion) !== target.version) throw error("审计对象版本已变化，请刷新后重试。", 412, "version-mismatch");
      const changed = now();
      const name = Object.hasOwn(input ?? {}, "name") ? normalizedText(input.name, "审计对象名称", 160, { required: true }) : target.name;
      const description = Object.hasOwn(input ?? {}, "description") ? normalizedText(input.description, "对象说明", 4000) : target.description;
      const tags = Object.hasOwn(input ?? {}, "tags") ? normalizedTags(input.tags) : target.tags;
      const versionLabel = Object.hasOwn(input ?? {}, "version_label") ? normalizedText(input.version_label, "版本备注", 240) : target.version_label;
      const testFocus = Object.hasOwn(input ?? {}, "test_focus") ? normalizedText(input.test_focus, "测试重点", 4000) : target.test_focus;
      const relationshipNotes = Object.hasOwn(input ?? {}, "relationship_notes") ? normalizedText(input.relationship_notes, "范围关系说明", 4000) : target.relationship_notes;
      this.db.prepare("UPDATE audit_targets SET name=?,description=?,tags_json=?,version_label=?,test_focus=?,relationship_notes=?,version=version+1,operation_epoch=operation_epoch+?,updated_at=? WHERE id=?")
        .run(name, description, JSON.stringify(tags), versionLabel, testFocus, relationshipNotes, scopeUpdate ? 1 : 0, changed, targetId);
      if (scopes) {
        this.memoryScopeChanged?.(target, scopes);
        this.db.prepare("UPDATE audit_targets SET availability='available',availability_checked_at=?,availability_error=NULL WHERE id=?").run(changed, targetId);
        this.db.prepare("DELETE FROM source_scopes WHERE target_id=?").run(targetId);
        const insert = this.db.prepare("INSERT INTO source_scopes(id,target_id,name,path,include_patterns_json,exclude_patterns_json,role,description,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
        for (const scope of scopes) insert.run(scope.id, targetId, scope.name, scope.path, JSON.stringify(scope.include_patterns), JSON.stringify(scope.exclude_patterns), scope.role, scope.description, scope.position, changed, changed);
      }
      this.event(productId, "target.updated", "target", targetId, { source_scopes_changed: scopeUpdate });
      return this.getTarget(productId, targetId);
    });
  }
  async targetAction(productId, targetId, action, expectedVersion) {
    return this.transaction(async () => {
      const target = this.getTarget(productId, targetId);
      if (!['archive', 'restore'].includes(action)) throw error("审计对象操作无效。", 422, "target-action-invalid");
      if (Number(expectedVersion) !== target.version) throw error("审计对象版本已变化，请刷新后重试。", 412, "version-mismatch");
      const status = action === "archive" ? "archived" : "active";
      if (target.status === status) return target;
      const changed = now();
      this.db.prepare("UPDATE audit_targets SET status=?,archived_at=?,version=version+1,operation_epoch=operation_epoch+1,updated_at=? WHERE id=?")
        .run(status, status === "archived" ? changed : null, changed, targetId);
      this.event(productId, `target.${status}`, "target", targetId, {});
      return this.getTarget(productId, targetId);
    });
  }
  async inspectTarget(productId, targetId) {
    await this.ready;
    const target = this.getTarget(productId, targetId);
    const errors = [];
    for (const scope of target.source_scopes) {
      try {
        const resolved = await realpath(scope.path);
        const info = await stat(resolved);
        if (!info.isDirectory()) throw new Error("not-directory");
        if (resolved !== scope.path) throw new Error("source-path-resolution-changed");
      } catch (cause) {
        errors.push(`${scope.name}: ${cause.message === "source-path-resolution-changed" ? "目录链接解析结果已变化" : "目录不可读取或不存在"}`);
      }
    }
    return this.transaction(async () => {
      const current = this.getTarget(productId, targetId);
      const checked = now(); const availability = errors.length ? "unavailable" : "available";
      this.db.prepare("UPDATE audit_targets SET availability=?,availability_checked_at=?,availability_error=?,updated_at=? WHERE id=?")
        .run(availability, checked, errors.join("；") || null, checked, targetId);
      this.event(productId, "target.availability.checked", "target", targetId, { availability });
      return this.getTarget(productId, targetId);
    });
  }
  async copyTarget(productId, targetId, input = {}) {
    await this.ready;
    const target = this.getTarget(productId, targetId);
    return this.createTarget(productId, {
      name: Object.hasOwn(input, "name") ? input.name : `${target.name}（副本）`,
      description: Object.hasOwn(input, "description") ? input.description : target.description,
      tags: Object.hasOwn(input, "tags") ? input.tags : target.tags,
      version_label: target.version_label,
      test_focus: target.test_focus,
      relationship_notes: target.relationship_notes,
      source_scopes: target.source_scopes.map(({ id: _id, ...scope }) => scope),
    }, { origin: "ui" });
  }
  async deleteTarget(productId, targetId, expectedVersion) {
    return this.transaction(async () => {
      const target = this.getTarget(productId, targetId);
      if (Number(expectedVersion) !== target.version) throw error("审计对象版本已变化，请刷新后重试。", 412, "version-mismatch");
      const linkCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM audit_target_links WHERE target_id=?").get(targetId).count);
      if (linkCount) throw error("审计对象仍有关联任务或历史资源，不能删除。", 409, "target-has-audits");
      this.memoryLifecycle?.('deleted', target);
      this.db.prepare("DELETE FROM audit_targets WHERE id=?").run(targetId);
      this.event(productId, "target.deleted", "target", targetId, {});
      return { target_id: targetId, deleted: true, source_directories_deleted: false, artifacts_deleted: false };
    });
  }
  async transferTarget(fromProductId, targetId, toProductId, expectedVersion) {
    const [target] = await this.transferTargets(fromProductId, [{ id: targetId, version: Number(expectedVersion) }], toProductId);
    return target;
  }
  validateTransferSelection(items) {
    if (!Array.isArray(items) || items.length < 1 || items.length > 100
      || items.some(item => !item || typeof item.id !== "string" || !item.id || !Number.isSafeInteger(item.version) || item.version < 1)
      || new Set(items.map(item => item.id)).size !== items.length) {
      throw error("请选择 1–100 个不同的测试对象，并提供有效版本。", 422, "target-transfer-selection-invalid");
    }
  }
  async transferTargets(fromProductId, items, toProductId) {
    this.validateTransferSelection(items);
    if (typeof toProductId !== "string" || !toProductId) throw error("请选择目标产品。", 422, "target-transfer-destination-invalid");
    return this.transaction(async () => {
      const destination = this.assertProduct(toProductId, { writable: true });
      if (destination.id === fromProductId) throw error("请选择不同的目标产品。", 422, "target-transfer-destination-invalid");
      const targets = items.map(item => {
        const target = this.getTarget(fromProductId, item.id, { writable: true });
        if (item.version !== target.version) throw error(`测试对象“${target.name}”版本已变化，请刷新后重试；本批次未修改。`, 412, "version-mismatch");
        return target;
      });
      const changed = now();
      for (const target of targets) {
        this.memoryLifecycle?.('transferred', target, destination.id);
        this.db.prepare("UPDATE audit_targets SET product_id=?,version=version+1,operation_epoch=operation_epoch+1,ownership_generation=ownership_generation+1,updated_at=? WHERE id=?")
          .run(destination.id, changed, target.id);
        this.event(fromProductId, "target.transferred_out", "target", target.id, { to_product_id: destination.id });
        this.event(destination.id, "target.transferred_in", "target", target.id, { from_product_id: fromProductId });
      }
      return targets.map(target => this.getTarget(destination.id, target.id));
    });
  }
  async targetExecutionSnapshot(productId, targetId) {
    await this.ready;
    const target = this.getTarget(productId, targetId, { writable: true });
    if (target.availability === "unavailable") throw error("审计对象的源码范围当前不可用；请修复后重新检查。", 409, "target-unavailable");
    const snapshot = targetSnapshot(target);
    return { target, snapshot, digest: snapshotDigest(snapshot) };
  }
  async linkAudit({ auditId, productId, targetId, snapshot, snapshotDigest: digest }) {
    return this.transaction(async () => {
      const target = this.getTarget(productId, targetId);
      const product = this.assertProduct(productId);
      const calculated = snapshotDigest(snapshot);
      if (!digest || digest !== calculated) throw error("任务对象快照摘要无效。", 422, "target-snapshot-invalid");
      this.db.prepare("INSERT INTO audit_target_links(audit_id,target_id,product_id_at_creation,product_name_at_creation,snapshot_json,snapshot_digest,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(auditId, target.id, product.id, product.name, JSON.stringify(snapshot), digest, now());
      this.event(productId, "audit.linked", "audit", auditId, { target_id: targetId, target_version: snapshot.target_version });
      return { audit_id: auditId, target_id: targetId, product_id_at_creation: product.id, product_name_at_creation: product.name, snapshot_digest: digest };
    });
  }
  auditLink(auditId) {
    const row = this.db.prepare("SELECT * FROM audit_target_links WHERE audit_id=?").get(auditId);
    if (!row) return null;
    const { snapshot_json: _snapshot, ...value } = row;
    return { ...value, snapshot: json(row.snapshot_json, {}), snapshot_digest: row.snapshot_digest };
  }
  async unlinkAudit(auditId, targetId) {
    return this.transaction(async () => {
      const link = this.auditLink(auditId);
      if (!link) return false;
      if (link.target_id !== targetId) throw error("审计与对象绑定不一致。", 409, "audit-target-mismatch");
      const target = this.targetById(targetId);
      this.db.prepare("DELETE FROM audit_target_links WHERE audit_id=?").run(auditId);
      this.event(target.product_id, "audit.deleted", "audit", auditId, { target_id: targetId });
      return true;
    });
  }
  async auditLinksForProduct(productId) {
    await this.ready; this.assertProduct(productId);
    return new Map(this.db.prepare("SELECT l.audit_id,l.target_id,l.product_id_at_creation,l.product_name_at_creation,l.snapshot_digest FROM audit_target_links l JOIN audit_targets t ON t.id=l.target_id WHERE t.product_id=?").all(productId)
      .map(row => [row.audit_id, row]));
  }
  async listProductEvents(productId, after = 0, limit = 200) {
    await this.ready; this.assertProduct(productId);
    const sequence = Number(after);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw error("事件序号无效。", 422, "product-event-sequence-invalid");
    const size = Math.max(1, Math.min(Number(limit) || 200, 500));
    return this.db.prepare("SELECT * FROM product_events WHERE product_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(productId, sequence, size)
      .map(row => ({ ...row, payload: json(row.payload_json, {}), sequence: Number(row.sequence) }));
  }
  async importLegacyRepository(repository) {
    await this.ready; if (!repository?.id || !repository?.path) return null;
    const current = this.db.prepare("SELECT * FROM audit_targets WHERE id=?").get(repository.id);
    if (current) return toTarget(current, this.scopesFor([current.id]).get(current.id));
    return this.createTarget(UNDEFINED_PRODUCT_ID, { name: repository.name ?? basename(repository.path), source_scopes: [{ name: "source", path: repository.path }] }, { origin: "legacy", id: repository.id, storageNamespace: repository.id, allowPlatformManaged: true });
  }
}
