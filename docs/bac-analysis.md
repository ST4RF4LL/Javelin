# 越权专项分析

本能力把 BACAgent 的“预期策略—实际路径—权限差分”接入现有审计工作包。预期策略和实际实现由不同会话分析，脚本执行确定性比较；候选随后进入 Finding v2、证据关联、裁定及独立三方复核。差分结果本身不代表已确认漏洞。

## 启用与依赖

新建工作台任务默认开启“越权专项分析”，创建时可关闭。API 的 `bac_analysis` 接受 `auto` 或 `off`，选择会随任务、源码绑定和冻结 Plan 保存，断点恢复继续使用原选择。历史任务没有该字段时保持原流程。

手动启动既有审计流程时，在生成 Coverage Plan 前设置 `AUDIT_BAC_MODE=auto`；不设置则不追加专项要求。工作台会自动注入该变量和 `AUDIT_BAC_CLI`。专项适用于 Java、Python 和服务端 JavaScript/TypeScript 工作包；其他责任域继续原有审计。

平台在原生 Windows/Linux 主机运行，使用项目要求的 Node.js 和 Python 3.10+。Python 只需标准库；无需安装原始复现项目，也不依赖开发者本机路径。Linux 默认调用 `python3`，Windows 默认调用 `python`。可设置 `AUDIT_BAC_PYTHON` 为原生 Python 可执行文件的绝对路径，不要把命令参数写进变量。

```sh
export AUDIT_BAC_PYTHON=/usr/bin/python3
```

```powershell
$env:AUDIT_BAC_PYTHON = 'C:\Tools\Python311\python.exe'
```

工作台环境页显示 Python 组件与专项能力。解释器不存在、输入事实不足或比较失败时，工作包应交付专项 GAP，继续其余静态审计。平台不会自动安装解释器或启动容器。

本机 `.grow` 配置已同步三项技能和角色说明，脚本与公共库通过既有链接共用源码。Grow 启动前需显式设置 `AUDIT_BAC_MODE=auto`、`AUDIT_BAC_CLI`；不设置时保持原流程。`.grow` 仍被本地 Git 忽略，运行器继续保留原有的 OpenCode/Grow 边界；具体说明见本机 `.grow/MIGRATION.md` 的第 13 节。

## 新版任务计划适配

`task-board.v1` 的 Focus Area 与逐接口 API 任务使用原生 `bac-task-plan.v1`。平台从已发布任务、执行尝试与冻结源码生成计划；工作线程通过 `--task/--attempt` 调用原有四步差分工具。无需旧 Coverage Plan 的 coverage_units、checks 或 interface_index，也不会伪造这些实体。

策略会话在任务发布前生成独立策略分片和资源角色目录，将文件路径与 SHA-256 写入任务的 bac_analysis。平台自动传递计划，prepare 自动加载策略；工作线程只补全真实路径和逐候选复查。API 清单中的自由描述保留原 source_id，新增入口必须给出源码证据。

复核与最终封存会重新核对任务、尝试、真实会话、策略摘要、冻结源码和接入候选，生成路径/策略/候选/接入统计及全部缺口。缺附件、缺策略和未决路径不能靠文字 REVIEWED 消除；其他静态审计仍可继续。已经封存的历史报告不会自动改写，新能力用于新建任务。命令和发布字段见[新版执行契约](../.opencode/lib/bac/workflow.md)。

## 分析流程

1. Recon 复用冻结入口、函数和数据库线索。建立有源码证据的资源/角色规范名，不把同名跨服务表直接合并。
2. Orchestrator 按有限资源组调度独立 `security-threat-modeler` 策略会话，使用 `extract-acp-quadruples`。它输出应有策略，不读取下游缺失控制结果来修改预期。
3. 专业源码会话恢复实际访问路径。Java 使用 `java-access-path-analysis`；Python/Web 使用 shared `detect-bac-risks` 的框架指引。分别检查入口绑定、调用者、调用链、SQL/ORM 条件和生效的全局、局部、查询级控制。
4. `bac-analysis.mjs compare` 比较输入，输出候选、无差分路径、证据不足、未匹配和有据不可达。未知事实保持未知，未覆盖入口、未决策略和模型外项继续保留。
5. 原始候选逐项处置为 ACCEPTED、INCONCLUSIVE、REJECTED 或 DUPLICATE。ACCEPTED 必须补全真实 Finding v2 证据，且状态为 CANDIDATE。
6. control-driven 报告绑定差分和复查文件；本地任务验收重新检查摘要、分派、源码和候选集合。专业会话继续提交其余两个视角的独立报告。
7. 最终中文报告和工作台展示路径、策略、原始候选、接入复核数及所有缺口。完成门禁从工作包证据重建专项摘要，核对最终模型与正文。

