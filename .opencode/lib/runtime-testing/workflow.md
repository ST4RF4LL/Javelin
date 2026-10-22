# 贯穿式运行测试执行契约

本文描述 `AUDIT_RUNTIME_PROTOCOL=runtime-testing.v1` 的历史 Web 执行契约。新版 `runtime-testing.v2` 支持 Web 与 SSH，按完整私有环境原文选择通道；仅有 SSH 时不得要求 HTTP(S) URL 或 Chrome。新版流程和报告定向验证见 [运行测试工作流](../../../docs/runtime-testing-workflow.md)。未设置的历史任务继续原 quick v1/v2 协议，旧 opt-in 不扩展为新授权。新协议的控制器、环境租约、工具代理、预算计时和报告版本路由都是本次新增能力。

## 执行顺序

1. 平台在启动静态审计前冻结授权、环境原文摘要、来源版本与范围摘要。未启用或环境内容为空时，控制器直接输出 SKIPPED；不启动服务、worker、浏览器或网络请求。有内容时完整保存在私有 environment.prompt，不能以字段名或正则匹配结果决定是否启动环境理解。Web 测试使用跨平台的 OpenCode 与 Chrome DevTools MCP，macOS 不因主机系统被拒绝；依赖是否可用由实际工具能力决定。Windows 桌面工具的系统限制只适用于该工具。静态流程正常推进。
2. **CONTACT 与 Recon 并行**：平台自动调度正常环境接触。此阶段不需要 Finding。Agent 先理解完整 environment.prompt，通过 configure_environment 登记目标、实际身份、敏感值和适用的测试数据范围，再用 browser_tools/browser_call 确认登录与正常响应；工具发现不会在登记前启动浏览器。确实缺少信息时由 Agent 说明具体缺口并跳过。专业 Agent/Orchestrator 读取 `node "$AUDIT_RUNTIME_CLI" status` 和 `$AUDIT_RUNTIME_STATE_ROOT/authorization.json`；无法接触环境时保留缺口，不阻塞 Recon。
3. **Threat/Plan**：专业 Agent 结合基线与源码提出可证伪假设，写单独的运行工作包。Orchestrator 只进行格式校验和分派，不阅读源码或判定漏洞。每包默认 5–10 分钟，必须有正常对照和停止条件；无授权不生成待执行队列。
4. **EXPLORE 与源码审计交错**：专业 Agent 完成一个 Focus Area 后可输出探索包，无需先有 Finding。通过 `node "$AUDIT_RUNTIME_CLI" enqueue <包的绝对路径>` 入队后立即继续静态工作。包位于 `$AUDIT_REPORTS_ROOT/runtime-testing/<audit_id>/plans/`，不修改现有 audit-todo handoff 的字段。控制器串行运行，同一环境仅一份租约；不同身份对应隔离 Chrome DevTools MCP 实例。环境忙时排队，不开启第二个浏览器控制器。
5. **按需 CONFIRM**：专业 Agent 获得源码候选后，立即输出绑定 Finding 对象摘要与漏洞类型的确认包，不等待全部静态审计结束。先复用同环境、同版本、同假设的观察，只补充欠缺的应用路径、影响或反证。每假设最多两次测试；再次执行必须写明新增证据。没有源码定位的观察保留为 RUNTIME_ONLY 候选，禁止伪造源码行号。
6. **CLEANUP 与封存**：每包内完成正常清理；额外清理使用预留预算。源码收尾时读取状态，若队列仍在运行且还有其他报告工作则继续独立工作；需要封存时调用 `cancel` 停止未完成动态、记录缺口，或在全部空闲后调用 `close`。不能无限等待环境。环境超时、未知在途调用、清理失败或进程恢复时禁止复用，保留 QUARANTINED/清理残留。禁止启动末尾 quick 批次或自动补做“整体验证”。
7. **统一证据复核**：封存 `$AUDIT_RUNTIME_STATE_ROOT/evidence-set.json` 后委派 vulnerability-validator。所有源码候选和 runtime_candidates 都交给独立 Affirmative → Negative → Moderator；动态 SUPPORTED 不跳过任何角色。报告中执行状态、观察结果、证据有效性与最终真假结论分别保存。

