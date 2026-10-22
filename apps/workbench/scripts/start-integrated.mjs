const { listenOptions, listenHelp, listenOrigin } = await import('../build/api/server/listen-options.js');
const { host, port, help } = listenOptions(process.argv.slice(2));
if (help) { process.stdout.write(`${listenHelp}\n`); process.exit(0); }
process.env.WORKBENCH_HOST = host; process.env.WORKBENCH_PORT = String(port);
process.env.WORKBENCH_MODE = 'integrated';
process.env.WORKBENCH_ENABLE_TASKS = '0';
await import('../build/api/server/main.js').then(async ({ createApp }) => {
  const app = await createApp();
  app.enableShutdownHooks();
  await app.listen(port, host);
  process.stdout.write(`新版融合入口：${listenOrigin(host, port)}（真实数据只读；原工作台保持独立）\n`);
});
