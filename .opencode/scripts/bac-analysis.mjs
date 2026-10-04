#!/usr/bin/env node
import { compareBac, prepareBac, prepareReview, reviewBac } from "../lib/bac/service.mjs";

try {
  const [command, ...rest] = process.argv.slice(2), args = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!/^--[a-z-]+$/.test(rest[i] ?? "") || !rest[i + 1] || Object.hasOwn(args, rest[i].slice(2))) throw new Error("参数无效或重复。");
    args[rest[i].slice(2)] = rest[i + 1];
  }
  const required = keys => {
    for (const key of keys) if (!args[key]) throw new Error(`缺少 --${key}`);
    for (const key of Object.keys(args)) if (!keys.includes(key)) throw new Error(`未知参数 --${key}`);
  };
  let result;
  if (command === "prepare") {
    required(["plan", "source-root", "reports-root", ...(args.task || args.attempt ? ["task", "attempt"] : ["focus-area", "assignment"]), "session", "run-id"]);
    result = await prepareBac({ planPath: args.plan, sourceRoot: args["source-root"], reportsRoot: args["reports-root"], focusAreaId: args["focus-area"], assignmentId: args.assignment,
      taskId: args.task, attemptId: args.attempt, sessionId: args.session, runId: args["run-id"] });
  } else if (command === "compare") {
    required(["request", "reports-root"]);
    result = await compareBac({ requestPath: args.request, reportsRoot: args["reports-root"] });
  } else if (command === "prepare-review") {
    required(["run", "output"]);
    result = await prepareReview({ runPath: args.run, output: args.output });
  } else if (command === "review") {
    required(["run", "review", "reports-root"]);
    result = await reviewBac({ runPath: args.run, reviewPath: args.review, reportsRoot: args["reports-root"] });
  } else if (["--help", "-h", undefined].includes(command)) {
    result = { commands: ["prepare --plan PATH --source-root PATH --reports-root PATH --task ID --attempt ID --session ID --run-id ID", "prepare --plan PATH --source-root PATH --reports-root PATH --focus-area ID --assignment ID --session ID --run-id ID", "compare --request PATH --reports-root PATH", "prepare-review --run PATH --output PATH", "review --run PATH --review PATH --reports-root PATH"],
      note: "纯静态越权分析；先由独立策略会话与源码工作包补齐输入，未知事实保持缺口。" };
  } else throw new Error("未知越权专项命令。");
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: "GAP", reason: error.message })}\n`);
  process.exitCode = 2;
}
