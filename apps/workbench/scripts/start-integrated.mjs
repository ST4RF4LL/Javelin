process.env.WORKBENCH_MODE = 'integrated';
process.env.WORKBENCH_ENABLE_TASKS = '0';
await import('../build/api/server/main.js').then(async ({ createApp }) => {
  const app = await createApp();
  app.enableShutdownHooks();
  const port = Number(process.env.WORKBENCH_PORT || 4181);
  await app.listen(port, '127.0.0.1');
  process.stdout.write(`新版融合入口：http://127.0.0.1:${port}（真实数据只读；原工作台保持独立）\n`);
});
