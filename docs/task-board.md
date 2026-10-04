# 通用审计任务面板

新建工作台任务默认使用 `task-board.v1`。创建表单通过两段式按钮选择一种漏洞挖掘策略：默认“高风险 Focus Area”，或“逐接口 API 审查”。Focus Area 面向高风险主题深挖；API 面向用户提交清单逐一审查。两者是独立粒度，不存在父子覆盖关系；每轮新审计只生成所选类型的任务。

## 创建与任务发布

选择“逐接口 API 审查”后显示必填的“API 审查清单”，支持每行一个接口的文本和 JSON 数组，最多 120000 字符、5000 项。保留每个原始条目及稳定 source_id，不按 URL 或 HTTP 方法的正则筛掉自由描述。重复行仍是可追踪的独立输入。JSON 数组可以包含字符串或接口描述对象。切回 Focus Area 时保留表单中的清单草稿，但不随本次提交发送。

Orchestrator 将创建时的 mining_strategy 传给威胁建模 Agent：focus_area 仅生成高风险 Focus Area；api 仅初步分析清单中的每个 API 并定位实现、选择专业领域。每项任务包含 task_id、kind、title、domain、prompt、source_ref 和 code_refs；执行状态由服务维护。API 可有多个并列专业任务，同一个 source_id 的全部任务收到报告后才计作该条目交付完成。HTTP 接口按实际实现语言路由，web 专业仍负责浏览器和模板源码。

策略随审计记录、面板和源码绑定保存；发布时拒绝与所选策略不符的任务。恢复沿用原策略，重试表单回填策略并允许为新的审计重新选择。报告和任务详情按所选粒度展示交付情况。API 模式拒绝空清单，Focus Area 模式拒绝同时提交 API 清单。

任务可分批发布并边发布边执行。seal 检查每个 API source_id 已有任务，发布期间的临时空队列不会结束挖掘。空计划必须说明原因。当前版本在封存后禁止追加或改写任务，补充建议进入后续审计；这保持本轮报告和范围可复现。

## 执行与状态

- `PENDING`：待执行。
- `RUNNING`：已绑定唯一执行尝试和 30 分钟执行期限。
- `REPORTED`：报告已接收，不代表内容复核通过。
- `FAILED`：累计三次实际执行失败后仍未交付，等待 Orchestrator 说明处理方式；暂停或服务中断不消耗失败次数。
- `GAP`：Agent 或 Orchestrator 显式说明无法完成的原因，不计入报告交付数。

monitor 是平台程序，每领域至多一个活跃 worker，总并发上限四个。空闲名额按各领域最近派发时间安排。worker 逐任务创建会话，复用已有领域分析知识与索引工具，避免无限积累会话上下文。原有专业 Agent 文件与技能保留，动态生成的执行角色只替换工作包交付协议。

首页、任务列表和详情按同一状态展示进度。发布尚未封存时显示“规划中”或已发布、已交报告数量；封存后显示“报告交付数 / 任务总数”和交付比例，GAP 单列，不计入已交报告。阶段条依次展示范围冻结、任务规划与发布、任务执行与报告收集、报告内容复核、报告封存；报告交付 100% 不等于后续复核和封存完成。

任务列表使用全宽布局，点击任务在右侧打开约 70% 屏宽的详情抽屉，小屏设备使用全屏。点击遮罩、关闭按钮或按 Esc 返回原页面，保留列表筛选和页码。详情按概览、任务面板、动态执行、执行日志、来源与报告组织，配置与制品信息可展开查看；从漏洞或验证请求打开任务时仍使用该任务自身的产品空间。

漏洞、报告、补充动态验证请求与结果展示产品、测试对象、来源审计任务和关联报告，支持产品、任务、报告筛选。报告关联根据同一仓库、同一审计的最终报告模型确认，区分已纳入、排除或未确认、未纳入与无法确认关联；不会仅凭相同漏洞标题跨任务合并。无法匹配的历史请求保留原始漏洞 ID、请求制品路径与明确缺口。任务创建时的产品名称与当前归属不同时同时展示。