## 工作包

所有字段由 `contract.mjs:validatePacket` 检查。环境准备完成后才创建 EXPLORE/CONFIRM 包；以 CONTACT 登记后的 authorization.json 为准，不能使用登记前的临时 environment 身份或旧摘要。最小 EXPLORE 示例（摘要、身份、范围必须替换为当前真实绑定）：

```json
{
  "protocol": "runtime-testing.v1",
  "id": "explore-profile-1",
  "audit_id": "audit-example",
  "phase": "EXPLORE",
  "authorization_digest": "<authorization.artifact_digest>",
  "environment_revision": "<authorization.environment_revision>",
  "identity_ids": ["attacker", "victim"],
  "actions": ["navigate", "normal_interaction", "test_input", "test_mutation"],
  "budget_seconds": 600,
  "hypothesis_id": "profile-boundary",
  "focus_area_id": "<Focus Area ID>",
  "scope_digest": "<authorization.scope_digest>",
  "vulnerability_type_id": "JW-INJECT-06",
  "question": "资料字段是否跨身份执行不可信内容？",
  "expected_behavior": "普通文本安全展示，其他身份不会执行标记。",
  "steps": ["先提交普通文本建立对照，再通过真实应用输入提交唯一无害标记。", "另一授权身份在隔离会话重访，记录结果并清理测试记录。"],
  "counterchecks": ["确认普通文本对照与输入保存路径，排除工具直接注入。"],
  "test_data_scope": "<authorization.test_data_scope>",
  "cleanup_plan": "经应用编辑入口恢复资料并重访确认标记消失。"
}
```

CONFIRM 还要求 finding_id、finding_object_digest、vulnerability_type_id。CONTACT 不允许 test_input/test_mutation。CLEANUP 不能添加新测试目的。动作必须是创建任务时授权的子集。模型不能扩展 origin、身份、总预算或读取凭证等数据。

持久化测试要求用户在原文中说明测试数据范围及应用清理方法，由 Agent 理解后登记，不要求用户手填 test_data_scope 或 cleanup_instructions 字段。缺少这些说明时只限制写入测试，正常访问与登录仍可进行。公开授权中的 test_data_scope 为不含原文的范围标识；包内必须复制该标识，不能自行扩大范围。执行 Agent 每次都收到完整私有 prompt 和已登记的私有范围说明。

## 真实性制品 v3

调用以下现有脚本时以 `--runtime-evidence "$AUDIT_RUNTIME_STATE_ROOT/evidence-set.json"` 替换旧 `--quick` 或 `--quick-validation`：

