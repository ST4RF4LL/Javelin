# OpenCode Multi-Agent Source Security Audit

这是一套项目级 OpenCode 配置，用于对源码、平台配置以及 AI/LLM/Agent/RAG/MCP 系统做多 agent 安全审计。新建工作台任务通过通用面板管理高风险 Focus Area 与逐接口 API 审查，由程序按专业领域分派，接收报告后继续执行，最后统一开展内容复核和漏洞验证。历史任务保留原有 Tri-Lens、Coverage Ledger 和阶段交付协议。

首次使用请先完成[初始化与安装](docs/installation.md)，生成仅保存在本机的 `.opencode/opencode.json`。

## 通用审计任务面板

新建工作台审计默认使用 `task-board.v1`。创建表单提供“高风险 Focus Area / 逐接口 API 审查”策略切换，默认选择 Focus Area。前者由威胁建模提炼高风险主题，后者要求提供 API 清单并逐项定位代码。每轮审计只生成所选粒度的任务，统一保存任务名称、领域、来源、代码引用及自然语言 prompt。

平台 monitor 按领域派发任务，每个领域同时执行一项，总并发上限为四个领域。专业 worker 复用原 Agent 的领域知识和技能，每项使用独立会话。收到任务绑定正确、已完整写入的报告后立即继续派发；内容判断由后续验证 Agent 完成，零发现报告同样进入质量复核。面板展示分类、执行状态、报告位置、具体任务描述和独立复核状态。

API 输入支持每行一个接口的文本或 JSON 数组。策略随任务保存，恢复沿用，重试时回填；服务拒绝发布与本轮策略不符的任务。未定位清楚的 API 条目仍保留任务和缺口；发布封存会拒绝遗漏任何导入条目。交付率的分母是已发布任务及 API 模式下用户提供的清单，不能解释为应用全部接口或全部漏洞的覆盖率。

旧审计继续按其原协议恢复。程序调用如需创建兼容任务，可显式传入 `task_protocol: "local-todo.v1"`，此模式不接受 API 清单。下文有关旧 TODO、全范围 Focus 分区与三视角分文件的说明仅适用于兼容流程。

详细状态、命令、恢复和验证边界见[通用任务面板](docs/task-board.md)。

## Agent topology

- `security-audit-orchestrator`: 主控入口，负责生成单视角任务包、维护覆盖立方体、执行门禁并汇总报告。
- `security-intel-collector`: 信息收集，输出攻击面、语言/平台路由及五类标准化清单（含 AI surface）。
- `security-threat-modeler`: 从代码、历史和 Owner 知识生成可追溯威胁模型，并把完整基础/AI 审计全集划分为确定性 Focus Area。
- `c-cpp-source-auditor`: 以单一 Tri-Lens 策略执行 C/C++ 源码审计。
- `java-source-auditor`: 以单一 Tri-Lens 策略执行 Java/JVM 源码审计。
- `web-source-auditor`: 以单一 Tri-Lens 策略执行浏览器 JS/TS、HTML、JSP 和模板源码审计。
- `python-source-auditor`: 以单一 Tri-Lens 策略执行 Python 源码审计。
- `platform-security-auditor`: 审计依赖、构建、CI/CD、容器、编排、网关和 IaC 等语言无关平台面。
- `ai-security-auditor`: 对全部冻结文件和函数执行 AI 专项第二覆盖层，审计 LLM、Agent、RAG、Memory、MCP/Tool、模型/数据供应链、训练评测和模型制品。
- `security-evidence-correlator`: 归一化覆盖、合并跨视角证据、去重、暴露矛盾/GAP 并生成补充任务。
- `security-attack-chain-hunter`: 在分区审计后执行独立系统级发现，覆盖全部 Focus Area、信任边界和资产。
- `vulnerability-validator`: 新任务消费贯穿式运行证据，与源码事实一起交给独立正方、反方和 Moderator；动态支持不直接决定真假。历史任务按原版本复核。
- `quick-dynamic-validator`: 仅供旧协议任务执行原有 loopback 快速确认；贯穿式任务禁止调用。
- `vulnerability-affirmative` / `vulnerability-negative` / `vulnerability-moderator`: 使用三个独立 OpenCode session 复核全部源码和运行候选，分别给出正方举证、反方挑战和终局裁定。
- `dynamic-vulnerability-validator`: 仅在用户从工作台手动触发时，使用 Chrome DevTools MCP 对 localhost 上目录中标记为 `applies_to: web` 的漏洞做完整动态验证；XSS 使用专用强校验，其他 Web 类型使用通用非破坏性契约，结果不自动改写主链。
- `security-skill-optimizer`: 根据摘要绑定的 routing 与 Moderator 证据优化审计 skill、Joern 规则、漏洞案例和误报案例。

