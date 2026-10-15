import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hash, atomicJson, selectMiningStrategy, deliveryOutcome, PROTOCOL } from '../lib/task-board/contract.mjs';
import { createBoard, TaskBoardStore, readBoard } from '../lib/task-board/store.mjs';
import { TaskBoardService } from '../lib/task-board/service.mjs';
import { prepareReview, acceptReview, finalizeBoard, verifyBoardCompletion } from '../lib/task-board/review.mjs';
import { fileFocusCoverage } from '../web/dynamic-validation-observatory/file-focus-coverage.mjs';
import { AuditRunner } from '../web/dynamic-validation-observatory/audit-runner.mjs';
import { applyAuditProgress } from '../web/dynamic-validation-observatory/audit-progress.mjs';
import { incrementalPlan, reopenIncremental } from '../lib/task-board/incremental.mjs';
const exec = promisify(execFile), auditId = 'audit-file-sweep-test', scope = 'a'.repeat(64);
const cli = resolve('.opencode/scripts/task-board.mjs');
async function fixture(t, contents = { 'auth.py': 'def auth():\n  return True\n', 'config.yml': 'debug: true\n', 'image.png': Buffer.from([0,1,2]) }) {
 const root = await mkdtemp(join(tmpdir(), 'file-sweep-')), sourceRoot = join(root, 'source'), reportsRoot = join(root, 'reports'), path = join(root, 'board.json');
 await mkdir(sourceRoot); await mkdir(reportsRoot);
 const files=[];
 for (const [name, content] of Object.entries(contents)) { await writeFile(join(sourceRoot,name),content); files.push({file_id:'file:'+hash(name).slice(0,24),path:name,type:'file',size:Buffer.byteLength(content),sha256:hash(content),content_kind:Buffer.isBuffer(content)?'binary':'source'}); }
 const manifest={audit_id:auditId,scope_digest:scope,root:sourceRoot,complete:true,files,exclusions:[],errors:[],policy:{}};
 const manifestPath=join(root,'manifest.json'); await atomicJson(manifestPath,manifest);
 await createBoard({path,auditId,miningStrategy:'file_sweep',bacMode:'off'});
 const store=await new TaskBoardStore({path,reportsRoot,auditId,scopeDigest:scope}).open(); await store.initializeFiles(manifest);
 t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true});});
 return {root,sourceRoot,reportsRoot,path,manifest,manifestPath,store};
}
const area=(file,id='fa-auth')=>({task_id:id,kind:'focus_area',title:'核查认证控制',domain:'python',source_ref:file.file_id,prompt:'核查入口到权限守卫的真实调用关系。',code_refs:[{path:file.path,line:1}]});
test('增量审计重开有缺口的文件浏览，保留已浏览和排除项，不接收旧浏览回执', async t => {
 const f=await fixture(t);
 const first=await browse(f,f.manifest.files[0].file_id); await f.store.completeFile(completion(first),f.sourceRoot);
 const second=await browse(f,f.manifest.files[1].file_id);
 await f.store.completeFile({...second,outcome:'GAP',summary:'已读配置，但尚未核对配置消费者'},f.sourceRoot); await f.store.seal({empty_reason:'无已发布疑点'});
 const before=f.store.snapshot(); assert.equal((await incrementalPlan(before,f.reportsRoot)).files.length,1);
 await reopenIncremental(f.store,'f'.repeat(64));
 const after=f.store.snapshot(); assert.equal(after.publication.state,'OPEN');
 assert.deepEqual(after.file_sweep.files[0],before.file_sweep.files[0]); assert.deepEqual(after.file_sweep.files[2],before.file_sweep.files[2]);
 assert.equal(after.file_sweep.files[1].status,'PENDING');
 await assert.rejects(f.store.completeFile({...second,outcome:'GAP',summary:'迟到回执'},f.sourceRoot));
 const retry=await browse(f,second.file_id); await f.store.completeFile(completion(retry),f.sourceRoot);
 await f.store.seal({empty_reason:'补充浏览后无疑点'}); assert.equal(f.store.summary().file_sweep.gap_files,0);
});
const completion=(file,ids=[])=>({file_id:file.file_id,attempt_id:file.attempt_id,outcome:'BROWSED',summary:'已浏览文件职责、输入和控制条件；需要进一步核查的区域已关联任务。',task_ids:ids});
async function browse(f,id) {const file=await f.store.claimFile({file_id:id});await f.store.readFile(f.sourceRoot,{...file,start_line:1,limit:300});return file;}
async function quality(f,ref,overrides={}) {
 const value={protocol:PROTOCOL,audit_id:auditId,input_sha256:ref.sha256,role:'REPORT_REVIEW',agent_session_id:'quality-real-fixture',assessments:[],file_discovery:{status:'REVIEWED',reason:'已核对逐文件初筛记录与相关源码。',evidence_refs:['auth.py:1'],gaps:[]},...overrides};
 const path='validation/quality.json'; await atomicJson(join(f.reportsRoot,path),value);return {path,sha256:hash(await readFile(join(f.reportsRoot,path)))};
}
test('第三种策略产出 Focus Area；浏览、发布、读取范围与任务领取独立推进',async t=>{
 const f=await fixture(t);assert.equal(selectMiningStrategy('file_sweep'),'file_sweep');assert.throws(()=>selectMiningStrategy('file_sweep','GET /'),/不接收/);
 const first=await f.store.claimFile({});assert.equal(f.store.summary().file_sweep.eligible_files,2);assert.equal(f.store.summary().file_sweep.excluded_files,1);
 await assert.rejects(()=>f.store.seal(),/未完成浏览/);
 await assert.rejects(()=>f.store.completeFile(completion(first),f.sourceRoot),/尚未完整读取/);
 await f.store.readFile(f.sourceRoot,{...first,start_line:2,limit:1});await assert.rejects(()=>f.store.completeFile(completion(first),f.sourceRoot),/尚未完整读取/);
 await f.store.readFile(f.sourceRoot,{...first,start_line:1,limit:1});await f.store.publish({tasks:[area(first)]});
 assert.ok(await f.store.claim('python',60000));assert.equal(f.store.summary().publication,'OPEN');
 await assert.rejects(()=>f.store.completeFile(completion(first),f.sourceRoot),/遗漏/);
 await f.store.completeFile(completion(first,['fa-auth']),f.sourceRoot);
 assert.equal((await f.store.completeFile(completion(first,['fa-auth']),f.sourceRoot)).duplicate,true);
 await f.store.publish({tasks:[area(first)]});assert.equal(f.store.summary().total,1);
 const second=await browse(f,f.manifest.files[1].file_id);await f.store.completeFile(completion(second,['fa-auth']),f.sourceRoot);
 await f.store.seal();assert.equal(f.store.summary().mining_complete,false);
 const coverage=fileFocusCoverage({audit:{id:auditId,source_baseline:{scope_digest:scope}},manifest:f.manifest,board:f.store.snapshot(),browse_status:'BROWSED',limit:1});
 assert.equal(coverage.total,2);assert.equal(coverage.file_sweep.browsed_files,2);assert.equal(coverage.summary.associated_files,2);assert.equal(coverage.summary.total_files,3);
 await assert.rejects(()=>f.store.claimFile({file_id:first.file_id}),/封存/);
});
test('中断后保留已浏览与已发布记录，旧尝试失效；未完成文件继续领取',async t=>{
 const f=await fixture(t);const first=await browse(f,f.manifest.files[0].file_id);await f.store.publish({tasks:[area(first)]});await f.store.completeFile(completion(first,['fa-auth']),f.sourceRoot);
 const pending=await f.store.claimFile({});await f.store.readFile(f.sourceRoot,{...pending});await f.store.close();
 const recovered=await new TaskBoardStore({path:f.path,reportsRoot:f.reportsRoot,auditId,scopeDigest:scope}).open();t.after(()=>recovered.close());
 await recovered.initializeFiles(f.manifest);assert.equal(recovered.summary().file_sweep.browsed_files,1);assert.equal(recovered.summary().total,1);
 const next=await recovered.claimFile({file_id:pending.file_id});assert.notEqual(next.attempt_id,pending.attempt_id);
 await assert.rejects(()=>recovered.completeFile(completion(pending),f.sourceRoot),/失效/);
 await recovered.completeFile({...completion(next),outcome:'GAP',summary:'文件后续业务上下文未能核实。'},f.sourceRoot);
 await recovered.seal();assert.equal(recovered.summary().file_sweep.gap_files,1);
});
test('源码变化、跨根链接、未知文件与伪造发布关系不能增加浏览数',async t=>{
 const f=await fixture(t);const file=await browse(f,f.manifest.files[0].file_id);
 await writeFile(join(f.sourceRoot,file.path),'changed');await assert.rejects(()=>f.store.completeFile(completion(file),f.sourceRoot),/摘要已变化/);
 await assert.rejects(()=>f.store.readFile(f.sourceRoot,{...file}),/摘要已变化/);
 await rm(join(f.sourceRoot,file.path));await symlink(join(f.root,'outside'),join(f.sourceRoot,file.path));await assert.rejects(()=>f.store.readFile(f.sourceRoot,{...file}),/链接/);
 await assert.rejects(()=>f.store.publish({tasks:[{...area(file),source_ref:'file:missing'}]}),/冻结清单/);
 await assert.rejects(()=>f.store.completeFile({...completion(file,['nonexistent']),outcome:'GAP'},f.sourceRoot),/尚未上榜/);
 assert.equal(f.store.summary().file_sweep.browsed_files,0);
});
test('零 Area 仍复核浏览记录，封存发现阶段报告；不能冒充深入审计',async t=>{
 const f=await fixture(t,{'auth.py':'# 配置说明\n'});const file=await browse(f,f.manifest.files[0].file_id);await f.store.completeFile(completion(file),f.sourceRoot);await f.store.seal({empty_reason:'逐文件初筛未识别需要进一步深入分析的区域。'});
 const ref=await prepareReview(f.store);const input=JSON.parse(await readFile(join(f.reportsRoot,ref.path)));assert.ok(input.file_discovery);assert.equal(input.tasks.length,0);
 const bad=await quality(f,ref,{file_discovery:undefined});await assert.rejects(()=>acceptReview(f.store,{quality:bad}),/独立质量复核/);
 const good=await quality(f,ref);await acceptReview(f.store,{quality:good});const result=await finalizeBoard(f.store);assert.equal(result.delivery_outcome,'DISCOVERY_ONLY');
 const report=await readFile(join(f.reportsRoot,result.report_path),'utf8');assert.match(report,/文件已浏览 1\/1/);assert.match(report,/仅交付文件浏览/);assert.doesNotMatch(report,/API 任务：/);
 const verified=await verifyBoardCompletion({audit:{id:auditId,mining_strategy:'file_sweep',task_board_path:f.path,source_baseline:{scope_digest:scope}},reportsRoot:f.reportsRoot});assert.deepEqual(verified.errors,[]);
 await finalizeBoard(f.store);
});
test('实际读取失败可以保留缺口收尾，但不能用预算不足跳过未读文件',async t=>{
 const f=await fixture(t,{'auth.py':'# source'});const file=await f.store.claimFile({});
 await assert.rejects(()=>f.store.completeFile({...completion(file),outcome:'GAP',summary:'本轮预算不足。'},f.sourceRoot),/不能直接登记 GAP/);
 await writeFile(join(f.sourceRoot,'auth.py'),'changed');await assert.rejects(()=>f.store.readFile(f.sourceRoot,file),/摘要已变化/);
 await f.store.completeFile({...completion(file),outcome:'GAP',summary:'当前编码与工具无法完成浏览。'},f.sourceRoot);await f.store.seal({empty_reason:'文件浏览存在缺口。'});
 assert.equal(deliveryOutcome(f.store.summary()),'NO_REPORTS');const ref=await prepareReview(f.store);await assert.rejects(async()=>acceptReview(f.store,{quality:await quality(f,ref)}),/必须保留/);
 const q=await quality(f,ref,{file_discovery:{status:'GAP',reason:'文件尚未实际浏览。',evidence_refs:['浏览记录'],gaps:['需补充浏览']}});await acceptReview(f.store,{quality:q});const result=await finalizeBoard(f.store);assert.equal(result.delivery_outcome,'NO_REPORTS');assert.match(await readFile(join(f.reportsRoot,result.report_path),'utf8'),/当前编码与工具无法完成浏览/);
});
test('真实 CLI → HTTP 服务 → 逐文件记录 → 流式 Focus Area worker，暂停不接收旧浏览结果',async t=>{
 const f=await fixture(t);await f.store.close();let workers=0;
 const service=new TaskBoardService({path:f.path,reportsRoot:f.reportsRoot,privateRoot:join(f.root,'service'),workspaceRoot:f.root,sourceRoot:f.sourceRoot,auditId,scopeDigest:scope,fileManifestPath:f.manifestPath,worker:async({input,job})=>{
  workers++;await atomicJson(input.report_path,{summary:'核查真实调用后交付测试报告。',findings:[],gaps:[]});await atomicJson(input.receipt_path,{protocol:PROTOCOL,audit_id:auditId,task_id:job.task.task_id,attempt_id:job.attempt.attempt_id,outcome:'REPORTED',report_path:'report.json'});
 }});await service.start();t.after(()=>service.shutdown());
 const run=async(...args)=>JSON.parse((await exec(process.execPath,[cli,...args],{env:{...process.env,AUDIT_TASK_PROTOCOL:PROTOCOL,AUDIT_TASK_BOARD_CONNECTION_PATH:service.connectionPath},maxBuffer:1024*1024})).stdout);
 const input=async(name,body)=>{const path=join(f.root,name+'.json');await atomicJson(path,body);return path;};
 assert.equal((await run('files','PENDING','0')).total,2);const file=await run('file-claim');await run('file-read',await input('read',file));await run('publish',await input('publish',{tasks:[area(file)]}));await run('file-complete',await input('done',completion(file,['fa-auth'])));
 for(let i=0;i<100&&service.store.summary().reported!==1;i++)await new Promise(r=>setTimeout(r,20));
 assert.equal(workers,1);assert.equal(service.store.summary().reported,1);assert.equal(service.store.summary().publication,'OPEN');
 const next=await run('file-claim');await service.pause();
 await assert.rejects(()=>run('file-complete',join(f.root,'done.json')),/暂停/);service.resume();
 await assert.rejects(()=>service.store.completeFile({...completion(next),outcome:'GAP'},f.sourceRoot),/失效/);
});
test('逐文件范围包含 Git 忽略文件及项目 reports/.opencode，显式列出安装依赖排除',async t=>{
 const root=await mkdtemp(join(tmpdir(),'file-sweep-manifest-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'reports'));await mkdir(join(root,'.opencode'));await mkdir(join(root,'node_modules'));await writeFile(join(root,'reports','business.py'),'x=1');await writeFile(join(root,'.opencode','agent.md'),'instructions');await writeFile(join(root,'node_modules','dependency.js'),'dependency');await writeFile(join(root,'.gitignore'),'hidden.py');await writeFile(join(root,'hidden.py'),'x=2');
 const output=join(tmpdir(),'sweep-manifest-'+Date.now()+'.json');t.after(()=>rm(output,{force:true}));
 await exec(process.execPath,['.opencode/skills/common-subagent/audit-coverage-accounting/scripts/build-scope-manifest.mjs','--root',root,'--audit-id',auditId,'--output',output,'--profile','file-sweep']);
 const manifest=JSON.parse(await readFile(output));assert.ok(manifest.files.some(f=>f.path==='reports/business.py'));assert.ok(manifest.files.some(f=>f.path==='.opencode/agent.md'));assert.ok(manifest.files.some(f=>f.path==='hidden.py'));assert.ok(manifest.exclusions.some(row=>row.path==='node_modules'));assert.equal(manifest.policy.profile,'file-sweep');
});

test('Web Runner 创建逐文件任务并完成发布、领取、复核和封存，自审计排除实际运行输出', async t => {
 const root = await mkdtemp(join(tmpdir(), 'file-sweep-runner-')), source = await realpath(root);
 const configPath = join(source, '.opencode', 'opencode.json');
 await mkdir(join(source, 'reports')); await writeFile(join(source, 'reports', 'business.py'), 'def business():\n  return True\n');
 await atomicJson(configPath, { mcp: {} });
 const child = new EventEmitter(); child.pid = 12345; child.stdout = new PassThrough(); child.stderr = new PassThrough();
 child.kill = signal => { if (signal === 'SIGTERM') queueMicrotask(() => child.emit('close', 0, signal)); return true; };
 let launch;
 const runner = new AuditRunner({ stateRoot: join(root, 'state'), platformRoot: root, configPath, enabled: true,
   terminalMonitor: { async probe() { return { available: false, message: '受控进程替身' }; }, async stop() {} },
   spawnProcess(command, args, options) { launch = { command, args, options }; return child; } });
 t.after(async () => { await runner.shutdown(); await rm(root, { recursive: true, force: true }); });
 runner.setQueueScheduler({ async enqueueNewAudit() { return true; } });
 const snapshot = { target_id: 'fixture', target_name: '逐文件测试项目', source_scopes: [{ id: 'source-one', path: source }] };
 const created = await runner.createAuditFromTarget({ audit_id: auditId, target_id: 'fixture', execution_spec: snapshot,
   execution_spec_digest: hash(JSON.stringify(snapshot)), mining_strategy: 'file_sweep', bac_analysis: 'off' }, 'file-sweep-runner-test');
 assert.equal((await runner.retryDraft(created.id)).mining_strategy, 'file_sweep');
 await runner.dispatchQueuedAudit(created.id);
 assert.match(launch.args.at(-1), /file_sweep/); assert.match(launch.args.at(-1), /直接通过 publish/);
 assert.equal(launch.options.env.AUDIT_MINING_STRATEGY, 'file_sweep');
 assert.match(launch.args.at(-1), /动态验证为 SKIPPED/);
 const service = runner.taskBoardServices.get(created.id), store = service.store;
 const manifest = JSON.parse(await readFile(runner.getAudit(created.id).source_baseline.path));
 assert.deepEqual(manifest.files.map(f => f.path).sort(), ['.opencode/opencode.json', 'reports/business.py']);
 assert.ok(manifest.exclusions.some(row => row.path === 'reports/repositories'));
 assert.ok(manifest.exclusions.some(row => row.path === 'state'));
 service.worker = async ({ job, input }) => {
   await atomicJson(input.report_path, { summary: '已核对业务函数的实际调用关系。', findings: [], gaps: [] });
   await atomicJson(input.receipt_path, { protocol: PROTOCOL, audit_id: auditId, task_id: job.task.task_id, attempt_id: input.attempt_id, outcome: 'REPORTED', report_path: 'report.json' });
 };
 for (const row of manifest.files) {
   const file = await store.claimFile({ file_id: row.file_id }); await store.readFile(source, file);
   const ids = row.path.endsWith('.py') ? ['fa-business'] : [];
   if (ids.length) { await store.publish({ tasks: [area(file, ids[0])] }); service.pump(); }
   await store.completeFile(completion(file, ids), source);
 }
 const beforeSeal = applyAuditProgress({ status: 'running', task_board: store.summary() });
 assert.equal(beforeSeal.stage, '逐文件浏览与任务发布'); assert.match(beforeSeal.progress_text, /文件已浏览 2\/2/);
 await store.seal(); service.pump();
 const deadline = Date.now() + 3000;
 while (!store.summary().mining_complete && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
 assert.equal(store.summary().reported, 1);
 const inputRef = await prepareReview(store);
 const q = await quality({ reportsRoot: service.reportsRoot }, inputRef, { assessments: store.snapshot().tasks.map(task => ({ task_id: task.task_id, status: 'REVIEWED', reason: '已核对任务范围及源码。', evidence_refs: ['reports/business.py:1'], gaps: [] })) });
 await acceptReview(store, { quality: q }); const finalized = await finalizeBoard(store);
 assert.equal(finalized.delivery_outcome, 'DELIVERED');
 const page = await runner.fileCoveragePage(created.id, { browse_status: 'BROWSED' });
 assert.equal(page.file_sweep.browsed_files, 2); assert.equal(page.summary.associated_files, 1);
 child.emit('close', 0, null);
 const finish = Date.now() + 3000;
 while (runner.getAudit(created.id).status === 'running' && Date.now() < finish) await new Promise(r => setTimeout(r, 10));
 assert.equal(runner.getAudit(created.id).status, 'completed', runner.getAudit(created.id).error);
 assert.equal(runner.taskBoardServices.size, 0);
});
