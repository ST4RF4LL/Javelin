# 分批独立复核

用于 review-input 返回 batch_plan 的任务；历史无 batch_plan 的输入继续旧格式。只核对源码与封存证据，禁止发起动态请求、访问测试环境或改写原始报告。人类可读结论使用中文。

## 验证编排器

1. 保留全量输入的 path/sha256，用脚本分页提取 tasks 完成质量复核，不把 candidates 全量读进上下文。quality 仍遵守 workflow.md 的 REPORT_REVIEW 格式，逐项保留 GAP、解析错误、BAC 缺口和 file_discovery。文件初筛账本同样分页查看。
2. 调用 `node "$AUDIT_TASK_BOARD_CLI" review-next`，后台给出下一批 batch_id、role、agent、输入 path/sha256，以及该批所需的正反方绑定。默认每批最多 6 个候选、目标输入 16000 个估算 token；相同源码位置的候选优先放在一起，但每个候选单独给结论。
3. 每个返回的任务都新建指定角色的 task，会话必须全新，绝不传 task_id 恢复前一批。只传本说明路径、该批输入与前序绑定、源码根及报告根。已有已接受结果会自动跳过；不要让子 Agent 读取全量 review-input、复制其他批次历史或做全量制品汇编。
4. 子 Agent 写结果后，用 bind 获得引用，写 `{batch_id,role,result:{path,sha256}}`，执行 `review-submit <JSON路径>`。后台验证批次、候选、独立会话和上下游摘要并持久化，立即提交再继续下一项。
5. review-next 返回 done=true 后，写 `{quality:{path,sha256}}` 交给 Orchestrator 执行 review。后台从已接收批次自动汇总三方结果，检查全量候选精确覆盖；不让模型重新生成全量 findings 数组。随后沿用 finalize。
6. 额度不足时保存已完成制品，调用 defer 暂停；不能用 INCONCLUSIVE 批量代替尚未执行的复核。已完成批次恢复时不会重跑。

## 正方、反方、裁决角色

仅处理本次 batch_id。读取本批输入，核对相关源码和按需引用的原始证据。evidence_external=true 时完整证据在该候选的 evidence.path；按相关字段/行范围读取，不截断关键事实，不把引用误当成缺失。不要重读其他批次报告。

输出：`{protocol:"task-board.v1",audit_id,input_sha256,batch_id,batch_input_sha256,role,agent_session_id,findings:[...]}`。

- input_sha256 来自复核主输入；batch_input_sha256 来自本批文件的绑定；agent_session_id 为当前真实 session。
- findings 精确覆盖本批 candidate_id。每项 `{candidate_id,verdict,reason,evidence_refs,gaps}`；结论保持简短，引用必要的源码位置与控制，完整原文仍保留在绑定制品中。
- AFFIRMATIVE：PROVEN / NOT_PROVEN / INCONCLUSIVE。
- NEGATIVE：先独立查入口约束、权限守卫和反证，再读本批正方；REFUTED / NOT_REFUTED / INCONCLUSIVE，附 affirmative_sha256。
- MODERATOR：核验双方和源码；TRUE_POSITIVE / FALSE_POSITIVE / INCONCLUSIVE，附 affirmative_sha256、negative_sha256。证据不足保留 INCONCLUSIVE，不能凭先前结论填充。
- 共享源码位置只用于复用证据；不同攻击前提、调用入口和安全边界仍逐项判断，不能批量复制裁决。完成本批即返回结果路径，不主动领取下一批。
