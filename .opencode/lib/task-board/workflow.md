# 通用任务面板 task-board.v1

仅当 AUDIT_TASK_PROTOCOL=task-board.v1 时适用。历史任务执行原契约。本协议替代旧 Focus Area 全范围分区、coverage-plan/audit-todo 工作包、三视角分文件交付及旧最终报告门禁。源码只读、私有环境保护、动态授权与主机运行边界继续适用。

## Orchestrator

对 Agent 工具执行与框架权限边界（API/function/skill/MCP），使用 `domain:"ai"`，并在发布任务中声明 `agent_mining:{"profile":"agent-tool-boundaries.v1","families":["TOOL_RCE","TOOL_AUTHZ","FRAMEWORK_ACCESS"],"track":"coverage"}`。families 可按任务缩小。以可达入口或共同策略边界划分有界任务，不为每个关键词另开任务，也不重复要求三个长篇报告。monitor 会提供只读源码定位计划、知识快照和分析模板；worker 使用 agent-tool-boundary-mining 并由 CLI 生成候选报告。该配置只做静态挖掘，不构建攻击 prompt、不提交动态工作包，不改变审计原有运行授权。其他 AI 主题仍使用原 AI 审计流程。数据库授权专项与工具权限分开建模。

1. 读取 AUDIT_SOURCE_ROOT、AUDIT_SOURCE_BINDING_PATH；沿用现有 Recon 获取源码范围、入口和技术栈。需要源码分析时委派专业 Agent，自己只编排。通用任务面板已由平台创建，使用 `node "$AUDIT_TASK_BOARD_CLI" status` 查看状态，禁止手改面板文件或调用旧 audit-todo。
2. 先读取 `status` 返回的 mining_strategy，再将该值与 AUDIT_MINING_STRATEGY 一起传给 security-threat-modeler。`focus_area` 策略仅提炼高风险 Focus Area；`api` 策略仅对已导入的每个 API 初步分析、定位代码并选择领域，不生成 Focus Area 任务。API 不按风险过滤，也不是 Focus Area 子任务。API 清单用 `node "$AUDIT_TASK_BOARD_CLI" list api <offset>` 分页读取。只在恢复未保存 mining_strategy 的既有任务时，沿用原来的并列规划范围；不得给历史任务补选或更改策略。任何策略都不要声称已覆盖全部 API。
3. Threat Agent 写有界发布文件到 AUDIT_TMP_ROOT/<audit_id>/task-board/。文件格式为 {"tasks":[...]}，每批最多 100 项，kind 必须与本次 mining_strategy 一致。Orchestrator 用 `node "$AUDIT_TASK_BOARD_CLI" publish <文件绝对路径>` 发布，代码 monitor 自动启动领域 worker，每 worker 一次一个任务。AUDIT_BAC_MODE=auto 时，发布前由独立策略会话准备资源分片和规范目录，并将摘要引用放入任务 bac_analysis（字段见下方及 BAC workflow）；不要只把策略路径写在 prompt 中。Orchestrator 不再为每个任务调用 task，也不自行创建挖掘 worker。API 策略多批发布时不遗漏任何原始 API source_id。
4. 所有发布文件处理完成后执行 `node "$AUDIT_TASK_BOARD_CLI" seal`。没有任务时必须以参数提供中文原因。seal 拒绝 API 清单中仍未建立任务的条目。任务可以在发布期间执行，临时空队列不结束本轮。
5. 通过 `status` 和 `wait 30` 获取有界状态，不把全队列写进上下文。需要动态假设时分页读取已完成报告的 runtime_requests，并交现有运行测试控制器：只有 AUDIT_RUNTIME_PROTOCOL=runtime-testing.v1 且已有有效授权时才按其 workflow 入队。API 工作包使用 task_id 作为运行假设上下文标识，不创造 Focus Area 父子关系。静态 worker 不接触浏览器或环境原文。缺少授权动态为 SKIPPED。
6. 累计三次实际执行失败的任务进入 FAILED，暂停和服务中断不计入失败次数。分页 `list FAILED` 查具体原因；需要结束本次尝试时逐项写 {"task_id":"...","reason":"具体中文限制"}，调用 `skip <文件路径>` 显式记 GAP。定位失败的 API 同样保留任务并说明缺口。不会自行无限重试，也不静默减少任务总数。
7. mining_complete=true 仅表示本轮报告收齐或缺口已登记。total>0 且 reported=0 表示没有收到任何源码审计报告，必须说明审计执行未完成，不能输出“未发现漏洞”或“审计成功”。仍需封存失败与缺口记录，修复后新建审计，不重写本轮 GAP。若启用运行协议，按 runtime-testing workflow close/cancel 并封存 evidence-set，原有 CONTACT/EXPLORE/CONFIRM/CLEANUP 授权边界保持有效。
8. 执行 `review-input` 生成摘要绑定的全量复核输入，得到受控报告根相对路径与 sha256。委派 vulnerability-validator，要求阅读本文件的后续复核协议，完成所有任务（包括零发现报告）的质量复核，并对所有源码及运行候选执行独立正方、反方、Moderator。不得调用旧 quick runner、旧 intake/路由/最终报告构建脚本。
9. 收到复核 bundle 后执行 `review <bundle文件绝对路径>`，再执行 `finalize`。finalize 确定性生成最终中文报告及 canonical findings，只有 Moderator TRUE_POSITIVE 进入确认源码漏洞；仅运行环境候选单列。报告质量不足、未确认候选、跳过与 BAC 缺口全部保留。finalize 返回 delivery_outcome=NO_REPORTS 时，明确交付的是执行失败记录，平台将本轮标为失败；封存成功不等于审计执行成功。打印报告路径后结束，不等待旧 TODO、Stage 或 Coverage Ledger 门禁。
10. 恢复时复用已接收报告和已绑定复核。status 的 publication=SEALED 时不重新发布，mining_complete=true 时不重跑挖掘任务；只补齐后续复核/报告。最终报告封存前如发现确定性的报告组装错误，使用下述更正流程；最终报告封存后的本轮不再扩展范围。