- build-truth-validation-intake.mjs：生成 schema_version=3，policy.runtime_testing 绑定 protocol/evidence_digest/authorization_digest；移除 finding.quick_dynamic_eligible，增加 runtime_candidates。
- 角色制品：schema_version=3，artifact_type=evidence-truth-review；用 runtime_evidence_digest 替代 quick_result_digest。原 findings/事实包绑定保留，每个 findings 行增加 runtime_review：`{evidence_validity: "SUPPORTED|COUNTEREVIDENCE|INCONCLUSIVE|NOT_APPLICABLE", packet_ids: [], reasoning: "中文独立核验结论"}`。必须覆盖所有 intake.findings，不能筛掉动态支持项。
- 三方另输出 runtime_findings，恰好覆盖 intake.runtime_candidates。每项字段为 finding_id、claim_scope=RUNTIME_ONLY、source_mapping=UNKNOWN、packet_id、verdict、reasoning、gaps、evidence_refs。verdict 遵循当前角色已有枚举。源码未知不等于运行现象不存在，但不能据此声明当前源码版本存在该漏洞。证据引用必须能回溯到绑定的真实应用记录。
- reviewed_finding_ids 仅对应原 findings；runtime_findings 单独精确计数。任一集合非空时三个角色均 COMPLETE、真实且不同的 agent_session_id；两个集合都空才 NOT_APPLICABLE。Negative 绑定 Affirmative 摘要；Moderator 绑定双方摘要。
- build-validation-routing.mjs、validate-truth-validation.mjs：重新检查证据文件、输入/输出摘要和三方 accounting；schema_version=3、route=EVIDENCE_THREE_PARTY，runtime_status=AVAILABLE|NOT_TESTED|SKIPPED。runtime_findings 逐项采用 Moderator 结论。
- build-final-report-model.mjs：使用同一 `--runtime-evidence`，生成模型 v3，保留所有执行、清理残留及仅限运行环境结论。原源码漏洞数量与 CVSS/攻击链只消费已有源码候选，不冒认未知源码映射。verify-final-report 继续校验模型与渲染绑定。

runtime_review.packet_ids 必须覆盖与该 Finding 绑定的全部工作包，包括反证和失败记录；存在绑定包时不能填写 NOT_APPLICABLE。最终完成检查还会校验本任务选择的协议、报告 v3、运行证据原文件、角色与 routing 摘要，防止旧报告被当作新流程交付。动态 SKIPPED 的任务同样可形成完整 v3 静态报告。

阶段 Envelope 仍使用 v1 结构，但执行脚本依据已冻结的 AUDIT_RUNTIME_PROTOCOL，通过 stage-registry.mjs 选择新契约投影：移除 quick-dynamic-validator 调用；quick-dynamic-result-set 替换为 runtime-testing-evidence-set；quick_dynamic_task_opt_in 改为 runtime_testing_protocol，quick_confirmed_ids 改为 runtime_supported_ids，statically_reviewed_ids 改为 evidence_reviewed_ids。三方输入、输出 payload 可增加 runtime_candidate_ids；候选计数包含两类候选。工作台阶段 registry_id 为 workbench-stage-deliveries-runtime-testing-v1，摘要重新计算，历史注册表本身不修改。控制器工作包使用独立 runtime-testing.v1 协议，不伪造旧 Agent Envelope。

## 预算、故障与复用

总预算默认 60 分钟，预留 10 分钟清理（较小预算按 1/6 预留）。控制器使用单调计时，包含 worker 推理、MCP 调用、证据写入；排队不计主动耗时，但审计环境最大存续时间独立受限。未执行的包记 SKIPPED，不能冒充 TIMED_OUT。

Web 服务、worker 和浏览器控制器不设置操作系统白名单。旧版因 RUNTIME_HOST_UNSUPPORTED/runtime-host-unsupported 封存的任务保留原结果，更新后通过新建重试重新执行，不自动复活历史任务或清除环境隔离。封存时没有清理工作且 cleanup_status=NOT_REQUIRED，CLEANUP 阶段记 SKIPPED，界面显示“无需清理”。

测试环境由用户自行判断并显式授权，不根据公网、内网或本机地址分类拒绝。授权 origin 按协议、主机与端口精确匹配；代理拒绝未授权 origin 的跳转和子资源。非本机目标按实际主机寻址，并使用各自 origin 的环境锁；localhost/127.0.0.1/[::1] 的同协议同端口继续共享环境锁。进程异常遗留的租约不能自动清除，需要操作者核对测试数据和浏览器后在受控状态目录处理；当前任务静态流程继续。所有浏览器都由本次 MCP controller 创建并关闭，不操作用户现有 Chrome。

已有工作台人工验证入口继续保存独立 sidecar；补充授权、版本变化或需要重新出具终稿时，通过新建审计创建新版本。不会把旧制品原地替换，也不会把手动验证结果自动晋升为源码结论。
