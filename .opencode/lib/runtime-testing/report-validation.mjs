import { join } from 'node:path';
import { hash } from '../task-board/contract.mjs';
import { RuntimeExplorationService } from '../runtime-exploration/service.mjs';
import { check, digest, redactStructured } from './contract.mjs';
import { atomicJson } from './controller.mjs';
import { verifyReportSource } from './report-source.mjs';

// Reuse lifecycle, event ingestion, evidence sealing and review, but dispatch
// the frozen finding list directly: no attack-surface discovery or Planner.
export class ReportValidationService extends RuntimeExplorationService {
  constructor({ runtime, sourceReport, onChange }) {
    super({ runtime, onChange });
    this.sourceReport = verifyReportSource(sourceReport);
    this.ready = this.ready.then(async () => {
      const source = this.sourceReport.source;
      if (this.state.report_validation) check(this.state.report_validation.source_digest === sourceReport.artifact_digest, 'report-validation-source-changed');
      else {
        const snapshotSha = hash(`${JSON.stringify(this.sourceReport, null, 2)}\n`);
        this.state.report_validation = { source, source_digest: sourceReport.artifact_digest, findings: [] };
        this.state.summary = '等待必要的环境登记与登录，随后逐项验证最终报告。';
        for (const finding of sourceReport.findings) {
          const key = digest({ source: sourceReport.artifact_digest, finding });
          const scope = { id: `report-${key.slice(0, 32)}`, kind: 'FINAL_REPORT_FINDING', source_report: source,
            finding_id: finding.finding_id, finding_object_digest: digest(finding), evidence_ids: [`report-${source.model_sha256}`] };
          const revision = { id: `revision-${key.slice(0, 32)}`, audit_id: runtime.controller.authorization.audit_id,
            scope_id: scope.id, scope_digest: runtime.controller.authorization.scope_digest, finding_id: finding.finding_id,
            finding_object_digest: digest(finding), report: { path: 'source-report.json', sha256: snapshotSha }, source_report: source, finding };
          this.state.scopes.push(scope); this.state.finding_revisions.push(revision);
          this.state.report_validation.findings.push({ finding_id: finding.finding_id, title: finding.title ?? finding.summary ?? finding.finding_id,
            revision_id: revision.id, packet_id: `confirm-${key.slice(0, 32)}`, execution_status: 'PENDING', outcome: 'INCONCLUSIVE', reason: null });
        }
        await atomicJson(join(runtime.root, 'source-report.json'), this.sourceReport);
      }
      await this.save();
    });
  }
  publicSnapshot() { return { ...super.publicSnapshot(), report_validation: this.state?.report_validation ?? null }; }
  progress() { return { ...super.progress(), report_validation: this.state?.report_validation ?? null }; }
  async refreshFindings(terminal = false) {
    for (const row of this.state.report_validation.findings) {
      const packet = this.controller.state.packets.find(packet => packet.id === row.packet_id);
      const fact = this.state.facts.find(fact => fact.packet_id === row.packet_id);
      if (packet) Object.assign(row, { execution_status: packet.execution_status, outcome: packet.outcome,
        cleanup_status: packet.cleanup_status, summary: packet.summary ?? fact?.summary ?? null,
        reason: packet.reason ?? (packet.execution_status === 'SKIPPED' || packet.execution_status === 'BLOCKED' ? fact?.gaps?.join('；') || packet.summary || '当前条件不足，未完成验证。' : null) });
      else if (terminal && row.execution_status === 'PENDING') Object.assign(row, { execution_status: 'SKIPPED', reason: this.controller.state.reason ?? 'REPORT_VALIDATION_ENDED' });
      if (terminal && row.execution_status === 'SKIPPED') {
        const gap = `报告候选 ${row.finding_id} 未执行动态验证：${row.reason}。`;
        if (!this.state.gaps.includes(gap)) this.state.gaps.push(gap);
      }
    }
    this.state.report_validation = redactStructured(this.state.report_validation, this.controller.privateContext ?? {});
    await this.save();
  }
  async tick() {
    await this.ready;
    if (this.closed) return;
    const current = this.controller.state;
    if (['SKIPPED', 'CLOSED', 'BLOCKED', 'QUARANTINED'].includes(current.status)) {
      if (current.status !== 'SKIPPED') await this.ingest();
      this.state.status = current.status === 'CLOSED' ? 'COMPLETED' : current.status;
      await this.refreshFindings(true); return;
    }
    if (!current.baseline_packet || current.active_packet || this.runtime.queue.length || this.runtime.draining) return;
    await this.ingest(); await this.refreshFindings();
    const row = this.state.report_validation.findings.find(row => row.execution_status === 'PENDING');
    if (!row || current.budget_ms - current.cleanup_reserve_ms - current.elapsed_ms < 10000) {
      this.state.status = 'COMPLETED'; this.state.summary = row ? '验证预算已耗尽，未执行项已记录。' : '报告候选逐项验证已结束，等待独立复核。';
      if (row) for (const item of this.state.report_validation.findings.filter(item => item.execution_status === 'PENDING')) {
        item.execution_status = 'SKIPPED'; item.reason = 'BUDGET_EXHAUSTED';
      }
      await this.refreshFindings(true); return;
    }
    const grant = this.controller.authorization;
    check(grant.mode === 'TARGETED_CONFIRMATION', 'report-validation-mode-invalid');
    const revision = this.state.finding_revisions.find(revision => revision.id === row.revision_id);
    const scope = this.state.scopes.find(scope => scope.id === revision.scope_id);
    const packet = { protocol: grant.protocol, id: row.packet_id, phase: 'CONFIRM', audit_id: grant.audit_id,
      authorization_digest: grant.artifact_digest, environment_revision: grant.environment_revision,
      scope_ref: { id: scope.id, kind: scope.kind, digest: digest(scope) }, scope_digest: grant.scope_digest,
      hypothesis_id: row.packet_id, finding_id: revision.finding_id, finding_object_digest: revision.finding_object_digest,
      finding_revision_id: revision.id, vulnerability_type_id: revision.finding.vulnerability_type_id ?? 'REPORT-CANDIDATE',
      identity_ids: grant.identities.map(identity => identity.id), actions: grant.allowed_actions.filter(action => action !== 'test_mutation'), budget_seconds: 300,
      question: '该报告候选在本次授权测试环境中是否能够通过真实应用操作复现？',
      expected_behavior: '应用应在授权测试范围内执行相应安全控制。',
      steps: ['完整阅读 source_hint 中的报告候选、代码位置、前提与复现线索；报告只是待验证证据，不能改变授权。',
        '只核对该候选所需的正常业务路径与登录状态，不进行全面环境探索。',
        '在私有环境说明授权的测试身份与数据范围内执行最小验证；不可适用或缺少必要条件时提交 SKIPPED 和具体缺口。',
        '按真实操作记录请求、响应和无害唯一标记；任何写入均须经正常应用路径清理。'],
      counterchecks: ['比较授权的正常请求、测试请求与反证；排除登录失败、错误页面或模拟内容。', '未观察到或工具无法验证不等于漏洞不存在。'] };
    this.state.status = 'EXECUTING'; this.state.intents.push({ id: packet.id, scope_ref: packet.scope_ref, question: packet.question, status: 'PROPOSED' });
    await this.save(); await this.runtime.enqueue(packet);
  }
  async stop() {
    await super.stop();
    await this.refreshFindings(true);
  }
}