### 报告更正（最终封存前）

`review-input` 若指出专项 Finding 与封存复查对象不一致，不要反复重试或生成无法绑定的带外复核。完整读取出错报告与已绑定的专项 review，保留原报告，将与专项原文一致的更正版本写入 reports_root 内的新文件。保持 audit/task/attempt/agent_session_id，不改变冻结范围，不修改专项封存制品。原因和变更须基于现有证据，不重写其他无关发现或删除缺口。

运行 `bind <新文件相对路径>` 获得新摘要，准备 `{ "task_id":"任务编号", "expected_sha256":"当前已接收报告摘要", "report":{"path":"新文件相对路径","sha256":"新摘要"}, "reason":"具体中文更正原因" }`，执行 `correct-report <该 JSON 的完整路径>`。服务保留旧报告和旧复核绑定，校验更正版本后切换当前引用；报告历史写入 report_corrections，复核状态重置。版本过期或已最终封存时拒绝更正。

更正成功后重新运行 review-input，再执行独立质量复核与三方验证，不能沿用旧摘要或把带外复核直接记为成功。最终报告记录更正历史。这个入口不重跑已交付任务、不解除动态环境隔离，也不绕过来源和摘要检查。

## Threat Modeler

此协议下不执行旧的“每文件/函数/入口必须分配到 Focus Area”契约。先查询 status.mining_strategy，按本轮选定粒度执行下面对应的一项。`focus_area` 与 `api` 是互斥的创建选项；仅未保存策略的历史面板保持原并列范围。

- focus_area：基于威胁模型、扫描线索和用户补充要求，只发布值得深入分析的高风险主题。保留风险依据、信任边界、资产和初步定位。风险校准不能凭空以无风险证明省略未知区域；无法判断的部分写入规划缺口。不发布逐接口 API 任务。
- api：读取每个导入 source_id 的原文，识别实际服务、方法、路由、处理函数及关键调用。原文允许自由描述，不要求固定字段。不把初步定位当作完整调用链；未知明确写入 prompt。所有条目都生成任务，不能因低风险或没有命中扫描规则而省略。一个 API 需多个专业时生成并列关联任务并共享 source_ref。不额外发布 Focus Area；对接口相关下游代码和信任边界的分析仍属于该 API 任务。

启用 BAC 时，先读 `.opencode/lib/bac/workflow.md` 的新版任务分支。策略会话只能恢复预期 D/O/R/AC，不读取下游差分来修改预期；其真实会话须与源码 worker 不同。可由当前独立 threat 会话在发布前交付策略，源码 worker 禁止嵌套 Agent。每个适用 Java/Python/服务端 Web 任务通过 bac_analysis.policy_shards、resource_role_catalog、entry_points 传入有摘要的策略和入口。没有策略或无法确定相关性时明确记录缺口，不伪造策略、不阻塞其他任务。

发布条目格式：

