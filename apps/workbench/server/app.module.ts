import { Body, Controller, Get, Headers, Module, Param, Post, Query, Sse, BadRequestException, StreamableFile } from '@nestjs/common';
import { DemoService } from './demo.service.js';
import { LiveService } from './live.service.js';
import { RuntimeService } from './runtime.service.js';
import { WORKBENCH_API_VERSION } from '../shared/contracts.js';

@Controller('api/workbench')
class WorkbenchController {
  constructor(private readonly demo: DemoService, private readonly live: LiveService, private readonly runtime: RuntimeService) {}
  private service(source?: string) { return this.runtime.source(source) === 'live' ? this.live : this.demo; }
  @Get('config') config() { return this.runtime.config; }
  @Get('health') health() { return { status: 'ok', apiVersion: WORKBENCH_API_VERSION, framework: 'NestJS + Fastify', ...this.runtime.config }; }
  @Get('snapshot') snapshot(@Query('source') source: string) { return this.service(source).snapshot(); }
  @Get('findings') findings(@Query() query: Record<string, string>) { return this.service(query.source).findings(query.audit_id, query); }
  @Get('reports/:id') report(@Param('id') id: string, @Query('source') source: string) { this.requireLive(source); return this.live.report(id); }
  @Get('reports/:id/download') async reportDownload(@Param('id') id: string, @Query('source') source: string) {
    this.requireLive(source); const result = await this.live.downloadReport(id);
    return new StreamableFile(result.bytes, { type: 'text/markdown; charset=utf-8', disposition: `attachment; filename="${result.filename}"` });
  }
  private requireLive(source: string) { if (this.runtime.source(source) !== 'live') throw new BadRequestException('演示报告请使用演示下载。'); }
  @Get('audits') audits(@Query() query: Record<string, string>) { return this.service(query.source).list(query); }
  @Get('audits/:id') detail(@Param('id') id: string, @Query('source') source: string) { return this.service(source).get(id); }
  @Sse('audits/:id/events') events(@Param('id') id: string, @Query('source') source: string, @Headers('last-event-id') lastEventId = '') {
    return this.runtime.source(source) === 'live' ? this.live.stream(id, lastEventId) : this.demo.stream(id, Number(lastEventId) || 0);
  }
  @Get('task-options') options() { this.runtime.assertWritable(); return this.live.options(); }
  @Get('task-products') taskProducts() { this.runtime.assertWritable(); return this.live.taskProducts(); }
  @Get('task-models') taskModels() { this.runtime.assertWritable(); return this.live.taskModels(); }
  @Get('task-runner') taskRunner() { this.runtime.assertWritable(); return this.live.taskRunner(); }
  @Get('products/:productId/targets') targets(@Param('productId') productId: string) { this.runtime.assertWritable(); return this.live.targets(productId); }
  @Post('products/:productId/targets') registerTarget(@Param('productId') productId: string, @Body() body: Record<string, unknown>) { this.runtime.assertWritable(); return this.live.registerTarget(productId, body || {}); }
  @Post('audits') create(@Query('source') source: string, @Body() body: Record<string, unknown>, @Headers('idempotency-key') key: string) {
    if (this.runtime.source(source) === 'demo') return this.demo.create(body || {});
    this.runtime.assertWritable(); return this.live.create(body || {}, key);
  }
  @Post('audits/:id/actions') action(@Param('id') id: string, @Query('source') source: string, @Body() body: { action: string; version: number }, @Headers('idempotency-key') key: string) {
    if (this.runtime.source(source) === 'demo') {
      if (!body || !Number.isInteger(body.version)) throw new BadRequestException('任务版本无效。');
      return this.demo.action(id, body.action, body.version);
    }
    this.runtime.assertWritable(); return this.live.action(id, body || {}, key);
  }
  @Post('audits/:id/retry-draft') retryDraft(@Param('id') id: string) { this.runtime.assertWritable(); return this.live.retryDraft(id); }
}

@Module({ providers: [DemoService], exports: [DemoService] }) class DemoModule {}
@Module({ providers: [LiveService], exports: [LiveService] }) class LiveModule {}
@Module({ imports: [DemoModule, LiveModule], providers: [RuntimeService], controllers: [WorkbenchController] })
export class AppModule {}
