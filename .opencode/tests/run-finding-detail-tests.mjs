import test from 'node:test';
import assert from 'node:assert/strict';
import { findingsFromArtifacts } from '../web/dynamic-validation-observatory/workspace-model.mjs';

const artifact = (rows, audit = 'audit-a') => ({ kind: 'correlation', audit_id: audit, path: `correlation/${audit}.json`, data: { canonical_findings: rows } });
const detail = row => findingsFromArtifacts([artifact([{ finding_id: 'finding-a', ...row }])])[0];
const fact = { kind: 'source', claim: '应用参数在此处进入后续调用。', locator: { file: 'src/entry.js', line_start: 9, line_end: 18 } };
test('任务板 evidence 对象数组、字符串数组和 Finding v2 facts 均保留', () => {
  for (const evidence of [[fact], { facts: [fact] }]) {
    const row = detail({ evidence });
    assert.equal(row.evidence[0].text, fact.claim);
    assert.equal(row.locations[0].path, 'src/entry.js'); assert.equal(row.locations[0].line, 9);
    assert.equal(row.evidence[0].location.line_end, 18);
  }
  assert.deepEqual(detail({ evidence: ['证据一', '证据二'] }).evidence.map(row => row.text), ['证据一', '证据二']);
  assert.equal(detail({ evidence: { text: '旧版证据正文' } }).evidence[0].text, '旧版证据正文');
  assert.equal(detail({ evidence_facts: [fact] }).evidence[0].text, fact.claim);
});
test('源码定位兼容字符串、Windows 路径和直接位置对象；不推断不存在的行号', () => {
  for (const location of ['src/entry.js:9-18', '`src/entry.js:L9-L18`', { file: 'src/entry.js', line_start: 9, line_end: 18 }]) {
    const row = detail({ location }); assert.equal(row.location.path, 'src/entry.js'); assert.equal(row.location.line, 9); assert.equal(row.location.line_end, 18);
  }
  assert.equal(detail({ locations: { path: 'src/entry.js', line: 9 } }).location.line, 9);
  assert.equal(detail({ location: 'C:\\repo\\src\\entry.js:9' }).location.path, 'C:\\repo\\src\\entry.js');
  assert.equal(detail({ location: 'src/entry.js' }).location.line, null);
  const prose = detail({ location: '入口函数中，原报告未记录行号' });
  assert.equal(prose.location.path, null); assert.equal(prose.location.line, null); assert.equal(prose.location.detail, '入口函数中，原报告未记录行号');
  assert.deepEqual(detail({}).locations, []); assert.deepEqual(detail({}).evidence, []);
});
test('完整报告的证据引用与 Agent 路径证据进入详情，制品路径不冒充源码定位', () => {
  const row = detail({ evidence_refs: ['src/entry.js:9-18', 'validation/review.json'], review: { evidence_refs: ['src/check.js:12'] },
    agent_mining: { chain: [{ reason: '调用者身份在此传递。', evidence: [{ path: 'src/caller.js', line: 21, end_line: 24 }] }] } });
  assert.ok(row.evidence.some(item => item.text === '调用者身份在此传递。' && item.location.line === 21));
  assert.ok(row.evidence.some(item => item.kind === '复核引用' && item.text === 'src/check.js:12'));
  assert.ok(row.evidence.some(item => item.text === 'validation/review.json'));
  assert.equal(row.locations.some(item => item.path === 'validation/review.json'), false);
  assert.deepEqual(new Set(row.locations.map(item => item.path)), new Set(['src/entry.js', 'src/check.js', 'src/caller.js']));
});
test('仅用同一审计、唯一匹配 ID 的最终报告补充详情，支持 dossier', () => {
  const report = (audit, rows) => ({ kind: 'final', media_type: 'application/json', audit_id: audit, path: `final/task-board-report-model.${audit}.json`, modified_at: '2026-10-22',
    data: { audit_id: audit, protocol: 'task-board.v1', artifact_type: 'task-board-final-report', findings: rows } });
  const rows = [{ finding_id: 'finding-a', dossier: { finding: { locations: { primary: fact.locator }, evidence: { facts: [fact] } } } }];
  const source = artifact([{ finding_id: 'finding-a', title: '原始标题', status: 'unvalidated' }]);
  const matching = report('audit-a', rows);
  const [enriched] = findingsFromArtifacts([source, matching]);
  assert.equal(enriched.evidence[0].text, fact.claim); assert.equal(enriched.location.line, 9);
  assert.equal(enriched.source_path, source.path); assert.equal(enriched.detail_source_path, matching.path);
  assert.equal(enriched.title, '原始标题'); assert.equal(enriched.status, 'unvalidated');
  for (const other of [report('audit-b', rows), report('audit-a', [...rows, ...rows]), report('audit-a', [{ ...rows[0], finding_id: 'other' }])]) {
    const [result] = findingsFromArtifacts([source, other]); assert.equal(result.evidence.length, 0); assert.equal(result.locations.length, 0);
  }
  const deduped = findingsFromArtifacts([artifact([{ finding_id: 'finding-a', evidence: [fact] }]), matching])[0];
  assert.equal(deduped.evidence.length, 1); assert.equal(deduped.locations.length, 1);
});
