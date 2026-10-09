import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Source, WorkbenchRuntime } from '../shared/contracts.js';

@Injectable()
export class RuntimeService {
  readonly config: WorkbenchRuntime;
  constructor() {
    const mode = process.env.WORKBENCH_MODE || 'preview';
    if (mode !== 'preview' && mode !== 'integrated') throw new Error('WORKBENCH_MODE 仅支持 preview 或 integrated。');
    this.config = { mode, defaultSource: mode === 'integrated' ? 'live' : 'demo', demoEnabled: mode === 'preview', liveReadOnly: !(mode === 'integrated' && process.env.WORKBENCH_ENABLE_TASKS === '1'), legacyUrl: process.env.WORKBENCH_LEGACY_ENABLED === '1' ? 'http://127.0.0.1:4173/' : null, featureVersion: 2 };
  }
  assertWritable() { if (this.config.liveReadOnly) throw new ForbiddenException('当前入口只读。请使用新平台运行命令启动任务模式。'); }
  source(value?: string): Source {
    const source = value || this.config.defaultSource;
    if (source !== 'demo' && source !== 'live') throw new BadRequestException('数据源无效。');
    if (source === 'demo' && !this.config.demoEnabled) throw new ForbiddenException('融合入口仅接入真实平台，演示请使用独立预览入口。');
    return source;
  }
}