为降低大型仓库的威胁分析前置耗时，Recon 默认使用 Git tracked + untracked/non-ignored 范围，Joern 只解析对应语言的临时源码投影，函数清单按 scope digest 自动复用，并额外生成紧凑的 `threat-routing-index.json`。威胁建模默认只执行一次 bootstrap，消费制品路径与紧凑索引，不重复运行 `.mjs` 构建器；只有已提供 Owner 答案或明确要求访谈时才执行 refine。

## Tri-Lens coverage

三个视角是任务模式，不是互斥的漏洞类型归属：

- `sink-driven`: 定位安全敏感操作并追踪攻击者影响和可达性。
- `control-driven`: 枚举敏感操作并验证应该存在的安全控制。
- `config-driven`: 确定实际生效的配置、依赖和部署选择并对照基线。

Orchestrator 为每个 `Focus Area × owner/domain assignment` 建立一个内容寻址的 Coverage Unit；三个 lens 是 unit 内部维度，仍可由独立 session 执行。目录和接口关系保留为 unit 内部精确 check，但正常路径只调用 `coverage_get_unit`、`coverage_begin_unit` 和一次 all-minus-gaps attestation，不再逐 check 领取、回执、决策。Attestation 只证明执行覆盖，不声明 `NO_FINDING`；真实 finding、gap 分类或定点返工可在前后独立绑定精确 check。完整成员列表不会进入正常 MCP 响应，subagent 也不能直接修改 canonical Ledger。

Coverage policy 分为 `observe`（默认，只记录不阻塞）、`release`（仅门禁带策略标签的 AI/外部接口/身份权限 unit）和 `assurance`（严格全覆盖）。策略验收与完整覆盖声明分离：即使 observe 流程完成，剩余 gap 仍以 `PARTIAL`/`BLOCKED` 和精确 `R/V/U/N` 呈现，绝不会伪装成 `COMPLETE`。统计同时给出 unit 执行率、lens/关系覆盖、证据覆盖和 inventory 状态。

## Skill management

Skill 按 subagent 分组，目录结构固定为 `.opencode/skills/<subagent-skill-group>/<skill-name>/SKILL.md`，例如 `.opencode/skills/c-cpp-subagent/c-cpp-memory-safety-review/SKILL.md`。分组目录本身不包含 `SKILL.md`，只放 `collection.json` 和维护说明，OpenCode 会递归发现子目录中的原子 skill。

### 自动映射

Skill 到 agent 的映射通过目录约定和 `collection.json` 自动完成，无需手动同步多个文件：

- **`collection.json`** — 每个 skill 分组目录下的唯一 skill 清单，其中的 `owner_agent` 字段定义了该组 skill 归属的 agent。
- **`skill-map.json`** — 文档参考，记录所有 `collection → owner_agent` 映射关系，不再重复维护 skill 列表。
- **agent frontmatter** — 所有 agent 的 `skill` 权限已统一设为 `"*": allow`，任意 skill 被发现后即可使用。

> 新增 skill 只需：放入对应分组目录 → 创建 `SKILL.md` → 将 skill 名称加入 `collection.json`。无需修改其他配置文件。

### 命名前缀约定

| 角色 | 推荐前缀 |
|------|----------|
| 信息收集 | `recon-*`, `intel-*`, `dependency-intel-*`, `attack-surface-*` |
| 威胁建模/分区 | `threat-*`, `evidence-backed-threat-*`, `focus-area-*` |
| C/C++ 审计 | `c-cpp-*`, `cpp-*`, `native-security-*`, `memory-safety-*` |
| Java/JVM 审计 | `java-*`, `jvm-*`, `spring-security-*`, `deserialization-*` |
| Web 源码审计 | `web-*`, `javascript-*`, `typescript-*`, `browser-security-*` |
| Python 审计 | `python-*`, `py-*`, `django-security-*`, `flask-security-*`, `fastapi-security-*` |
| 平台审计 | `platform-*`, `container-*`, `cicd-*`, `iac-*`, `supply-chain-*` |
| AI 专项审计 | `ai-*`, `llm-*`, `agentic-*`, `rag-*`, `mcp-security-*` |
| 证据关联 | `tri-lens-*`, `evidence-correlation-*`, `coverage-*` |
| 系统攻击链 | `attack-chain-*`, `system-attack-*` |
| 漏洞验证 | `validation-*`, `poc-*`, `exploitability-*` |
| Skill 优化 | `optimization-*`, `skill-optimization-*`, `joern-rule-*`, `audit-casebase-*` |

## Maintain skills and MCP

可维护性核心在 `.opencode/agent-manifest/`：

- `roles.json` — 角色边界和输入输出。
- `skill-map.json` — collection 到 agent 的映射关系（文档参考）。
- `mcp-map.json` — 每个 subagent 可用的 MCP 工具通配符。
- `artifact-policy.json` — 报告格式、临时目录和清理策略。
- `naming.md` — 新增 skill/MCP 时的命名和维护规则。

