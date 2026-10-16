import { AsyncLocalStorage } from 'node:async_hooks';
import { tool } from '@opencode-ai/plugin';
import focusAreaWatchdogPlugin from '../../focus-area-watchdog-plugin.mjs';
import nativeAuditSessionPlugin from '../opencode-session-plugin.mjs';
import { createNativeClient } from '../native-client.mjs';
import { operationTimeout } from '../operation-timeout.mjs';
import { normalizeEvent, V2_INSTRUCTIONS } from './opencode-v2.mjs';

const textContent = content => typeof content === 'string' ? content : (content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
const legacyTool = name => name === 'shell' ? 'bash' : name === 'subagent' ? 'task' : name;

// Reuse the audited registration, heartbeat, pause and completion rules while
// translating the host boundary. No v1 plugin is loaded into the v2 host.
export function createV2Plugin({ environment = process.env, api, nativeFactory = nativeAuditSessionPlugin, watchdogFactory = focusAreaWatchdogPlugin } = {}) {
  return { id: 'javelin.audit-runtime', async setup(ctx) {
    const registrations = [], sessions = new Set(), context = new AsyncLocalStorage(), controller = new AbortController();
    const nativeApi = api ?? createNativeClient({ serviceRoot: environment.AUDIT_SERVICE_ROOT });
    const client = { session: {
      abort: ({ path }) => ctx.session.interrupt({ sessionID: path.id }),
      promptAsync: async ({ path, body }) => {
        if (body.agent) await ctx.session.switchAgent({ sessionID: path.id, agent: body.agent });
        return ctx.session.prompt({ sessionID: path.id, text: `${body.parts.map(part => part.text ?? '').join('\n')}\n\n${V2_INSTRUCTIONS}` });
      },
    } };
    const native = environment.AUDIT_TASK_PROTOCOL ? {} : await nativeFactory({ client, directory: ctx.location.directory }, {
      api: { call: (operation, input) => nativeApi.call(operation, operation === 'register'
        ? { ...input, session: { ...input.session, engine: 'opencode-v2' } } : input) },
    });
    const watchdog = await watchdogFactory({ watchdogEnvironment: environment });
    const hooks = [native, watchdog];
    const register = async promise => { const registration = await promise; if (registration) registrations.push(registration); };
    await register(ctx.session.hook('context', async event => {
      const input = { sessionID: event.sessionID, agent: event.agent };
      for (const hook of hooks) await hook['chat.message']?.(input, {});
      const result = { system: [] };
      for (const hook of hooks) await hook['experimental.chat.system.transform']?.(input, result);
      for (const text of result.system) event.system.push({ type: 'text', text });
    }));
    await register(ctx.tool.hook('execute.before', async event => {
      const args = event.input;
      const input = { tool: legacyTool(event.tool), sessionID: event.sessionID, args: event.tool === 'subagent' ? { ...args, subagent_type: args?.agent } : args };
      for (const hook of hooks) await hook['tool.execute.before']?.(input, { args });
    }));
    await register(ctx.tool.hook('execute.after', async event => {
      if (event.status !== 'completed') return;
      const args = event.tool === 'subagent' ? { ...event.input, subagent_type: event.input?.agent } : event.input;
      const original = textContent(event.result.content), result = { output: original };
      for (const hook of hooks) await hook['tool.execute.after']?.({ tool: legacyTool(event.tool), sessionID: event.sessionID, args }, result);
      if (result.output !== original) {
        const suffix = result.output.startsWith(original) ? result.output.slice(original.length) : result.output;
        event.result = { ...event.result, content: Array.isArray(event.result.content)
          ? [...event.result.content, { type: 'text', text: suffix }] : result.output };
      }
      await native.event?.({ event: { type: 'message.part.updated', properties: { part: {
        type: 'tool', tool: event.tool, sessionID: event.sessionID, id: event.id, callID: event.id,
        state: { status: 'completed', input: event.input, output: result.output, time: { end: Date.now() } },
      } } } });
    }));
    await register(ctx.tool.transform(editor => {
      for (const [name, definition] of Object.entries(native.tool ?? {})) editor.add({
        name, options: { codemode: false }, description: definition.description,
        input: tool.schema.object(definition.args),
        execute: async (args, toolContext) => {
          sessions.add(toolContext.sessionID);
          return { content: await definition.execute(args, { ...toolContext, directory: ctx.location.directory }) };
        },
      });
      // v2's shell hook has no sessionID. AsyncLocalStorage carries the actual
      // tool call identity without ever changing process.env or crossing tasks.
      if (native['shell.env']) editor.update('shell', shell => {
        const execute = shell.execute;
        shell.execute = (input, toolContext) => context.run({ sessionID: toolContext.sessionID }, () => execute(input, toolContext));
      });
    }));
    if (native['shell.env']) await register(ctx.shell.hook('create.before', async event => {
      const current = context.getStore();
      if (current) await native['shell.env'](current, { env: event.env });
    }));
    // A platform audit has one persisted timeout budget. Let the platform own
    // those retries; do not multiply it by a second private plugin budget.
    await register(ctx.session.hook('retry', event => {
      if (operationTimeout({ type: 'error', error: event.error }) && (environment.AUDIT_TASK_PROTOCOL || sessions.has(event.sessionID))) event.decision = { retry: false };
    }));
    const events = native.event ? (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (controller.signal.aborted) break;
        const data = event.data ?? {}, sessionID = data.sessionID;
        if (event.type === 'session.created') await native.event({ event: { type: 'session.created', properties: { info: { ...data, id: sessionID } } } });
        else if (event.type === 'session.deleted') { sessions.delete(sessionID); await native.event({ event: { type: 'session.deleted', properties: { sessionID } } }); }
        else if (event.type === 'session.execution.succeeded') await native.event({ event: { type: 'session.idle', properties: { sessionID } } });
        else if (event.type === 'session.execution.failed' || event.type === 'session.step.failed') await native.event({ event: { type: 'session.error', properties: { sessionID, error: normalizeEvent({ type: 'error', error: data.error }).error } } });
        else if (event.type === 'session.text.ended' || event.type === 'session.step.ended') {
          const part = event.type === 'session.text.ended' ? { type: 'text', text: data.text, time: { end: Date.now() } }
            : { type: 'step-finish', tokens: data.tokens, cost: data.cost, reason: data.finish };
          await native.event({ event: { type: 'message.part.updated', properties: { part: { ...part, sessionID, messageID: data.assistantMessageID } } } });
        }
      }
    })().catch(() => {}) : Promise.resolve();
    return async () => {
      controller.abort();
      for (const sessionID of sessions) await native.event?.({ event: { type: 'session.deleted', properties: { sessionID } } });
      await Promise.all(registrations.map(registration => registration.dispose()));
      void events;
    };
  } };
}

export default createV2Plugin();
