# BAC 输入与证据契约

task-board.v1 使用 monitor 注入的 bac-task-plan.v1；prepare 通过 --task/--attempt 绑定任务，策略由发布条目的摘要引用自动载入。不得把描述性 Focus Area 清单当作 Coverage Plan。

`prepare` 生成请求草稿，核心字段定义在 `.opencode/lib/bac/service.mjs:validateRequest`，平台校验在 `contract.mjs`，比较逻辑在本 skill 的 `scripts/analyze_bac.py`。脚本只处理输入事实，不自行恢复源码语义。

请求绑定 `contract_version=bac-analysis.v1`、audit/scope、旧版 Focus/assignment 或新版 task_id/attempt_id、真实专业会话、Plan 路径和只读源码根目录。`acp`、`paths`、`api_catalog` 各自的 `repository` 必须同时绑定该根目录与 `scope_digest`。三个输入的 `coverage.status` 必须有 `coverage.evidence` 定位证据支持，未闭合为 PARTIAL；逐项 `known_gaps` 不得丢弃。声明 COMPLETE 但缺少审查依据时，差分仍保留完整性缺口。

`resource_role_catalog` 包含 `resources:[{D,evidence}]`、`roles:[{R,evidence}]`、`aliases:[{alias,canonical,evidence}]`、`known_gaps:[]`。资源包含数据库命名空间，避免同名表跨服务合并；权限码到角色没有证据则不创建规范映射。

`acp.quadruples` 项为 `{tuple:{D,O,R,AC},confidence,evidence,inference_basis}`。每个 `(D,O,R)` 唯一。O 仅 CRUD 四值，AC 仅 NONE/VAC/HAC/VAC+HAC。`producer` 是独立 security-threat-modeler 的实际 session。`unresolved`、`limitations` 与 `out_of_model` 分别保留未决、分析缺口与模型边界。

每条实际路径至少包含：

```json
{
  "path_id": "order-read-member-branch-1",
  "api_id": "interface:from-frozen-plan",
  "entrypoint": {"interface_type":"EXTERNAL","protocol":"HTTP","operation":"GET /orders/{id}","location":{"file":"src/OrderController.java","line_start":12,"source_digest":"<sha256>"}},
  "sink": {"D":"app.orders","O":"READ","symbol":"OrderMapper.select","location":{"file":"src/OrderMapper.java","line_start":18,"source_digest":"<sha256>"}},
  "policy_binding": {"D":"app.orders","O":"READ","R":"MEMBER","AC":"VAC+HAC"},
  "policy_binding_evidence": [],
  "caller_context": {"principal":"当前请求的受信任登录主体","roles":["MEMBER"]},
  "reachability": {"status":"UNKNOWN","evidence":[]},
  "input_flow": {"attacker_controllable":null,"evidence":[]},
  "implemented_controls": {
    "vac":{"observed":null,"trusted_identity":null,"role_match":null,"dominates_sink":null,"fail_closed":null,"evidence":[]},
    "hac":{"observed":null,"trusted_principal":null,"owner_relation_enforced":null,"dominates_sink":null,"fail_closed":null,"evidence":[]}
  },
  "call_chain": [{"symbol":"OrderController.get → OrderService.load → OrderMapper.select","evidence":[]}],
  "coverage":"PARTIAL","known_gaps":["示例尚待实际源码证据填充。"],"evidence":[]
}
```

此示例不能直接声称审计通过；摘要、位置、接口和事实必须来自当前源码。每条 evidence 使用 `{kind,claim,locator:{file,line_start,line_end?,source_digest}}`，claim 为中文事实，locator 为冻结范围内的结构化位置。兼容原始四元组连接时可用 `effective_role`，其精确匹配失败仍是 UNMATCHED；新路径优先使用显式 policy_binding，并保留实际 caller_context，不能把低权限调用者改名为 ADMIN。

VAC 的五个事实是存在、可信身份、角色匹配、控制先于所有相关 sink、拒绝时关闭路径。HAC 是存在、可信当前主体、直接所有者关系被强制、先于 sink、拒绝/查询条件排除越界对象。false 必须有真实证据；无证据布尔值降为 UNKNOWN。检查到部分代码不够证明全局 observed=false。

`api_catalog.apis` 至少保留分派内的所有冻结 ingress 接口。每项有 api_id、database_relevant（true/false/null），补充发现入口或判断 false 需要证据。出现一条路径只证明入口已关联，是否所有数据库操作/分支已分析还须由输入 coverage 与已知缺口约束。

调用 `prepare-review` 后，ACCEPTED 的 decision 增加完整 Finding v2；使用 `bac_source:{run_digest,candidate_id}`、差分摘要作为 `provenance.source_report_sha256`。所有处置提供中文 reason；REJECTED 增加非空 evidence 反证数组，DUPLICATE 增加 duplicate_of，INCONCLUSIVE 保持缺口。不得把静态置信度转换为真伪结论、CVSS 或实际复现记录。

新版任务 Finding routing 使用 `{protocol:"task-board.v1",task_id,attempt_id,domain,threat_ids}`，由 prepare-review 返回当前分派字段；不填写旧 Focus/check。详细证据、分类、源码定位、bac_source 和候选状态校验与旧版相同。