可提交的配置源是 `.opencode/opencode.json.bak`；`.opencode/opencode.json` 由每位使用者从模板生成并填写本机工具路径，不进入 Git。添加自有项目 MCP 时，先更新模板，再在 `mcp-map.json` 和对应 agent frontmatter 的权限中加入 `<server>_*`。

## Shared audit assets

公共审计资产位于 `.opencode/shared/security-audit/`，所有 subagent 都可以读取：

- `joern-rules/`: Joern 规则、规则说明和规则索引。
- `vulnerability-cases/`: 已确认或高可信漏洞案例。
- `false-positive-cases/`: 误报案例和规则收敛依据。
- `rule-results/`: Joern/静态扫描结果摘要，用于后续优化。
- `catalogs/`: 版本化漏洞覆盖目录；当前 `application-ai-vulnerability-catalog.json` 对齐应用、平台及 AI/LLM/Agent/RAG/MCP 风险，并融入 OWASP AI Agent Security Cheat Sheet 的高影响动作审批、多 Agent 通信、AI 控制台配置和对抗测试门禁要求，为三视角分别提供检查问题。

默认只有 `security-skill-optimizer` 负责修改这些资产。Orchestrator 只根据摘要有效的本地 truth-validation routing 与 Moderator 证据决定是否拉起它：

- `TRUE_POSITIVE`: 优化相关 `SKILL.md`、补充/收敛 Joern 规则、加入漏洞案例。
- `FALSE_POSITIVE`: 加入误报案例，并收敛 skill 或规则。
- `INCONCLUSIVE`: 仅在缺失条件明确时补充证据要求，不提升为确认案例。
- `partial/failed/stopped/invalidated`: 记录复核缺口，不执行依赖结论的知识提升。

外部 KnowledgeWorkFlow 通过[只读知识检索适配器](.opencode/lib/knowledge-workflow.md)接入。默认寻找平台同级的 `KnowledgeWorkFlow`，也可用 `AUDIT_KNOWLEDGE_ROOT` 指定；复用知识库原生索引、分类修订和来源哈希校验，支持根因、案例、规则与根因检测器。专业 Agent 先匹配安全条件与反例，再选适用规则；保留“原案例差分 / 静态样本 / 跨项目验证”的区别。Blind 轨道不加载知识种子，检索结果不替代当前项目证据或覆盖记账。

新建工作台任务默认启用[越权专项分析](docs/bac-analysis.md)，也可在创建时关闭。独立会话提取 D/O/R/AC 预期策略，Java/Python/Web 源码会话恢复实际数据库访问路径，确定性差分产生待复核候选，再接入现有 Finding 与三方复核。专项缺口、策略冲突和模型外权限会进入最终中文报告；静态专项开关不授予动态执行权限。原生运行依赖 Python 3.10+，可用 `AUDIT_BAC_PYTHON` 指定。

## Temporary artifacts and reports

所有**持久交付件**输出到工作区根目录的 `reports/`（不是 `tmp/`，也不是被审计应用/测试源码树内部）。临时产物存放在 `tmp/` 下按 `audit_id` 分目录管理。`tmp/` 与 `reports/**` 被 `.gitignore` 忽略；`tmp/` 只保留 `tmp/.gitkeep` 和 `tmp/README.md` 作为目录占位。

约定路径：