动态验证页面将验证请求、执行结果和 HTTP 证据分开展示。请求按执行状态筛选，最近报告优先，每页 10 条；来源任务、漏洞与报告均可直接打开。此处的筛选与导航不会启动验证，原有显式授权、环境输入和请求完整性约束继续适用。

执行结果同时纳入审计内的贯穿式运行测试记录与人工补充验证结果。贯穿式记录提供当前状态和工作包数量，可直接打开对应任务的动态执行章节；不会因为没有旧版人工验证结果文件而把已执行的审计内测试显示为“尚无结果”。

报告接收仅核对回执的审计、任务与 attempt_id、受控路径、文件大小和完整写入，并保存摘要绑定的报告副本。此时不解析报告中的 finding，不要求三份 lens 报告，也不判定内容是否充分。worker 退出并完成接收后立即处理下一项。

同一服务串行提交状态变更，文件锁防止两个服务同时接管；CLI 通过带私有凭据的 loopback 控制接口操作，Agent 不直接改队列。过期 attempt_id 的回执被拒绝，重复回执需要与已接收内容一致。

暂停停止当前受管 worker，未交付任务保留待恢复状态；恢复继续派发。取消或工作台关闭会停止该任务自己的 worker。worker 使用 IPC 生命周期守护，工作台异常退出时守护进程终止自己持有的 OpenCode 子进程。不会扫描或终止其他 OpenCode/Chrome 进程。已交报告不因恢复重跑；启动和恢复都会核对面板 API 清单与创建时保存的原文，拒绝清单漂移。

## 后续复核与报告

挖掘结束条件为：发布已封存，全部任务均为 REPORTED/GAP。FAILED、RUNNING、PENDING 都阻止进入后续复核。

任务非空但收到报告数为 0 时，本轮审计执行未完成。仍封存失败原因和复核缺口，Runner 将结果标为失败，工作台显示“执行未完成”；不能用模型进程正常退出或 GAP 全部登记来判断审计成功。部分交付的报告会注明范围限制。修复问题后使用“新建重试”，已封存任务不通过断点恢复重写。既有封存制品保持原文和摘要；页面依据其实际交付数提示执行未完成。报告模型从 report_version=2 开始记录 delivery_outcome，旧模型继续按原版本校验。

新报告使用 report_version=3 的分层排版：二级标题划分审计概览、确认漏洞、任务复核、剩余缺口、运行测试、越权专项和排除候选；三级标题定位单个漏洞、任务和运行工作包，四级标题区分说明、复核依据、证据和修复建议。剩余缺口按模型中明确的任务标识及复核来源分组，全部记录保留，无法确定归属的记录单列。工作台提供可跳转的二、三级目录。

历史任务面板报告仅在其模型能够逐字重现封存 Markdown 时生成结构化阅读版，预览与默认下载使用相同排版。另提供“下载封存原文”（下载接口 `?format=original`）；阅读版返回独立内容摘要及原文摘要，不修改封存文件或既有完成校验。其他协议、缺失模型或绑定不一致的报告继续显示原文。

`review-input` 核验报告副本摘要，然后构建任务与候选全集。无发现、格式不完整的报告也进入质量复核。vulnerability-validator 逐项判断任务要求是否得到回答；有候选时，再调用独立正方、反方、Moderator 会话，精确覆盖所有源码和运行候选。执行交付与后续复核各自记录。

`review` 校验输入绑定、全部任务的复核结果、全部候选的三方结果、独立会话与上游摘要。`finalize` 生成中文最终报告。只有 Moderator 的 TRUE_POSITIVE 进入确认源码漏洞；RUNTIME_ONLY 候选单列。任务跳过、报告自报缺口、复核不确定性、越权专项缺口及运行清理残留全部保留。

启用的越权专项由任务分析和报告质量复核保留预期策略、实际路径与差分证据；无法取得原有专项契约所需的策略或附件时，必须明确记为专项 GAP。新协议不伪造旧 Focus Area/coverage-plan 的 BAC 附件或覆盖完成证明。

运行测试仍由原有 runtime-testing.v1 控制器执行，独立授权原样保留。未启用环境或未提供环境时记 SKIPPED，不启动动态 Agent 或浏览器。静态 worker 没有浏览器工具和运行控制连接；它只输出假设，Orchestrator 按已有授权处理。复核输入绑定封存的运行证据并验证其实际文件，候选必须经过三方复核。

