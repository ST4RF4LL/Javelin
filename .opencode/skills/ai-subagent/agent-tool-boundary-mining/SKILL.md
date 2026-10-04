---
name: agent-tool-boundary-mining
description: Statically mine Agent tool execution RCE, unauthorized API/function/skill/MCP invocation, and framework access-control bypass from source with case-grounded trust-boundary evidence. Use for task-board ai tasks selecting agent-tool-boundaries.v1; does not build attack prompts or execute validation.
---

# Agent 工具与框架边界挖掘

执行附件中的单个静态任务。使用 `agent_mining.plan_path` 和 `analysis_path`，先检查 plan_sha256，再读取 `session_path` 中的真实会话标识。源码只读，不执行目标、加载目标模块、调用目标工具或开展 prompt/动态验证。输出是候选，不是真伪裁决。

## 分析顺序

1. 读取计划的 inventory 和当前任务。定位器只提供词法线索，没有证明调用关系；按源码查找注册、名称/别名解析、分派、权限策略、实际副作用。无命中也要检查通用 wrapper、注册表和配置，并保留无法证明的范围。
2. 非 blind 轨道阅读相关的知识快照：保留 source.sha256、quality、curation、facets 和警告。只借鉴成立条件与反例；不运行案例命令，不把旧版本漏洞投射到当前项目。追加知识检索沿用 knowledge-query 只读接口，当前候选的机器引用仅使用计划已绑定的案例。其他参考保留为调查笔记，不能冒充本次已绑定引用。blind 不读取或接收任何案例内容。
3. 以 **调用者 → 工具注册/分派 → 参数变换 → 权限检查 → 执行身份/副作用** 建立连续链。分别分析 API call、function call、skill、MCP，远端实现不可见就保留缺口，不能把客户端发起请求直接等同远端 RCE。
4. 检查三个问题：工具输入能否变成未获准执行的代码；工具调用能否绕过执行侧策略；框架是否在匿名回退、工作区、会话、委派、恢复和替代传输上丢失权限。详见 [references/boundaries.md](references/boundaries.md)。
5. 在 analysis_path 填写 [references/analysis-contract.md](references/analysis-contract.md) 中的紧凑对象。模板的 GAP 不能无证据改为 INSPECTED。尽早按一条链完成证据，复用定位对象，不编写大量报告拼装脚本或重复生成长篇报告。
6. 调用 `node <附件 agent_mining_cli> finish --plan <plan_path> --analysis <analysis_path> --session <session_path> --source-root <source_root>`。这是制品完整性检查和报告生成，不执行漏洞验证。若格式出错，只修正具体字段。成功生成 report.json 和 receipt.json 后立即结束。

`UNKNOWN` 表示尚未确认，不能转换成缺少控制。源码证据不足时保持 GAP 或 LEAD；源码摘要变化时不得篡改计划摘要，保留当前任务缺口。该配置不产生 `runtime_requests`、攻击 prompt、payload 或动态证据。