- 最终可读审计报告：`reports/final/security-audit-report.<audit-id>.md`
- 静态分析报告（SARIF 2.1.0）：`reports/sarif/<agent-name>.<agent-session-id>.sarif`
- 漏洞挖掘结果（JSON）：`reports/vulnerability-mining/<agent-name>.<agent-session-id>.audit-report.json`
- Blind/Seeded 发现结果：`reports/vulnerability-mining/<agent-name>.<agent-session-id>.discovery.json`
- 系统攻击链结果：`reports/attack-chains/security-attack-chain-hunter.<audit-id>.r<round>.json`
- 关联结果（JSON）：`reports/correlation/security-evidence-correlator.<audit-id>.r<round>.json`
- 覆盖验收结果（JSON）：`reports/coverage/coverage-verification.<audit-id>.json`
- 冻结 Coverage Plan：`reports/coverage/coverage-plan.<audit-id>.json`
- 服务持有的追加式 Ledger：`reports/coverage/<audit-id>/ledger/coverage-ledger.jsonl`
- v1 文件/函数结构中间结果：`reports/coverage/coverage-structural-v1.<audit-id>.json`
- 机器生成覆盖摘要：`reports/coverage/coverage-summary.<audit-id>.json`
- 与 JSON 精确同源的覆盖摘要：`reports/coverage/coverage-summary.<audit-id>.md`
- 语义覆盖验收结果：`reports/coverage/semantic-coverage-verification.<audit-id>.json`
- 真实性复核 intake：`reports/validation/truth-validation-intake.<audit-id>.r<round>.json`
- 贯穿式运行授权、工作包与封存证据：`reports/runtime-testing/<audit-id>/`；历史 quick 结果仍在 `reports/validation/quick/<audit-id>.r<round>.json`。
- 本地三方静态复核：`reports/validation/static/<audit-id>/{affirmative,negative,moderator}.r<round>.json`
- 终局 finding 路由：`reports/validation/validation-routing.<audit-id>.r<round>.json`
- 人工完整 localhost 动态验证绑定/结果：`reports/validation-handoff/runtime/<audit-id>/<finding-id>.{target,result}.json`
- 八环节物化清单：`reports/stage-deliveries/<audit-id>/<stage-id>.r<round>.json`
- 可复核覆盖输入快照：`reports/coverage/<audit_id>/inputs/{snapshot-index,scope-manifest,functions-*,interface-manifest,interface-extractor-coverage,application-ai-vulnerability-catalog,threat-model,focus-areas}.json`
- 侦察/威胁清单：`tmp/<audit-id>/recon/{entry-points,sinks,sensitive-operations,config-surfaces,ai-surfaces,recon-summary,threat-model,focus-areas}.json`
- 冻结范围、函数全集、外部接口全集、接口提取验证和威胁路由索引：`tmp/<audit-id>/recon/coverage/{scope-manifest,functions-*,interface-manifest,interface-extractor-coverage,threat-routing-index}.json`
- 临时文件、脚本、规则：`tmp/<audit-id>/`

一个 agent session 对应一个 SARIF；一个漏洞挖掘 session 对应一个 JSON。多个静态分析工具在同一 session 内运行时，应合并到同一个 SARIF 的多个 `runs`。

新建工作台任务使用贯穿式运行测试：CONTACT 与 Recon 并行，中期按 Focus Area 调度 EXPLORE，有候选后立即按需 CONFIRM，最后完成清理、证据封存与独立三方复核。环境未启用、为空、无效或账号不足时全部动态环节自动 SKIPPED，静态继续。只有 Moderator 的 TRUE_POSITIVE 才进入对应结论；没有源码映射的运行候选单列，不冒充源码漏洞。旧任务保持原 quick 版本协议，人工验证继续保存独立 sidecar。详见[运行测试流程](docs/runtime-testing-workflow.md)。新建任务以本地 TODO 全部 DONE/GAP 且最终中文报告存在为完成条件；八阶段只展示证据与缺口。不会自动删除 tmp。

## Usage

按[初始化与安装](docs/installation.md)生成本地配置后，在需要审计的源码项目根目录设置 `OPENCODE_CONFIG="$PWD/.opencode/opencode.json"` 并运行 OpenCode；也可以把整个 `.opencode/` 复制到目标项目再生成其本地配置。

推荐入口：

```text
@security-audit-orchestrator 对当前项目做一次 Tri-Lens 安全审计。使用工作台选择的运行测试协议：缺少环境自动跳过动态，有授权环境时按阶段执行；全部候选经独立三方复核后写入最终中文报告。
```

也可以分阶段调用：

```text
@security-intel-collector 识别当前项目的攻击面和语言路由。
@security-threat-modeler 基于冻结 Recon、代码历史和 Owner 信息建立威胁模型与 Focus Area。
@c-cpp-source-auditor 审计 native/C/C++ 安全问题。
@java-source-auditor 审计 Java/JVM 安全问题。
@web-source-auditor 审计 JavaScript/TypeScript、HTML、JSP 和模板安全问题。
@python-source-auditor 审计 Python 安全问题。
@platform-security-auditor 使用 config-driven 策略审计部署、CI/CD、容器和 IaC。
@ai-security-auditor 使用 sink-driven 策略对全部冻结文件和函数执行 AI 专项覆盖。
@security-attack-chain-hunter 对已完成的 Focus Area 结果执行系统级跨边界攻击链挖掘。
@security-evidence-correlator 关联当前 audit_id 的三视角结果并生成覆盖缺口。
@vulnerability-validator 对初步支持项和运行候选构建版本化 intake，消费封存证据并执行独立正方、反方、Moderator，输出完整 validation routing。
@dynamic-vulnerability-validator 使用当前 prompt 提供的 localhost 测试环境以及可选的匿名、共享或双账号上下文，对一个已封存且属于 Web 范围的 runtime-validation request 做人工完整动态验证。
@security-skill-optimizer 根据已完成且摘要有效的 validation routing 与 Moderator 证据优化 skill、Joern 规则和案例库。
```

### OpenCode 安全审计工作台