Agent 调度和 CLI 参数见 [执行流程](../.opencode/lib/bac/workflow.md)，具体字段见 [输入契约](../.opencode/skills/common-subagent/detect-bac-risks/references/input-contract.md)。`prepare` 只生成待补证草稿，不自动把空输入视为完整分析。

## 模型与结论边界

策略严格使用四元组 `{D,O,R,AC}`：数据库资源、CRUD 操作、应有角色、NONE/VAC/HAC/VAC+HAC。VAC 是角色访问控制；HAC 在此模型中指直接所有者约束。实际调用者通过独立的 `caller_context` 记录，低权限调用管理操作时不能把调用者改名为 ADMIN 来匹配策略。

租户、部门、共享、委托、复杂父子关系、字段、业务状态和非数据库对象不扩充四元组。这些控制进入 `out_of_model` 并继续常规权限审计。输入 completeness 需要定位依据；分析完成仅表示当前声明范围的比较已闭合，不能推断整个仓库没有漏洞。

脚本只比较输入事实；源码语义恢复由专业 Agent 完成。反射、动态 SQL、未知框架或外部权限库无法确定时保留缺口。文件摘要能核对证据引用与快照一致，不能代替对证据语义的独立复核。

原始候选不直接进入最终漏洞数量。跨包的同 D/O/R 策略冲突会进入残余缺口；路径和策略计数按工作包累计，可能重复，不称作全库唯一数。

## 制品与恢复

制品均位于当前任务注入的 reports 根目录下：

```text
bac/<audit_id>/
  policies/                      # 独立策略分片与规范名目录
  drafts/<run_id>.request.json    # 待补证请求
  runs/<run_id>/
    acp.json                     # 引擎实际输入，含规范目录缺口
    paths.json
    apis.json
    bac-findings.json            # 输入、摘要、差分、生产者与分派绑定
    bac-findings.md              # 中文候选与覆盖缺口
    result.sarif                 # 静态候选导出
    manifest.json                # 比较阶段文件摘要
    review.json                  # 逐候选处置，独立摘要封存
    attachment.json              # 交付给 control-driven 的文件绑定
```

不覆盖已发布 run；同内容 review 可以幂等重试，不同复查内容使用新 run。原始比较 manifest 不包含随后生成的 review，后者由附件的 SHA-256 和自身摘要绑定。恢复不得修改已验收 DONE/GAP 包，输入/快照变化时不得复用旧结果。

GAP 必须提供中文原因；NOT_APPLICABLE 还必须提供冻结 Plan 路径、源码根目录和可核验定位证据。专项存在缺口时，已完成其他审查的工作包仍可交付 DONE，但专项缺口持续进入最终报告。

## 动态验证

专项开关和 CLI 都不授予动态执行权限。需要运行证据时复用[贯穿式运行测试流程](runtime-testing-workflow.md)，只在用户启用并提供授权测试环境后执行。未授权时记为 SKIPPED。BOLA 使用授权测试身份与对象对照，BFLA 核对调用者和预期角色；写入验证保留合法清理路径。

## 回归入口

以下命令留待原生 Windows/Linux 主机执行：

```sh
npm --prefix .opencode run test:bac
npm --prefix .opencode run test:config
npm --prefix .opencode run test:audit-todo
npm --prefix .opencode run test:stage-agent-contract
npm --prefix .opencode run test:audit-workbench
npm --prefix .opencode run test:runtime-testing
npm --prefix .opencode test
```

专项用例使用离线合成源码，覆盖未知事实、垂直/水平权限差分、覆盖守恒、来源与分派绑定、源码漂移、制品重算、候选接入及历史关闭模式。它们不启动被审计应用、不接触测试目标。2026-09-22 本轮按用户要求暂缓 Windows/Linux 执行回归；静态检查不能替代这些测试。
