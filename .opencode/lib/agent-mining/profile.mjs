export const PROFILE = "agent-tool-boundaries.v1";
export const PROTOCOL = "agent-mining.v1";
export const SURFACES = ["api_call", "function_call", "skill", "mcp"];
export const FAMILIES = {
  TOOL_RCE: { title: "工具执行导致代码执行", catalog_id: "AI-OUTPUT-01", case_id: "CVE-2026-22688",
    question: "低信任参数、工具配置或技能内容是否跨过既有授权/隔离边界，进入命令、代码或模块执行？",
    facts: ["attacker_control", "reachable_execution", "authority_violation", "executable_influence"],
    counterchecks: ["intentional_authorized_execution", "fixed_executable_and_arguments", "sandbox_boundary"] },
  TOOL_AUTHZ: { title: "未授权工具调用", catalog_id: "AI-TOOL-01", case_id: "CVE-2026-53845",
    question: "工具名称解析、参数规范化、skill 直调和 MCP 调度之后，是否仍以实际调用者权限检查最终操作？",
    facts: ["attacker_control", "reachable_execution", "authority_violation", "dispatch_policy_bypass"],
    counterchecks: ["execution_side_policy", "alternate_dispatch_paths", "approval_final_operation_binding"] },
  FRAMEWORK_ACCESS: { title: "Agent 框架访问控制绕过", catalog_id: "AI-ACCESS-01", case_id: "CVE-2026-18891",
    question: "身份、工作区、Agent、会话、任务与资源是否在委派、恢复和替代传输上保持授权绑定？",
    facts: ["attacker_control", "reachable_execution", "authority_violation", "principal_or_resource_mismatch"],
    counterchecks: ["outer_authorization", "parent_resource_binding", "anonymous_and_fallback_identity"] },
};

export function selection(value) {
  if (!value || value.profile !== PROFILE || Object.keys(value).some(key => !["profile", "families", "track"].includes(key))) throw new Error("Agent 挖掘配置无效。");
  const families = value.families ?? Object.keys(FAMILIES), track = value.track ?? "coverage";
  if (!Array.isArray(families) || !families.length || new Set(families).size !== families.length || families.some(key => !Object.hasOwn(FAMILIES, key))) throw new Error("Agent 挖掘风险族无效。");
  if (!["coverage", "seeded-variant", "blind"].includes(track)) throw new Error("Agent 挖掘轨道无效。");
  return { profile: PROFILE, families: [...families], track };
}

// Lexical locators only. None of these patterns proves reachability or a flaw.
export const LOCATORS = [
  ["api_call", /\b(?:router|app)\.(?:get|post|put|patch|delete|route)\b|@(Get|Post|Request)Mapping|\b(?:fetch|axios|requests|httpx)\s*[.(]/i],
  ["function_call", /\b(?:tool_calls?|function_call|registerTool|StructuredTool|BaseTool|tool_registry|toolsAllow|allowed_tools|before_tool_call)\b|@tool\b/],
  ["skill", /\b(?:skills?|SKILL\.md|skill_path|skill_directory|load_skill|skill_command)\b/i],
  ["mcp", /\b(?:mcp|McpServer|FastMCP|CallToolRequestSchema|call_tool|callTool|stdio_client|StdioServerParameters)\b/i],
  ["execution", /\b(?:exec|execFile|spawn|Popen|system|eval|compile|runPythonAsync|create_subprocess_shell|Command|CommandContext)\s*\(|new\s+Function\s*\(|\b(?:shell\s*[:=]\s*(?:true|True)|allow_dangerous_code)\b/],
  ["authorization", /\b(?:authorize|authorization|permission|approval|allowlist|denylist|owner|tenant|workspace_id|superuser|is_admin|before_tool_call)\b/i],
];