产品管理支持单个或多选测试对象修改归属，可跨产品转移或转回“未定义”。列表支持全选当前显示的可操作对象，每批最多 100 个；提交成功后保持当前产品选项。批量归属在检查所有对象版本及活动任务后原子提交，历史审计随对象查询归属变化，但创建时快照与源码目录保持不变。已归档的产品或对象需先恢复，存在活动审计或验证的对象需先结束任务。

统一 Web 工作台会从 `reports/` 重建 repo 级审计任务、阶段、覆盖率、canonical findings、动态验证与最终报告视图。默认以只读模式启动，不会执行审计：

```sh
npm --prefix .opencode run start:audit-workbench
```

默认监听 `http://127.0.0.1:4173`。页面统一展示仓库 Git/配置就绪度、审计任务、8 阶段流水线、带人工处理 companion 状态的漏洞台账、报告记录、运行环境组件与能力快照，以及动态验证的授权 loopback 环境、隔离浏览器上下文和 extension-v2 脱敏 HTTP 请求/响应证据链。安装 tmux（macOS/Linux/WSL）或 psmux（Windows）后，新建静态审计还会得到一个只读 OpenCode 实时窗口；网页按精确 multiplexer target 刷新画面，也会给出可在工作台主机执行的直接 attach 命令。Windows 环境探针只检查 Chrome 可执行文件是否存在，不会为了读取版本而启动空白浏览器。历史 v1 验证结果没有持久化 HTTP exchange 时会明确标记为“未捕获”。人工处理状态使用独立版本和幂等事件记录，不覆盖 canonical finding；Windows 验证结果同步到工作台的 `reports/repositories/<repository-id>/validation-handoff/runtime/` 后也会被统一读取。

新版 React / NestJS 工作台已支持真实任务：在仓库根目录运行 `npm --prefix apps/workbench run start:platform`，默认入口 `http://127.0.0.1:4181`。首次安装或拉取依赖变更后，先执行 `npm --prefix apps/workbench ci --include=dev --include=optional`，成功后执行 `npm --prefix apps/workbench run build`；Windows PowerShell 使用相同命令。可选择产品、源码、模型和策略，创建任务并执行调度、暂停、恢复、取消或断点恢复；复用原平台 Runner 与业务数据。上一阶段只读入口 `start:audit-workbench:modern`、4173 原平台及 4180 首版封存预览继续保留。启动、任务操作、诊断和回退方法见 [新版工作台说明](apps/workbench/README.md)。

动态验证默认展示“验证动作”：按产品、审计和漏洞归集浏览器操作与 HTTP 请求/响应；没有绑定漏洞的环境接触和探索单独显示，受阻、缺失正文与证据校验失败保留具体缺口。贯穿式 `runtime-testing.v1` 与历史人工补充验证共用该视图；旧文本不能可靠还原时只展示脱敏原文，不猜测 HTTP 请求。读取页面和导出不会启动验证。

“导出 Bruno 集合（JSON）”下载 `*.bruno.json`，在 Bruno 中选择 **Import Collection** 并选择该 JSON 文件（如有格式选项，选择 **Bruno Collection**），再选择 `local` 环境。请求的 Examples 保存历史响应，Docs 保存审计、漏洞、工作包和捕获摘要；敏感字段替换为空白凭据变量。缺失、截断、二进制或 multipart 请求正文只保留证据说明，不生成可发送请求。HAR 同时保留捕获缺口和未知耗时标记。导出接口默认 JSON，显式 `format: "opencollection"` 保留旧 ZIP；后者拒绝不完整请求。

来源筛选选项与验证记录独立加载；筛选接口超时或失败会单独提示，已返回的验证动作仍可查看。切换任务会清除旧结果详情，迟到的刷新响应不能覆盖较新的记录。单次 Bruno/HAR 导出最多 100 条，超过上限时页面禁用导出并提示减少选择。JSON 正文脱敏保留未修改的数字字面量、重复字段和空白，避免大整数对象 ID 在封存、展示或导出过程中被舍入。

