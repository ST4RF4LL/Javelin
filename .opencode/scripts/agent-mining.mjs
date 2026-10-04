#!/usr/bin/env node
import { prepareMining, finishMining } from "../lib/agent-mining/service.mjs";
import { PROFILE } from "../lib/agent-mining/profile.mjs";

try {
  const [command, ...args] = process.argv.slice(2), options = {};
  const allowed = command === "prepare" ? ["source-root", "output-root", "audit", "task", "attempt", "scope-digest", "track", "families", "knowledge-root"]
    : command === "finish" ? ["plan", "analysis", "session", "source-root"] : [];
  if ([undefined, "--help", "-h"].includes(command)) {
    process.stdout.write("Agent 静态漏洞挖掘（不执行目标、不构建攻击 prompt、不进行动态测试）\nprepare --source-root PATH --output-root PATH --audit ID --task ID --attempt ID --scope-digest SHA [--track coverage|seeded-variant|blind] [--families TOOL_RCE,TOOL_AUTHZ,FRAMEWORK_ACCESS] [--knowledge-root PATH]\nfinish --plan PATH --analysis PATH --session PATH [--source-root PATH]\n");
  } else {
    if (!allowed.length || args.length % 2) throw new Error("挖掘命令或参数无效。");
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index].slice(2), value = args[index + 1];
      if (!args[index].startsWith("--") || !allowed.includes(key) || Object.hasOwn(options, key) || !value || value.includes("\0")) throw new Error("挖掘参数重复或不受支持。");
      options[key] = value;
    }
    const required = command === "prepare" ? ["source-root", "output-root", "audit", "task", "attempt", "scope-digest"] : ["plan", "analysis", "session"];
    if (required.some(key => !options[key])) throw new Error(`缺少必需参数：${required.filter(key => !options[key]).join("、")}`);
    const result = command === "prepare"
      ? await prepareMining({ sourceRoot: options["source-root"], outputRoot: options["output-root"], auditId: options.audit, taskId: options.task, attemptId: options.attempt,
        scopeDigest: options["scope-digest"], knowledgeRoot: options["knowledge-root"], config: { profile: PROFILE, track: options.track ?? "coverage", ...(options.families ? { families: options.families.split(",") } : {}) } })
      : await finishMining({ planPath: options.plan, analysisPath: options.analysis, sessionPath: options.session, sourceRoot: options["source-root"] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: "ERROR", reason: error.message })}\n`); process.exitCode = 2;
}
