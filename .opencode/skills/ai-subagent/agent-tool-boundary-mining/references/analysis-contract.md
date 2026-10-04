# 分析对象契约 agent-mining.v1

平台已生成顶层 `protocol`、`plan_digest`、`coverage`、`claims`、`gaps`。只填写分析文件，不修改计划或平台会话。`agent_session_id` 从 session_path 读取。所有人类说明使用中文。

证据对象统一为 `{path, line, end_line?, sha256}`：path 相对源码根，摘要来自 plan.inventory.files；行号必须落在该文件内。说明对象统一为 `{reason, evidence:[证据]}`。普通说明不能为空，机器标识不翻译。复用相同证据对象即可，不复制整段源码、密钥或环境凭证。

## coverage

保留计划全部 `family × surface` 项且不重复：

`{family, surface, status:"INSPECTED"|"NOT_APPLICABLE"|"GAP", reason, evidence}`

INSPECTED 表示已检查本任务该边界，不表示没有漏洞。NOT_APPLICABLE 须引用源码说明为何本任务不含该边界；GAP 允许证据为空，但说明具体缺口。空 cue 列表不能自动填 NOT_APPLICABLE。

## claims

每个对象包含以下字段。只提交有可描述调用链的假设，尚无链条的调查直接写入 gaps。

| 字段 | 内容 |
|---|---|
| claim_id | 当前任务内唯一、稳定的 ASCII 标识 |
| family | TOOL_RCE / TOOL_AUTHZ / FRAMEWORK_ACCESS，须属于任务选择 |
| surface | api_call / function_call / skill / mcp |
| title、description | 中文标题与边界失效说明 |
| caller、execution_identity、operation | 入口主体及其影响、最终执行身份、具体操作；不可把模型声称身份当可信主体 |
| execution_context | HOST / SANDBOX / REMOTE / UNKNOWN，按实际源码描述 |
| severity | LOW / MEDIUM / HIGH / CRITICAL / UNKNOWN，仅候选优先级，不输出 CVSS 或确认结论 |
| expected_policy | `{reason,evidence}`，独立说明应有授权/隔离要求；不能单靠案例推导本项目策略 |
| chain | 3–40 个 `{id,stage,reason,evidence}`，从 entry 开始，经 dispatch（可含 transform），以 execution 结束 |
| edges | 逐相邻节点对应 `{from,to,reason,evidence}`；说明调用和数据传递关系，不得断链 |
| facts | 下表的每个事实为 `{status:"SUPPORTED"|"REFUTED"|"UNKNOWN",reason,evidence}` |
| controls | 非空数组 `{name,status:"ENFORCED"|"BYPASSED"|"ABSENT"|"UNKNOWN",reason,evidence}`；ABSENT 需源码范围内负证据 |
| counterchecks | 下表每个反例为 `{status:"DOES_NOT_REFUTE"|"REFUTES"|"UNKNOWN",reason,evidence}`；REFUTES 表示发现足以推翻候选的安全实现 |
| impact、remediation | 中文影响边界和修复方向 |
| knowledge_refs | 数组 `{id,sha256}`，与 plan.knowledge.reference 的 ID/source.sha256 匹配；blind 必须 [] |

| family | 必要 facts | 必须核对的 counterchecks |
|---|---|---|
| TOOL_RCE | attacker_control、reachable_execution、authority_violation、executable_influence | intentional_authorized_execution、fixed_executable_and_arguments、sandbox_boundary |
| TOOL_AUTHZ | attacker_control、reachable_execution、authority_violation、dispatch_policy_bypass | execution_side_policy、alternate_dispatch_paths、approval_final_operation_binding |
| FRAMEWORK_ACCESS | attacker_control、reachable_execution、authority_violation、principal_or_resource_mismatch | outer_authorization、parent_resource_binding、anonymous_and_fallback_identity |

所有 SUPPORTED/REFUTED、ENFORCED/BYPASSED/ABSENT、DOES_NOT_REFUTE/REFUTES 必须有源码证据。UNKNOWN 可无证据，但必须说明缺口。存在未知、反证或未知执行环境的 RCE，只输出 LEAD；不会被提升成最终确认漏洞。未知控制不是 ABSENT。

三类漏洞均不需要填写攻击 prompt、执行命令、可运行 PoC、runtime_requests 或复现成功状态。finish 生成的 execution_status 恒为 NOT_RUN，verdict 恒为 NOT_ASSESSED。