本次选用 Bruno 的官方导入格式与解析器。官方 [Bruno MCP](https://github.com/usebruno/bruno-mcp) 提供集合读取及 CLI 执行，可作为以后明确授权后的执行适配器；本平台当前仍使用 Chrome DevTools MCP，不会因浏览或导出记录自动安装、启动 Bruno MCP 或重放请求。官方目前没有经确认的通用本地集合打开链接，因此界面提供下载和[导入步骤](https://docs.usebruno.com/get-started/import-export-data/import-collections)。

离线回归：`npm --prefix .opencode run test:validation-evidence`。官方兼容性检查使用本机已安装的 `@usebruno/schema`、`@usebruno/filestore`，或 `BRUNO_APP_ASAR` 指定的 Bruno 桌面包（macOS 默认查找 `/Applications/Bruno.app/Contents/Resources/app.asar`），只读取应用代码，不读取用户集合、偏好或凭据。缺少官方包时该兼容性检查会明确跳过，不能把其他测试通过当作导入已验收。此次在 Bruno 4.1.0 上完成 schema 严格校验和 BRU/YAML 解析往返；没有执行 `bru run`。

需要由 Web 端启动 OpenCode 时，必须显式开启 Runner。工作台启动后不会默认把自身源码当成审计项目；在“审计项目”页面点击“指定目录”，填写工作台所在机器可访问的源码绝对路径。目标目录需要是已 checkout 的 Git 工作树，但不需要复制工作台的 `.opencode/`；Agent、Skill 和 MCP 使用本工作台自己的受控配置。

在“设置”的“使用模型”中可为 Web 任务选择 `默认` 或已配置的 `provider/model`。清单从工作台的 `.opencode/opencode.json(c)`、兼容路径 `~/.config/opencode.json(c)` 及 OpenCode 标准全局配置 `~/.config/opencode/opencode.json(c)` 读取，并兼容 UTF-8 BOM、注释和尾逗号；未开始的审计、重试和断点恢复会在实际启动时读取当前选择，并以 `opencode run --model provider/model` 启动。已经运行的进程不受设置变更影响；选择“默认”时不传递 `--model`。

```sh
npm --prefix .opencode run start:audit-workbench:runner
```

`--repo` 仅作为自动化部署时的可选预登记方式：

```sh
npm --prefix .opencode run start:audit-workbench:runner -- \
  --repo payment=/absolute/path/to/payment-service \
  --repo iam=/absolute/path/to/iam-service
```

如果使用基础脚本手工追加参数，npm 的参数分隔符 `--` 不能省略：`npm ... run start:audit-workbench -- --enable-runner`；写成 `npm ... run start:audit-workbench --enable-runner` 会被 npm 当成自身配置并吞掉。

项目登记接口接收操作员明确填写的绝对目录并在服务端规范化、校验和持久化；后续创建审计时，浏览器只提交登记后的项目 ID、audit ID 和 Git ref，不能临时替换目录或拼接 shell 命令。创建界面还提供两个独立 ENABLE：“测试目标补充说明”会把自由文本追加为本任务要求与侧重点；“测试环境信息”保存 URL、专用测试账号等上下文，并明确授权所选的环境接触、中期测试与按需确认范围。新任务不再追加固定 180 秒批次；未启用、未填写、环境无效或账号不足时，全部动态环节自动 SKIPPED，静态审计继续；这不影响之后在“完整动态验证”页面补录环境、账号和操作说明并逐次授权。两份原文只保存为任务状态目录下的 `0600` 私密文件，API 仅返回开关与长度；prompt 和断点恢复按文件路径、SHA-256 绑定，不在任务 JSON、事件或日志中复制原文。服务端不会自动 checkout，默认拒绝脏工作树和未位于目标 ref 的项目。被测仓库只作为只读源码根使用，Runner 不再把它作为 OpenCode 当前目录，也不得在其中创建 `reports/`、`tmp/` 或运行缓存。每个任务在本项目 `workspace/audit-runs/<audit-id>/` 下获得执行目录，制品和临时目录分别落到本项目 `reports/repositories/<repository-id>/` 与 `tmp/repositories/<repository-id>/`；这些目录均已被 Git 忽略。运行日志、状态和有序事件写入服务端管理的 `reports/platform/audit-runs/`，SSE 用于实时刷新。tmux/psmux 模式为每个审计使用独立 `-L` namespace，并把实际的 `opencode run --format json` 固定到 `audit:tui`；工作台通过只读输出中继消费同一进程的 JSONL 和退出状态，不再启动 `opencode serve` 或调用本机 HTTP API。暂停、恢复和取消只作用于工作台持有的输出中继和该审计的精确 multiplexer/OpenCode run，不扫描或终止其他会话。终端复用器不可用时静态审计仍直接运行同一组 `opencode run` 参数，只是没有实时窗口。

Runner 异常退出、工作台重启或任务被取消后，任务会保留原 `audit_id`、执行工作区、落盘制品、事件历史和 OpenCode provider session id。任务详情中的“断点恢复”会先确认源码仍位于原提交，并对创建时要求干净的工作树继续执行脏状态门禁；随后只关闭该任务自己的旧 tmux socket，优先用 `--session` 续接原 OpenCode 会话，再要求 Agent 校验已有制品并从最早未完成阶段继续。旧版本没有记录 session id 的任务仍可基于同一工作区和制品恢复。每次恢复都会记录恢复次数、时间、模式和有序事件；“新建重试”则仍会创建全新的 audit id，两者语义不同。

若还需要从 Web 人工启动旧有的独立验证 sidecar，必须额外显式启用动态 Runner：

```sh
npm --prefix .opencode run start:audit-workbench:full -- \
  --repo application=/absolute/path/to/application
```

动态页面只允许调度属于当前受管审计、已经密封、尚无结果且漏洞目录 `applies_to` 包含 `web` 的 request；创建任务时未填写测试环境也可在此页补录。操作员必须再次确认 localhost 授权测试环境；账号与登录/清理步骤可选，全部留空表示匿名验证，只提供一组或同一身份表示共享账号，两个不同身份才允许形成跨用户证据。XSS 继续使用专用结果契约，其他 Web 类型使用通用契约；缺少当前证明所必需的身份或安全清理路径，以及需要文件覆盖、进程崩溃、资源耗尽或其他禁止动作才能确认时，只能返回 `INCONCLUSIVE`/`NOT_RUN`。日志按实际提交值脱敏，授权说明临时文件在进程结束后删除；OpenCode session 保存在本机正常 session 库中，页面展示可恢复的 `opencode -s <session-id>` 命令。创建任务时填写的自由格式环境上下文则会持久保存到删除该任务为止，因此只能使用专用测试凭证。服务不会杀死或重置全局 Chrome 进程。

可使用 `--port` / `AUDIT_WORKBENCH_PORT` 修改端口；通过 npm 追加 `--port`、`--repo` 等参数时同样要放在 `--` 之后。默认监听 loopback；内网部署可显式传入 `--host 0.0.0.0`，或设置 `AUDIT_WORKBENCH_HOST=0.0.0.0`。原有 `start:dynamic-validation-web` 命令作为只读兼容别名保留；对应的免开关入口为 `start:dynamic-validation-web:runner` 和 `start:dynamic-validation-web:full`。详见 [Web 工作台架构](docs/audit-workbench.md)。创建静态审计任务不会自动触发动态验证；只有操作员在动态验证表单中的单独显式提交才构成调度请求。

动态组件也可以脱离静态审计队列独立运行：

```sh
npm --prefix .opencode run dynval:doctor
npm --prefix .opencode run dynval:serve -- --port 4173
npm --prefix .opencode run dynval -- run --spec /absolute/path/standalone-run.json
npm --prefix .opencode run dynval -- acceptance template --platform windows --output windows-acceptance.json
```

`run` 接受已经密封的 runtime request/envelope、仓库与受控制品路径，从而复用相同的动态 Agent 和确定性结果校验，但不需要审计队列。授权开关、loopback 环境或必要账号缺失时直接输出 `SKIPPED`，不会启动浏览器或发包。平台不提供人工发包命令或 Web 请求编辑器。

动态验证页只读展示 Chrome DevTools MCP 捕获的脱敏发包记录，并支持方法、状态、来源、全文筛选和两条记录逐字段比较。人工发包、改包和重放完全交给 Bruno。单条或批量记录可导出为 HAR 1.2，或导出为 OpenCollection 1.0.0 ZIP 供 Bruno 3+ 打开。OpenCollection 导出不依赖 Bruno MCP/CLI；业务字段保持原样，认证头、Cookie、API Key、密码和 token 等凭据转换为 `process.env` 占位符，并附带不含值的 `.env.example`。响应只保留状态、耗时和摘要元数据，不导出响应头或正文。

Windows/Linux 发布前的真实 Chrome 所有权、清理与 Bruno 4 Desktop 验收步骤见 [动态验证跨平台发布验收](docs/dynamic-validation-platform-acceptance.md)。CLI 支持 `acceptance template|seal|verify`，封存时强制在对应目标 OS 上完成，最终同时要求 Windows 与 Linux 证据。缺少授权 loopback 环境时必须记为 `SKIPPED`，不能以启动任意目标或全局终止 Chrome 的方式强行完成验收。

当前构建与部署基线明确禁用 Docker、Podman 及其他容器运行时。本平台不提供 Dockerfile、Compose、容器镜像或容器执行回退：Windows PC 直接运行本机 Node.js、OpenCode 与 Chrome；Linux 服务器直接运行本机 Node.js、OpenCode 和受管 headless Chrome。平台审计器仍会把被测项目中的 Dockerfile/Compose 当作只读源码进行安全审计，但不会执行它们。

## Local analysis and MCP defaults

统一静态扫描入口为 `node .opencode/scripts/static-scan.mjs`，提供 `doctor`、`plan`、`run`、`verify`、`aggregate`。基础模式由 OpenGrep/Semgrep 提供源码模式扫描；Gitleaks 与 OSV-Scanner 分别提供可选的密钥和依赖扫描；Joern 只提供可选 `deep_dataflow`，缺失时不再阻断基础静态漏洞挖掘。旧 `semgrep-scan.mjs` 继续兼容。完整 JSON 与 stderr 保存到 `tmp/<audit_id>/`，所有引擎统一输出 SARIF，并生成 `reports/static-analysis/<audit_id>/<scan_run_id>/` 下摘要、结果和摘要绑定的不可变 manifest；`reports/sarif/` 是按 `scan_run_id` 确定性重建的兼容聚合。终端摘要不超过 16 KiB。

Joern 不再注册为 MCP。函数清单构建器和深度审计命令可直接调用 `joern-parse` 与 `joern`；默认从 `PATH` 解析，也可在启动 OpenCode 前通过 `JOERN_BIN`、`JOERN_PARSE_BIN`、`JOERN_JAVA_BIN` 和 `JOERN_GNUBIN` 指定本机工具链。Joern 缺失时相关函数清单必须保留 `GAP`，不得把文件扫描伪装为函数级覆盖；其余静态引擎仍可执行。

配置模板默认启用 `coverage_ledger` 和固定版本的 `chrome-devtools-mcp@1.8.0`。动态 Runner 按风险在现有 Chrome 独立标签页、isolated context 和临时隔离 Chrome 之间选择；共享标签页要求 Chrome 144+、已开启远程调试并由用户确认所选 profile 对控制器可见，Broker 仍只管理本任务登记的页面。Web XSS 等高影响任务强制隔离，无桌面的 Linux 服务器可以使用隔离 headless Chrome。禁止远程、容器域名和 `agent-browser` 回退。`coverage_ledger` 暴露 Assignment Unit、attestation 和兼容的 check 级工具，串行生成认证哈希链。正常 unit 工作流仅交换计数、事件元数据和服务端派生的冻结 source-set 摘要，单次响应硬限制为 16 KiB；完整 source/接口元数据仅允许按小页做定向诊断。

`context7`、`gh_grep`、CodeQL 以及外部 truth-review MCP 占位均已从项目配置中删除。历史 CodeQL 规则文件仅作为离线知识资产保留，不会被 agent 调用。finding 真实性复核完全由项目内 OpenCode Agent 与固定 JSON 契约实现，不要求全局服务。`cpp_index`、`jvm_index`、`python_index` 和 `audit_lab` 仍是可替换占位。

占位 MCP 需要替换为你本机实际可运行的 `type/command` 或 `type/url` 后再启用。

Agent 工具与框架静态挖掘：新增 `agent-tool-boundaries.v1`，覆盖 API/function/skill/MCP 导致的 RCE、未授权工具调用和框架权限绕过。通过任务面板的 `ai` 任务显式选择，参考本地知识库案例，输出源码摘要绑定的候选与缺口；攻击 prompt 和动态验证暂不纳入。设计、证据要求和使用入口见 [Agent 漏洞挖掘](docs/agent-vulnerability-mining.md)。

## Permission defaults

默认配置已放开编辑和外部访问权限，便于开发和调试：

- `security-audit-orchestrator` 使用 catch-all `allow` 覆盖全局默认：所有内置、Skill、自定义及 MCP 工具均自动放行，不需要用户手动确认；canonical Ledger 直接写入是硬拒绝，只能走本地 MCP。
- 全局使用 `"*": "allow"` 兜底，`bash` 与 `task` 默认自动放行；所有 subagent 的 Bash catch-all 同样为 `allow`，执行期间不会发起权限确认。
- 各 agent 原有的显式 `deny` 保持不变：不适用或越界工具会直接拒绝，而不是请求用户确认。
- 大多数开发用 agent 保留现有编辑能力；`ai-security-auditor` 仅允许写入 `tmp/` 与 `reports/`。
- `external_directory: allow`, `webfetch: allow`, `websearch: allow` — 允许外部目录访问和网络操作。
- `skill: "*": allow` — 所有 agent 可使用任意发现的 skill，skill 通过目录约定自动映射。
- `pwd`、`ls`、`find`、`rg`、`git status/log/grep/ls-files`、`mkdir` 等既有细粒度规则继续保留，便于描述各角色的常规命令集；未命中的 Bash 命令也自动允许。
- 新流程由控制器管理环境租约、预算和 Chrome DevTools MCP，worker 只能使用受控工具。无环境不启动浏览器；超时、清理失败或未知状态停止复用。旧 quick 和人工验证维持原授权范围。禁止远程目标、全局 Chrome 进程终止、凭证外泄、持久化后门和破坏性操作。

### 产品多 Repo 审计与长期记忆

产品可绑定目录并发现多级模块、Git 或无 Git Repo；工作台提供产品/模块联合静态审计、源码与接口差异、人工反馈时间线、跨 Repo 关联及长期待办。单 Repo 审计也能复用历史事实和判断理由。使用方法、迁移规则、当前边界及验证记录见 [实现说明](docs/product-memory-implementation.md)，架构目标见 [设计方案](docs/product-multi-repo-memory-design.md)。新增模块回归：在 `.opencode` 目录运行 `npm run test:product-memory`。