## 命令与文件

Runner 注入 `AUDIT_TASK_PROTOCOL`、`AUDIT_TASK_BOARD_CLI` 和私有连接路径。常用命令：

```sh
node "$AUDIT_TASK_BOARD_CLI" list api 0
node "$AUDIT_TASK_BOARD_CLI" publish /absolute/path/tasks.json
node "$AUDIT_TASK_BOARD_CLI" seal
node "$AUDIT_TASK_BOARD_CLI" status
node "$AUDIT_TASK_BOARD_CLI" wait 30
node "$AUDIT_TASK_BOARD_CLI" list FAILED
node "$AUDIT_TASK_BOARD_CLI" skip /absolute/path/task-gap.json
node "$AUDIT_TASK_BOARD_CLI" review-input
node "$AUDIT_TASK_BOARD_CLI" bind validation/review.json
node "$AUDIT_TASK_BOARD_CLI" review /absolute/path/review-bundle.json
node "$AUDIT_TASK_BOARD_CLI" finalize
```

发布、回执和复核模板见 [Agent 工作流](../.opencode/lib/task-board/workflow.md)。

- 任务状态：平台状态目录 `<audit_id>/task-board.json`。
- 原始 API 清单：同目录 `api-inventory.txt`，0600 权限及摘要绑定。
- 已接收报告：`reports/task-board/<audit_id>/reports/`。
- 复核输入和角色制品：`reports/validation/`。
- 最终模型：`reports/final/task-board-report-model.<audit_id>.json`。
- 最终中文报告：`reports/final/security-audit-report.<audit_id>.md`。

实际 reports 根沿用工作台注入的受控仓库目录。任务列表使用产品范围内的 `GET /api/v2/products/:productId/audits/:auditId/task-board`，支持 kind/status/offset/limit 筛选分页。

## 兼容与验证

历史任务按持久化协议恢复，不自动转换。没有 mining_strategy 字段的既有面板仍保留原并列范围；新建重试需要在两个策略中选择。API 调用者可显式选择 `local-todo.v1` 创建旧契约任务；该旧协议不接受策略切换字段。新协议调用者使用 `mining_strategy: "focus_area"` 或 `"api"`。为兼容未传策略的调用者，后端在新建时根据是否提供非空 API 清单分别确定 api 或 focus_area，并持久化选择；创建页面始终显式提交选项。

`npm --prefix .opencode run test:task-board` 使用临时源码夹具、进程和 Agent 替身检查发布封存、并发分派、路径控制、过期提交、恢复、报告接收与后续复核、默认创建和最终报告连接。不调用真实模型、不访问审计目标、不启动浏览器。

## Worker 启动故障排查

OpenCode 的 `--file/-f` 是数组选项。启动参数必须将任务指令放在选项之前，例如 `opencode run "任务指令" --format json --agent <agent> --file <input.json>`；不要把指令放在附件路径之后，否则会被当作第二个文件名。静态挖掘和运行测试 worker 均遵循此顺序。修改 worker 服务后，需要重启工作台后端才能用于新任务。

日志若出现 `File not found: <任务指令>`，说明失败发生在 Agent 会话启动之前；重复重试或将任务改成 GAP 不会产生源码审计结果。原有替身测试没有覆盖真实 CLI 参数解析，不能作为实际 OpenCode 启动成功的证明。

## 越权专项的原生计划

启用专项的新任务通过 `bac-task-plan.v1` 绑定 task_id、spec_digest、attempt_id 和冻结源码。发布条目中的 bac_analysis 传递独立策略分片、资源角色目录的 SHA-256 引用及入口线索，monitor 自动生成执行计划与真实会话记录；专业 worker 不需要旧 Coverage Plan/check。Focus Area 与 API 两种粒度均适用。

复核输入包含从附件重建的 bac_summary。最终报告和任务专栏展示路径、策略、原始候选、接入复核数量及缺口；候选仍经过独立三方复核。真实分析缺口继续保留，既有封存报告不因适配而自动升级结论。详见[越权专项](bac-analysis.md)。
