import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../build/api/server/main.js';
import { LiveService } from '../build/api/server/live.service.js';
import { createUpstreamTransport } from '../build/api/server/upstream-transport.js';
import { inProcessRequester } from './helpers/in-process-http.mjs';
import { AuditRunner } from '../../../.opencode/web/dynamic-validation-observatory/audit-runner.mjs';
import { createAuditWorkbenchServer } from '../../../.opencode/web/dynamic-validation-observatory/server.mjs';

let root, backend, app, direct, sealedAt;
const calls = [];
const auditId = 'audit-read-pages-fixture';
const bytes = Buffer.from('\ufeff# 完整安全审计报告\r\n\r\n| 风险 | 证据 |\r\n| --- | --- |\r\n| 高危 | src/auth.ts:42 |\r\n\r\n<script>fixture()</script>\r\n\r\n' + '## 中文发现\n\n判断、证据及修复建议。\n'.repeat(500));
const names = ['WORKBENCH_MODE', 'WORKBENCH_ENABLE_TASKS', 'WORKBENCH_UPSTREAM', 'WORKBENCH_DIAGNOSTICS_DIR', 'WORKBENCH_MODEL_SOURCE'];
const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
const request = path => app.inject({ url: `/api/workbench/${path}` });

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'workbench-read-pages-'));
  const source = join(root, 'source'); const config = join(root, 'opencode.json');
  await mkdir(source); await writeFile(join(source, 'fixture.txt'), 'isolated source');
  await writeFile(config, JSON.stringify({ provider: { fixture: { models: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`model-${i}`, { name: `模型 ${i}` }])) } } }));
  const runner = new AuditRunner({ stateRoot: join(root, 'runs'), platformRoot: root, configPath: config, repositories: [{ id: 'fixture-repo', name: '隔离源码', path: source }], enabled: true, environment: {}, spawnProcess: () => { throw new Error('禁止启动 Agent'); } });
  await runner.ready;
  const artifacts = runner.artifactSources()[0].reports_root;
  await mkdir(join(artifacts, 'final'), { recursive: true }); await mkdir(join(artifacts, 'correlation'));
  const reportPath = join(artifacts, 'final', `security-audit-report.${auditId}.md`);
  await writeFile(reportPath, bytes); sealedAt = (await stat(reportPath)).mtime.toISOString();
  await writeFile(join(artifacts, 'correlation', 'findings.json'), JSON.stringify({ audit_id: auditId, canonical_findings: Array.from({ length: 61 }, (_, i) => ({ id: `finding-${i}`, title: `发现 ${i}`, severity: i < 51 ? 'HIGH' : 'LOW', description: i === 60 ? '唯一检索标记' : '受控判断摘要', locations: [{ path: 'src/auth.ts', line: i + 1 }], evidence: { facts: [{ kind: 'source', claim: '受控源码证据' }] }, remediation: '补充授权检查' })) }));
  backend = createAuditWorkbenchServer({ runner, runtimeRoot: join(root, 'runtime'), stateRoot: join(root, 'runs'), platformConfigPath: config, modelConfigPaths: [config], queueScheduler: { ready: Promise.resolve(), shutdown: async () => {}, snapshot: async () => ({ enabled: true, items: [] }) } });
  await backend.productCatalogReady; await backend.productAudits.ready;
  Object.assign(process.env, { WORKBENCH_MODE: 'integrated', WORKBENCH_MODEL_SOURCE: 'upstream', WORKBENCH_ENABLE_TASKS: '1', WORKBENCH_UPSTREAM: 'http://127.0.0.1:4173', WORKBENCH_DIAGNOSTICS_DIR: join(root, 'diagnostics') });
  direct = createUpstreamTransport({ http: inProcessRequester(backend.listeners('request')[0], url => calls.push(new URL(url))) });
  app = await createApp(); app.get(LiveService).transport = direct.fetch;
});
after(async () => {
  await app?.close(); direct?.close(); await backend?.shutdownRunners();
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  if (root) await rm(root, { recursive: true, force: true });
});