```json
{
  "task_id": "api-1-java",
  "kind": "api",
  "title": "POST /orders/refund",
  "domain": "java",
  "source_ref": "从清单复制 source_id",
  "code_refs": [{"path":"src/RefundController.java","line":42,"symbol":"refund"}],
  "prompt": "审计对象：……\n业务说明：……\n初步代码定位及调用关系：……\n已知控制：……\n定位缺口：……\n任务要求：逐项审查接口真实处理路径和适用安全控制，追踪必要的下游实现，记录发现、无发现依据与未完成部分。"
}
```

Focus Area 使用 kind=focus_area，source_ref 为威胁模型条目标识，prompt 复用现有高风险任务描述。domain 允许 web/java/python/c-cpp/ai/platform；web 是浏览器/模板源码，不泛指 HTTP 接口。Java HTTP 接口交 java。不能定位实现且无法判定领域的 API 可交 platform 做入口追踪，仍保留原始 API 描述和明确的不确定性。

输出所选策略、规划说明和各批次文件路径；API 策略附上原始 API 总数、已建立任务的 source_id 数及规划缺口。不要发布队列、启动挖掘 Agent或访问测试环境。

## 后续验证 Agent

vulnerability-validator 接收 `review-input` 路径与 sha256。完整读取输入，核验绑定报告及源码，逐项审查任务要求是否回答、无发现依据是否充分、证据是否支持结论。输入中的 parse_gap、reported_gaps、GAP 必须保留。无法确定就给出缺口；不要回写原报告或直接改变挖掘完成状态。

先输出质量复核 JSON 到 reports/validation/task-board.<audit_id>.quality.json：

```json
{
  "protocol":"task-board.v1", "audit_id":"当前审计",
  "input_sha256":"review-input 返回的 sha256", "role":"REPORT_REVIEW",
  "agent_session_id":"当前真实 session id",
  "assessments":[{"task_id":"输入任务ID","status":"REVIEWED","reason":"中文依据","evidence_refs":["源码或报告引用"],"gaps":[]}],
  "bac_analysis":{"status":"GAP","reason":"启用时检查 D/O/R/AC 预期策略、实际路径及差分证据；缺失条件明确保留","evidence_refs":[]}
}
```

assessments 必须精确覆盖输入全部任务。status 仅 REVIEWED / NEEDS_FOLLOWUP / GAP，REVIEWED 需要证据。bac_mode=auto 时 bac_analysis 必填，只有证据足以支持专项审查完成才标 REVIEWED。新版输入 bac_summary 是程序从每次执行绑定的附件重建的统计；必须核对其 run/review 引用及 gap，PARTIAL 时专项只能标 GAP。COMPLETE 表示当前声明范围比较闭合，仍须独立复核候选，不代表无漏洞。最终生成器会附上同源专项统计，验证 Agent 不手填或改写计数。

input.candidates 非空时，按 AFFIRMATIVE → NEGATIVE → MODERATOR 顺序调用三个独立专业角色的 task；每个输入都包含原始任务、输入候选与封存运行证据，全部候选都必须独立复核。不得因动态 SUPPORTED 跳过角色。没有候选时无需创建这三个会话，质量复核仍然必须执行。

每个角色输出包含 protocol、audit_id、input_sha256、role、agent_session_id，以及 findings 数组。每项为 {candidate_id, verdict, reason, evidence_refs, gaps}，与 input.candidates 精确一一对应。正方 verdict 为 PROVEN/NOT_PROVEN/INCONCLUSIVE；反方为 REFUTED/NOT_REFUTED/INCONCLUSIVE；Moderator 为 TRUE_POSITIVE/FALSE_POSITIVE/INCONCLUSIVE。证据不足用 INCONCLUSIVE。运行候选没有源码映射时保持 RUNTIME_ONLY/UNKNOWN，报告仅对对应授权环境成立。

反方先独立选择反证再读正方，输出顶层 affirmative_sha256。Moderator 输出 affirmative_sha256 和 negative_sha256。所有角色实际会话必须不同。三方只静态核查源码和已封存证据，不启动动态验证。

写完制品后可用 `node "$AUDIT_TASK_BOARD_CLI" bind <报告根相对路径>` 得到 {path,sha256}。最后写 bundle 文件：{"quality":{path,sha256},"affirmative":{path,sha256},"negative":{path,sha256},"moderator":{path,sha256}}。无候选时仅 quality。把 bundle 路径交回 Orchestrator，不自行执行 finalize。
