import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { initializeSchema } from './schema.mjs';
import { topologyMethods } from './topology.mjs';
import { PROTOCOL, uid, now, check, text, parse, hash, page, within, relativePath, readBound, atomicJson } from './contract.mjs';

const KINDS = new Set(['interface', 'asset', 'coverage', 'finding', 'relation', 'lesson', 'gap', 'inventory']);
const VERDICTS = new Set(['UNREVIEWED', 'TRUE_POSITIVE', 'FALSE_POSITIVE', 'INSUFFICIENT_EVIDENCE']);
const REMEDIATIONS = new Set(['OPEN', 'FIX_IN_PROGRESS', 'FIX_CLAIMED', 'FIX_VERIFIED', 'REOPENED', 'RISK_ACCEPTED']);
const RELATIONS = new Set(['SAME_ISSUE', 'SAME_ROOT_CAUSE', 'SAME_PATTERN', 'COMPOSES_WITH']);
const TODO_TYPES = new Set(['FIND_ENTRYPOINT', 'CHECK_PATTERN', 'VERIFY_FIX', 'VERIFY_GUARD', 'COMPLETE_CHAIN', 'FOLLOWUP']);

export class ProductMemoryStore {
  constructor({ products, stateRoot }) {
    this.products = products; this.stateRoot = resolve(stateRoot); this.discoveries = new Map();
    this.ready = (async () => { await products.ready; await mkdir(this.stateRoot, { recursive: true }); this.db = products.db; initializeSchema(this.db); })();
  }
  write(callback) { return this.products.transaction(callback); }
  event(productId, repoId, type, resourceId, payload) {
    const result = this.db.prepare('INSERT INTO pm_events(id,product_id,repo_id,type,resource_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(uid('event'), productId, repoId, type, resourceId, JSON.stringify(payload), now());
    return Number(result.lastInsertRowid);
  }
  watermark(productId) { return Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM pm_events WHERE product_id=?').get(productId).value); }
  binding(auditId) { return this.db.prepare('SELECT * FROM pm_bindings WHERE audit_id=?').get(auditId) ?? null; }
  async bindAudit({ auditId, productId, repoId, snapshotId, campaignId = null, mode = 'full' }) {
    await this.ready; this.repo(productId, repoId); const snapshot = this.snapshot(productId, snapshotId);
    check(snapshot.repo_id === repoId && ['off', 'facts_only', 'full', 'blind'].includes(mode), '审计记忆绑定无效。');
    return this.write(() => {
      const existing = this.binding(auditId);
      if (existing) { check(existing.product_id === productId && existing.repo_id === repoId && existing.snapshot_id === snapshotId && existing.mode === mode, '审计记忆绑定不可替换。', 409); return existing; }
      this.db.prepare('INSERT INTO pm_bindings(audit_id,product_id,repo_id,snapshot_id,campaign_id,read_watermark,mode,created_at) VALUES(?,?,?,?,?,?,?,?)').run(auditId, productId, repoId, snapshotId, campaignId, this.watermark(productId), mode, now());
      return this.binding(auditId);
    });
  }
  async manifest(snapshotId, productId) {
    const snapshot = this.snapshot(productId, snapshotId), value = parse(await readFile(snapshot.manifest_path, 'utf8'));
    check(value && value.digest === snapshot.digest && hash({ protocol: value.protocol, files: value.files, excluded: value.excluded, gaps: value.gaps }) === snapshot.digest, '源码快照摘要校验失败。');
    return value;
  }
  async evidence(binding, values = []) {
    check(Array.isArray(values) && values.length <= 100, '证据引用数量无效。');
    const manifest = await this.manifest(binding.snapshot_id, binding.product_id);
    const files = new Map(manifest.files.map(row => [row.path, row]));
    const output = [], verified = new Set();
    for (const value of values) {
      check(value && typeof value === 'object', '证据位置无效。'); relativePath(value.path);
      const file = files.get(value.path); check(file && (!value.sha256 || value.sha256 === file.sha256), '证据位置不属于绑定的源码快照。');
      check(value.line == null || Number.isInteger(value.line) && value.line > 0, '证据行号无效。');
      check(value.line == null || file.line_count == null || value.line <= file.line_count, '证据行号超出绑定文件。');
      if (!verified.has(file.path)) { await readBound(this.snapshot(binding.product_id, binding.snapshot_id).source_root, file); verified.add(file.path); }
      output.push({ repo_id: binding.repo_id, snapshot_id: binding.snapshot_id, path: value.path, sha256: file.sha256, ...(value.line ? { line: value.line } : {}), ...(value.symbol ? { symbol: text(value.symbol, '符号', 500) } : {}) });
    }
    return output;
  }
  async observe(auditId, input, { taskId = 'recon', sessionId = null, trust = 'OBSERVED' } = {}) {
    await this.ready; const binding = this.binding(auditId); check(binding, '本次审计尚未绑定记忆。', 409);
    this.repo(binding.product_id, binding.repo_id);
    check(input && KINDS.has(input.kind), '记忆类型无效。');
    const title = text(input.title, '观察标题', 500), entityKey = text(input.entity_key, '实体键', 1000);
    check(input.data && typeof input.data === 'object' && !Array.isArray(input.data), '观察内容必须是对象。');
    check(Buffer.byteLength(JSON.stringify(input.data)) <= 64000, '单条观察内容过大。');
    const evidence = await this.evidence(binding, input.evidence_refs ?? []);
    const allowedTrust = ['OBSERVED', 'REVIEWED', 'LEGACY_UNBOUND', 'PROPOSED'].includes(trust) ? trust : 'OBSERVED';
    const digest = hash({ kind: input.kind, entity_key: entityKey, title, data: input.data, evidence });
    return this.write(() => {
      const duplicate = this.db.prepare('SELECT id FROM pm_observations WHERE audit_id=? AND task_id=? AND digest=?').get(auditId, taskId, digest);
      if (duplicate) return this.observation(binding.product_id, duplicate.id);
      const id = uid('observation'), sequence = this.event(binding.product_id, binding.repo_id, 'observation.accepted', id, { kind: input.kind, audit_id: auditId, task_id: taskId });
      this.db.prepare('INSERT INTO pm_observations(id,product_id,repo_id,snapshot_id,audit_id,task_id,session_id,kind,entity_key,title,data_json,evidence_json,trust,digest,event_sequence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, binding.product_id, binding.repo_id, binding.snapshot_id, auditId, taskId, sessionId, input.kind, entityKey, title, JSON.stringify(input.data), JSON.stringify(evidence), evidence.length ? allowedTrust : allowedTrust === 'LEGACY_UNBOUND' ? allowedTrust : 'PROPOSED', digest, sequence, now());
      if (input.kind === 'finding') this.attachIssue(id, binding, title, entityKey, input.data, evidence);
      return this.observation(binding.product_id, id);
    });
  }
  attachIssue(observationId, binding, title, entityKey, data, evidence) {
    // Only identical source evidence and mechanism inherit a prior issue automatically.
    const identity = hash({ type: data.vulnerability_type_id ?? null, mechanism: data.security_invariant ?? data.root_cause ?? null, locations: evidence.map(({ path, sha256, symbol }) => ({ path, sha256, symbol })) });
    const prior = evidence.length ? this.db.prepare(`SELECT o.data_json,i.issue_id FROM pm_observations o JOIN pm_issue_observations i ON i.observation_id=o.id WHERE o.product_id=? AND o.repo_id=? AND o.kind='finding' AND o.entity_key=? AND o.id<>? ORDER BY o.event_sequence DESC LIMIT 20`).all(binding.product_id, binding.repo_id, entityKey, observationId).find(row => parse(row.data_json)?._issue_identity === identity) : null;
    const issueId = prior?.issue_id ?? uid('issue');
    this.db.prepare('UPDATE pm_observations SET data_json=? WHERE id=?').run(JSON.stringify({ ...data, _issue_identity: identity }), observationId);
    if (!prior) this.db.prepare('INSERT INTO pm_issues(id,product_id,repo_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(issueId, binding.product_id, binding.repo_id, title, now(), now());
    this.db.prepare('INSERT INTO pm_issue_observations(observation_id,issue_id) VALUES(?,?)').run(observationId, issueId);
    this.db.prepare('UPDATE pm_issues SET updated_at=? WHERE id=?').run(now(), issueId);
  }
  observation(productId, id) {
    this.products.assertProduct(productId);
    const row = this.db.prepare('SELECT o.*,i.issue_id FROM pm_observations o LEFT JOIN pm_issue_observations i ON i.observation_id=o.id WHERE o.id=? AND o.product_id=?').get(id, productId);
    check(row, '产品空间内没有该观察。', 404);
    return { ...row, data: parse(row.data_json, {}), evidence_refs: parse(row.evidence_json, []), data_json: undefined, evidence_json: undefined };
  }
  search(productId, input = {}, access = null) {
    this.products.assertProduct(productId); const { limit, offset } = page(input);
    if (access && ['blind', 'off'].includes(access.mode)) return { items: [], total: 0, status: 'SKIPPED', reason: '本次模式不读取历史记忆。' };
    const where = ['o.product_id=?'], params = [productId];
    if (input.audit_ids) { check(Array.isArray(input.audit_ids) && input.audit_ids.length <= 200 && input.audit_ids.every(id => typeof id === 'string'), '审计筛选无效。'); where.push(input.audit_ids.length ? `o.audit_id IN (${input.audit_ids.map(() => '?').join(',')})` : '0=1'); params.push(...input.audit_ids); }
    if (input.repo_id) { this.repo(productId, input.repo_id); where.push('o.repo_id=?'); params.push(input.repo_id); }
    if (input.snapshot_id) { this.snapshot(productId, input.snapshot_id); where.push('o.snapshot_id=?'); params.push(input.snapshot_id); }
    if (input.kind) { check(KINDS.has(input.kind), '记忆类型无效。'); where.push('o.kind=?'); params.push(input.kind); }
    if (input.query) { const query = text(input.query, '检索词', 500); where.push("(o.title LIKE ? ESCAPE '\\' OR o.entity_key LIKE ? ESCAPE '\\' OR o.data_json LIKE ? ESCAPE '\\')"); const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`; params.push(pattern, pattern, pattern); }
    if (access?.mode === 'facts_only') where.push("o.kind IN ('interface','asset','coverage','relation','inventory','gap')");
    const watermark = input.watermark == null ? this.watermark(productId) : Number(input.watermark); check(Number.isSafeInteger(watermark) && watermark >= 0, '记忆水位无效。');
    where.push('o.event_sequence<=?'); params.push(watermark);
    const clause = where.join(' AND ');
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM pm_observations o WHERE ${clause}`).get(...params).n);
    const ids = this.db.prepare(`SELECT o.id FROM pm_observations o WHERE ${clause} ORDER BY o.event_sequence DESC,o.id LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { items: ids.map(row => this.observation(productId, row.id)), total, limit, offset, watermark, next_offset: offset + limit < total ? offset + limit : null };
  }
  issue(productId, id) {
    this.products.assertProduct(productId);
    const row = this.db.prepare('SELECT * FROM pm_issues WHERE id=? AND product_id=?').get(id, productId); check(row, '产品空间内没有该问题。', 404);
    return { ...row, observations: this.db.prepare('SELECT observation_id FROM pm_issue_observations WHERE issue_id=?').all(id).map(r => this.observation(productId, r.observation_id)),
      feedback: this.db.prepare('SELECT * FROM pm_feedback WHERE issue_id=? ORDER BY version').all(id).map(r => ({ ...r, data: parse(r.data_json), data_json: undefined })),
      relations: this.db.prepare('SELECT * FROM pm_relations WHERE product_id=? AND (from_id=? OR to_id=?)').all(productId, id, id).map(r => ({ ...r, evidence_refs: parse(r.evidence_json, []), evidence_json: undefined })) };
  }
  issues(productId, input = {}) {
    this.products.assertProduct(productId); const { limit, offset } = page(input); const where = ['product_id=?'], values = [productId];
    for (const key of ['repo_id', 'human_verdict', 'remediation']) if (input[key]) { where.push(`${key}=?`); values.push(input[key]); }
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM pm_issues WHERE ${where.join(' AND ')}`).get(...values).n);
    return { items: this.db.prepare(`SELECT * FROM pm_issues WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...values, limit, offset), total, limit, offset };
  }
  async feedback(productId, issueId, input, { actor = '本地操作者', idempotencyKey } = {}) {
    await this.ready; this.products.assertProduct(productId, { writable: true });
    const reason = text(input.reason, '判断理由', 4000); text(idempotencyKey, '幂等键', 200);
    const verdict = input.human_verdict, remediation = input.remediation;
    check(verdict == null || VERDICTS.has(verdict), '人工判断无效。'); check(remediation == null || REMEDIATIONS.has(remediation), '整改状态无效。');
    check(verdict != null || remediation != null || Object.hasOwn(input, 'duplicate_of'), '没有提供判断操作。');
    const scope = input.scope ?? { kind: 'CURRENT_OBSERVATIONS' }; check(scope && typeof scope === 'object', '反馈适用范围无效。');
    const digest = hash({ verdict, remediation, duplicate_of: input.duplicate_of, reason, scope });
    return this.write(() => {
      const issue = this.issue(productId, issueId);
      const duplicate = this.db.prepare('SELECT digest FROM pm_feedback WHERE issue_id=? AND idempotency_key=?').get(issueId, idempotencyKey);
      if (duplicate) { check(duplicate.digest === digest, '幂等键已用于其他反馈。', 409); return issue; }
      check(Number(input.version) === issue.version, '问题已被其他操作更新。', 412);
      let duplicateOf = issue.duplicate_of;
      if (Object.hasOwn(input, 'duplicate_of')) {
        duplicateOf = input.duplicate_of || null;
        if (duplicateOf) {
          check(duplicateOf !== issueId, '问题不能与自身重复。'); let cursor = this.issue(productId, duplicateOf), seen = new Set([issueId]);
          while (cursor) { check(!seen.has(cursor.id), '重复关系不能形成循环。'); seen.add(cursor.id); cursor = cursor.duplicate_of ? this.issue(productId, cursor.duplicate_of) : null; }
        }
      }
      const next = { human_verdict: verdict ?? issue.human_verdict, remediation: remediation ?? issue.remediation, duplicate_of: duplicateOf };
      const version = issue.version + 1;
      const latest = issue.observations.reduce((a, b) => !a || b.event_sequence > a.event_sequence ? b : a, null);
      const observationIds = scope.observation_ids ?? issue.observations.filter(o => scope.kind !== 'CURRENT_OBSERVATIONS' || o.snapshot_id === latest?.snapshot_id).map(o => o.id);
      check(Array.isArray(observationIds) && observationIds.length > 0 && observationIds.every(id => issue.observations.some(o => o.id === id)), '反馈适用观察必须属于当前问题。');
      const data = { before: { human_verdict: issue.human_verdict, remediation: issue.remediation, duplicate_of: issue.duplicate_of }, after: next, scope: { ...scope, observation_ids: observationIds }, evidence_refs: input.evidence_refs ?? [] };
      this.db.prepare('INSERT INTO pm_feedback(id,product_id,issue_id,version,reason,actor,data_json,idempotency_key,digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(uid('feedback'), productId, issueId, version, reason, actor, JSON.stringify(data), idempotencyKey, digest, now());
      this.db.prepare('UPDATE pm_issues SET human_verdict=?,remediation=?,duplicate_of=?,version=?,updated_at=? WHERE id=?').run(next.human_verdict, next.remediation, duplicateOf, version, now(), issueId);
      this.event(productId, issue.repo_id, 'issue.feedback', issueId, { version, reason, ...data }); return this.issue(productId, issueId);
    });
  }
  async relate(productId, input, { confirmed = false, revoke = false } = {}) {
    await this.ready; const from = this.issue(productId, input.from_id), to = this.issue(productId, input.to_id);
    check(from.id !== to.id && RELATIONS.has(input.kind), '问题关联无效。'); const reason = text(input.reason, '关联理由');
    return this.write(() => {
      const existing = this.db.prepare('SELECT * FROM pm_relations WHERE from_id=? AND to_id=? AND kind=?').get(from.id, to.id, input.kind);
      if (existing) {
        if (confirmed || revoke) {
          check(input.expected_status === existing.status, '关联状态已变化，请刷新后重试。', 412);
          this.db.prepare('UPDATE pm_relations SET status=?,reason=?,evidence_json=? WHERE id=?').run(revoke ? 'REVOKED' : 'CONFIRMED', reason, JSON.stringify(input.evidence_refs ?? []), existing.id);
          this.event(productId, from.repo_id, revoke ? 'issue.relation_revoked' : 'issue.relation_confirmed', existing.id, { before: existing, reason });
        }
        return this.db.prepare('SELECT * FROM pm_relations WHERE id=?').get(existing.id);
      }
      check(!revoke, '尚未登记该关联。', 404);
      const id = uid('relation'); this.db.prepare('INSERT INTO pm_relations(id,product_id,from_id,to_id,kind,reason,status,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, productId, from.id, to.id, input.kind, reason, confirmed ? 'CONFIRMED' : 'PROPOSED', JSON.stringify(input.evidence_refs ?? []), now());
      this.event(productId, from.repo_id, 'issue.relation', id, { from_id: from.id, to_id: to.id, kind: input.kind, confirmed }); return this.db.prepare('SELECT * FROM pm_relations WHERE id=?').get(id);
    });
  }
  async createTodo(productId, input, idempotencyKey) {
    await this.ready; this.repo(productId, input.origin_repo_id); check(TODO_TYPES.has(input.type), '待办类型无效。');
    const question = text(input.question, '待办问题', 4000); text(idempotencyKey, '幂等键', 200);
    if (input.origin_observation_id) { const o = this.observation(productId, input.origin_observation_id); check(o.repo_id === input.origin_repo_id, '来源观察与 Repo 不一致。'); }
    for (const ref of input.snapshot_refs ?? []) check(this.snapshot(productId, ref.snapshot_id).repo_id === ref.repo_id, '待办版本绑定不一致。');
    const data = { snapshot_refs: input.snapshot_refs ?? [], target_repo_ids: input.target_repo_ids ?? [], required_evidence: input.required_evidence ?? [], target_selector: input.target_selector ?? {}, preconditions: input.preconditions ?? [], max_attempts: Math.min(3, Math.max(1, Number(input.max_attempts ?? 2))) };
    check(Array.isArray(data.target_repo_ids) && data.target_repo_ids.length <= 100 && Number.isInteger(data.max_attempts), '待办目标或预算无效。');
    for (const id of data.target_repo_ids) this.repo(productId, id);
    const digest = hash({ ...input, question, data });
    return this.write(() => {
      const prior = this.db.prepare('SELECT * FROM pm_todos WHERE product_id=? AND idempotency_key=?').get(productId, idempotencyKey);
      if (prior) { check(prior.digest === digest, '待办幂等键冲突。', 409); return this.todo(productId, prior.id); }
      const id = uid('todo'); this.db.prepare('INSERT INTO pm_todos(id,product_id,origin_repo_id,origin_observation_id,campaign_id,type,question,data_json,status,idempotency_key,digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, productId, input.origin_repo_id, input.origin_observation_id ?? null, input.campaign_id ?? null, input.type, question, JSON.stringify(data), 'OPEN', idempotencyKey, digest, now(), now());
      this.event(productId, input.origin_repo_id, 'todo.created', id, { type: input.type, question }); return this.todo(productId, id);
    });
  }
  todo(productId, id) {
    this.products.assertProduct(productId); const row = this.db.prepare('SELECT * FROM pm_todos WHERE id=? AND product_id=?').get(id, productId); check(row, '产品空间内没有该待办。', 404);
    return { ...row, data: parse(row.data_json, {}), data_json: undefined, answers: this.db.prepare('SELECT * FROM pm_todo_answers WHERE todo_id=? ORDER BY created_at').all(id).map(r => ({ ...r, data: parse(r.data_json), data_json: undefined })) };
  }
  todos(productId, input = {}) {
    this.products.assertProduct(productId); const { limit, offset } = page(input); const values = [productId]; let where = 'product_id=?';
    if (input.status) { where += ' AND status=?'; values.push(input.status); }
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM pm_todos WHERE ${where}`).get(...values).n);
    return { items: this.db.prepare(`SELECT id FROM pm_todos WHERE ${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...values, limit, offset).map(r => this.todo(productId, r.id)), total, limit, offset };
  }
  async todoAction(productId, id, input, binding = null) {
    await this.ready;
    return this.write(() => {
      const todo = this.todo(productId, id); check(todo.version === Number(input.version), '待办版本已变化。', 412);
      const action = input.action;
      if (action === 'claim') {
        check(todo.status === 'OPEN' || todo.status === 'CLAIMED' && todo.lease_until < now(), '待办当前不能领取。', 409);
        check(todo.attempts < todo.data.max_attempts, '待办已达到尝试预算。', 409);
        text(input.owner, '领取者', 200);
        this.db.prepare("UPDATE pm_todos SET status='CLAIMED',lease_owner=?,lease_until=?,attempts=attempts+1,version=version+1,updated_at=? WHERE id=?").run(input.owner, new Date(Date.now() + 15 * 60000).toISOString(), now(), id);
      } else if (action === 'answer') {
        check(binding && binding.product_id === productId, '回答必须绑定实际审计。');
        check(todo.status === 'OPEN' || todo.status === 'CLAIMED' && todo.lease_owner === (input.owner ?? binding.audit_id), '待办不能由当前会话回答。', 409);
        const answer = { reason: text(input.reason, '回答依据'), observation_ids: input.observation_ids ?? [] };
        check(answer.observation_ids.length > 0, '回答需要引用已提交的观察。');
        for (const o of answer.observation_ids.map(o => this.observation(productId, o))) check(o.audit_id === binding.audit_id && o.repo_id === binding.repo_id, '回答证据必须来自当前审计。');
        this.db.prepare('INSERT OR IGNORE INTO pm_todo_answers(id,todo_id,audit_id,repo_id,snapshot_id,data_json,created_at) VALUES(?,?,?,?,?,?,?)').run(uid('answer'), id, binding.audit_id, binding.repo_id, binding.snapshot_id, JSON.stringify(answer), now());
        this.db.prepare("UPDATE pm_todos SET status='ANSWERED',version=version+1,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(now(), id);
      } else {
        check(!binding && ['resolve', 'defer', 'stale', 'reopen'].includes(action), '不支持的待办操作。'); text(input.reason, '操作理由');
        if (action === 'resolve') check(todo.status === 'ANSWERED' || input.evidence_refs?.length, '完成待办需要回答或证据。');
        const status = { resolve: 'RESOLVED', defer: 'DEFERRED', stale: 'STALE', reopen: 'OPEN' }[action];
        this.db.prepare('UPDATE pm_todos SET status=?,version=version+1,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?').run(status, now(), id);
      }
      this.event(productId, todo.origin_repo_id, `todo.${action}`, id, { reason: input.reason ?? null }); return this.todo(productId, id);
    });
  }
  async compare(productId, repoId, beforeId, afterId, kind = 'files') {
    this.repo(productId, repoId); const before = this.snapshot(productId, beforeId), after = this.snapshot(productId, afterId);
    check(before.repo_id === repoId && after.repo_id === repoId, '比较快照不属于该 Repo。');
    const sameRange = before.source_root === after.source_root;
    let left, right, complete;
    if (kind === 'files') { left = (await this.manifest(beforeId, productId)).files.map(f => [f.path, f.sha256]); right = (await this.manifest(afterId, productId)).files.map(f => [f.path, f.sha256]); complete = before.complete && after.complete && sameRange; }
    else {
      check(['interface', 'asset'].includes(kind), '比较类型无效。');
      const rows = snapshot => this.db.prepare('SELECT entity_key,data_json,trust FROM pm_observations WHERE product_id=? AND repo_id=? AND snapshot_id=? AND kind=? ORDER BY event_sequence').all(productId, repoId, snapshot, kind).map(r => [r.entity_key, hash(parse(r.data_json))]);
      left = rows(beforeId); right = rows(afterId);
      const inventory = snapshot => this.db.prepare("SELECT data_json FROM pm_observations WHERE product_id=? AND repo_id=? AND snapshot_id=? AND kind='inventory' AND trust<>'PROPOSED' ORDER BY event_sequence DESC").all(productId, repoId, snapshot).map(r => parse(r.data_json)).find(d => d?.kind === kind);
      const previous = inventory(beforeId), current = inventory(afterId);
      complete = Boolean(before.complete && after.complete && sameRange && previous?.complete === true && current?.complete === true && previous.extractor_version && previous.extractor_version === current.extractor_version && hash(previous.scope ?? null) === hash(current.scope ?? null));
    }
    const a = new Map(left), b = new Map(right), changes = [];
    for (const [key, value] of b) changes.push({ key, status: !a.has(key) ? complete ? 'ADDED' : 'UNKNOWN' : a.get(key) === value ? 'UNCHANGED' : 'MODIFIED' });
    for (const key of a.keys()) if (!b.has(key)) changes.push({ key, status: complete ? 'REMOVED' : 'UNKNOWN' });
    return { repo_id: repoId, before: beforeId, after: afterId, kind, comparable: complete, changes, summary: Object.fromEntries(['ADDED', 'REMOVED', 'MODIFIED', 'UNCHANGED', 'UNKNOWN'].map(k => [k, changes.filter(c => c.status === k).length])) };
  }
  async context(auditId, taskId, query = {}) {
    await this.ready; let binding = this.binding(auditId); check(binding, '审计没有记忆绑定。', 404);
    if (query.isolation_mode === 'blind') binding = { ...binding, mode: 'blind' };
    const result = this.search(binding.product_id, { repo_id: binding.repo_id, ...query, limit: Math.min(20, Number(query.limit) || 10) }, binding);
    result.items = result.items.map(row => ({ ...row, data: undefined, summary: JSON.stringify(row.data).slice(0, 1500), evidence_refs: row.evidence_refs.slice(0, 5), detail_operation: { op: 'show', input: { id: row.id } } }));
    const issues = ['blind', 'off', 'facts_only'].includes(binding.mode) ? [] : this.issues(binding.product_id, { repo_id: binding.repo_id, limit: 10 }).items.map(i => ({ ...i, feedback: this.db.prepare('SELECT id,version,reason,actor,created_at,data_json FROM pm_feedback WHERE issue_id=? ORDER BY version DESC LIMIT 3').all(i.id).reverse().map(f => ({ ...f, data: parse(f.data_json), data_json: undefined })) }));
    const todos = ['blind', 'off', 'facts_only'].includes(binding.mode) ? [] : this.todos(binding.product_id, { status: 'OPEN', limit: 10 }).items.map(t => ({ id: t.id, type: t.type, question: t.question.slice(0, 1500), version: t.version, origin_repo_id: t.origin_repo_id, status: t.status }));
    for (const issue of issues) issue.feedback = issue.feedback.map(f => ({ id: f.id, version: f.version, reason: f.reason.slice(0, 1000), actor: f.actor, created_at: f.created_at, scope: JSON.stringify(f.data.scope).slice(0, 1000), after: f.data.after }));
    const output = { protocol: PROTOCOL, binding, observations: result, issues, todos, notice: '历史记录是带版本的先验；必须核查当前源码与适用条件。' };
    await this.saveRead(binding, taskId, query, output, result.watermark);
    return output;
  }
  async saveRead(binding, taskId, query, output, watermark = this.watermark(binding.product_id)) {
    const id = uid('read'), path = `reads/${id}.json`;
    await atomicJson(join(this.stateRoot, path), output);
    const record = { query, result_ref: { path, sha256: hash(`${JSON.stringify(output, null, 2)}\n`) } };
    await this.write(() => this.db.prepare('INSERT INTO pm_reads(id,product_id,audit_id,task_id,watermark,query_json,result_digest,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, binding.product_id, binding.audit_id, taskId ?? null, watermark ?? this.watermark(binding.product_id), JSON.stringify(record), hash(output), now()));
    return { id, ...record.result_ref };
  }
}
Object.assign(ProductMemoryStore.prototype, topologyMethods);