test('原模型配置、发现、概览可并发穿过新 API 和生产 HTTP 流读取', async () => {
  const responses = await Promise.all(['task-models', 'findings', 'snapshot'].map(request));
  responses.forEach(r => assert.equal(r.statusCode, 200, r.body));
  assert.equal(responses[0].json().models.length, 12); assert.equal(responses[0].json().selectedModel, 'default');
  assert.equal(responses[1].json().count, 61); assert.equal(responses[1].json().findings.length, 50);
  const reports = responses[2].json().reports; assert.equal(reports.length, 1); assert.equal(reports[0].date, sealedAt);
  const summary = responses[2].json().summary;
  assert.equal(summary.validations, 0); assert.equal(summary.severity.high, 51); assert.equal(summary.severity.low, 10);
  assert.equal(summary.targets, responses[2].json().products.reduce((sum, product) => sum + product.targetCount, 0));
});

test('发现列表第二页、风险和关键词筛选由原服务执行，证据及源码行号完整', async () => {
  const page = await request(`findings?page=2&audit_id=${auditId}`); assert.equal(page.statusCode, 200, page.body);
  assert.equal(page.json().count, 61); assert.equal(page.json().page, 2); assert.equal(page.json().totalPages, 2); assert.equal(page.json().findings.length, 11);
  assert.equal(page.json().findings[0].path, 'src/auth.ts:51'); assert.equal(page.json().findings[0].remediation, '补充授权检查'); assert.ok(page.json().findings[0].evidence.length);
  const filtered = await request('findings?severity=high&page=2'); assert.equal(filtered.json().count, 51); assert.equal(filtered.json().findings.length, 1);
  assert.ok(calls.some(url => url.pathname === '/api/v1/findings' && url.searchParams.get('severity') === 'HIGH' && url.searchParams.get('live') === '1'));
  const search = await request(`findings?q=${encodeURIComponent('唯一检索标记')}`); assert.equal(search.json().count, 1); assert.equal(search.json().findings[0].title, '发现 60');
  const absent = await request('findings?audit_id=audit-nonexistent'); assert.equal(absent.statusCode, 200); assert.equal(absent.json().count, 0);
  assert.equal((await request('findings?page=-1')).statusCode, 400);
  assert.equal((await request('findings?severity=bogus')).statusCode, 400);
});

test('报告弹窗接口返回完整正文及原渲染结果，下载逐字节等于封存文件', async () => {
  const reportId = (await request('snapshot')).json().reports[0].id;
  const content = await request(`reports/${reportId}`); assert.equal(content.statusCode, 200, content.body);
  assert.equal(content.json().body, bytes.toString('utf8')); assert.equal(content.json().date, sealedAt);
  assert.match(content.json().html, /<table>/); assert.ok(!content.json().html.includes('<script>')); assert.match(content.json().html, /&lt;script&gt;/);
  assert.equal(content.json().presentation.source_sha256, createHash('sha256').update(bytes).digest('hex'));
  const download = await request(`reports/${reportId}/download`); assert.equal(download.statusCode, 200, download.body);
  assert.match(download.headers['content-type'], /text\/markdown/); assert.match(download.headers['content-disposition'], /^attachment;/); assert.deepEqual(download.rawPayload, bytes);
  assert.ok(calls.some(url => url.pathname.endsWith('/download') && url.searchParams.get('format') === 'original'));
});

test('报告不存在或编号越界时返回真实错误，不展示伪造报告内容', async () => {
  const absent = await request('reports/report-missing'); assert.equal(absent.statusCode, 404); assert.match(absent.json().message, /报告/);
  const invalid = await request('reports/%2E%2E%2Foutside'); assert.equal(invalid.statusCode, 400);
  const absentDownload = await request('reports/report-missing/download'); assert.equal(absentDownload.statusCode, 404); assert.match(absentDownload.headers['content-type'], /application\/json/);
});
