# 产品多 Repo 审计与长期记忆

实现位置：`.opencode/lib/product-memory/`。本次接入现有 ProductStore、AuditRunner、TaskBoard 和工作台页面；不需要新增数据库服务或容器。

## 如何使用

1. 在“产品与测试对象”创建产品时填写源码根目录，也可在已有产品的“产品目录与 Repo”绑定目录。支持 Git 目录、worktree 的 `.git` 文件以及没有 Git 信息的源码导出目录。
2. 首次绑定会后台发现模块和 Repo。工作台启动时及每 5 分钟刷新一次，也可手动刷新。识别有歧义时，用目录行的边界选择器设置 Repo、模块或忽略；扫描不完整时保留 UNKNOWN，不推断删除。
3. 选择“审计整个产品”或某个模块的“审计此范围”。平台冻结本次 Repo 集合、目标配置、源码内容摘要与记忆读取模式。各 Repo 使用原有 `task-board.v1` 流程。
4. 普通单 Repo 审计也可选择历史经验模式；不需要先创建产品联合批次。默认读取事实、人工理由和产品经验，另有 facts_only、off、blind。blind 同时隔离知识种子，AI 静态专项的盲审 Worker 也不会从主任务的 full 模式取得历史。
5. 在“长期记忆”检索接口、资产、覆盖、关系、问题观察和缺口。在 Repo 的“版本与差异”比较源码、接口或资产清单。只有范围完整且提取器版本一致时，接口/资产的缺失才记为减少，否则标 UNKNOWN。
6. 在漏洞详情或“跨轮次问题与人工判断”填写真实漏洞、误报、证据不足、整改状态及理由。系统结论和人工判断分开保存。重复问题可关联另一个 Issue；清空重复目标可撤销关联。共同根因、同类模式和组合链路可单独登记、确认或撤销。
7. 创建“寻找入口”“检查同类问题”“验证修复”“复查误报依据”“补全链路”等产品待办。当前批次只给已选择的 Repo 派发有界补审；范围外待办继续保留。Agent 提交回答和本轮观察引用，人工核对后解决。

## 执行与证据

- 产品批次默认同时执行 2 个 Repo，允许 1–4 个；每批次最多 100 个 Repo、20 个定向补审任务、2 轮补审、3 轮跨 Repo 分析。
- 独立挖掘 Worker 与跨 Repo 会话共享进程内配额，默认 4，可用 `AUDIT_WORKER_CONCURRENCY` 调整为 1–16。该配额不包含已有 Orchestrator 内嵌的复核 subagent；它不是跨进程或跨机器的总模型并发控制器。
- 每轮 Repo 交付后，跨 Repo 分析读取冻结版本和有界观察摘要，输出带文件摘要的关系边、候选、问题关联建议与 TODO。候选分别经过正方、反方和裁决会话；输入摘要、真实会话、逐项覆盖和证据位置由代码校验。结构校验通过不等于模型的语义判断必然正确。
- 分析前后均核对源码摘要。源码发生变化时保留缺口，不拼接不同版本证据。没有自动 checkout、源码复制或目标执行。
- 暂停、取消与继续由父批次传递给子任务。服务中断后的跨 Repo 会话和中断 Repo 会使父批次暂停；恢复时接续原 Repo 审计或重新运行未封存的跨 Repo 分析。已封存报告不重写。
- 产品报告包含各 Repo 交付状态、问题观察、去重后的问题统计、跨 Repo 裁决和剩余缺口。跨 Repo 候选记录按分析轮次保留，不把同名候选自动合并。
- 产品联合入口当前只做静态审计。单 Repo 的动态授权入口保持原有规则；本次功能不会继承或启动目标动态验证。

## Agent 接口

平台注入私有 `AUDIT_MEMORY_CONNECTION_PATH` 和 `AUDIT_MEMORY_CLI`。操作为 `context/search/show/issue/compare/propose/todos/todo-create/todo-answer`，除 context 外可传 JSON 输入文件。

```sh
node "$AUDIT_MEMORY_CLI" context
node "$AUDIT_MEMORY_CLI" search query.json
node "$AUDIT_MEMORY_CLI" propose observations.json
node "$AUDIT_MEMORY_CLI" todo-create todo.json
```

观察示例：

```json
{
  "observations": [{
    "kind": "interface",
    "entity_key": "POST /jobs",
    "title": "任务创建接口",
    "data": {"method": "POST", "route": "/jobs", "required_role": "operator"},
    "evidence_refs": [{"path": "src/jobs.py", "line": 18}]
  }]
}
```

产品、Repo、快照和写入者由平台绑定，不信任输入中的身份覆盖。Worker 凭据只能访问记忆接口，不能发布 TaskBoard 任务或修改人工判断。生产会话从 OpenCode 运行事件登记；可写的 session.json 不作为记忆写权限依据。查询保留读取水位、结果摘要及当时实际返回内容的独立副本。默认上下文为有界摘要，详情通过 show 分页或按 ID 展开。

Recon/Threat Modeler/Worker 规范已接入记忆读取、事实提交、历史理由核查及产品 TODO。常规报告和 Agent 静态专项支持 `memory_observations`、`coverage_observations`、`memory_todos` 附件。报告入库按摘要幂等；后台每 30 秒轮询一批已绑定审计，补偿崩溃或暂时入库失败。

## 持久化与迁移规则

`pm_*` 表增量创建在现有产品 SQLite 中，写事务排队执行。快照清单、留存报告位于工作台状态目录旁的 `product-memory/`；产品批次产物位于 `product-audits/`。

- 旧产品无需立刻绑定目录，旧审计 ID 和 target_id 保持不变。已有 Repo 后续纳入目录树时沿用身份。
- 历史发现按需关联为版本未知的历史观察。旧状态及最新理由可迁移；原来没有保存的理由不会补造。历史导入使用独立绑定，不污染原任务的恢复基线。
- 同一 Repo、相同实体与源码证据才自动继承问题身份；文件变化、不同修复单元或仅 CWE 相同不会自动合并。历史问题和人工条件仍可被下一轮检索用于回归检查。
- 在已有测试对象上显式修改单目录路径可以保留 Repo ID。已经登记为另一个 Repo 的新路径不会自动合并；目录消失不删除历史。
- 转移或删除测试对象时，原产品经验保留在原空间，目录发现规则忽略旧节点，旧会话权限失效；目标产品后续审计建立新的记忆身份。当前不自动迁移跨产品的经验、人工反馈或关联图。
- 入库报告按摘要留存独立副本，普通运行产物清理不会删除已保存经验。当前没有“连同全部派生记忆一起清除”的界面；不应把删除旧运行记录理解为删除经验库。

## 当前边界

无 Git Repo 使用构建清单、源码文件和源码布局启发式识别，复杂目录需要人工修正边界。普通 src 目录不会自动拆为模块。`.gitmodules` 会产生需核对的边界提示；嵌套 Repo 的重叠范围不能作为两个子任务共同派发。现有单对象 include/exclude 模式仍沿用未接入执行的限制，不能悄悄忽略规则启动。

跨 Repo 分析在本轮 Repo 任务交付后执行；运行中的专业 Worker 可以即时查询同产品已接受观察，控制器也会检查新增 TODO。尚未做每次新增观察都唤醒跨 Repo 模型的流式分析。

修复状态是人工反馈维度；Agent 可以记录修复核查观察和反证，不能自行把人工状态改成“已验证修复”。历史误报不会自动屏蔽新候选。读取和覆盖、静态审查和动态证明保持不同语义。

## 验证记录（2026-09-29）

- `npm run test:product-memory`：29 项通过，包括混合目录、无 Git 快照、并发与幂等、清单差异、历史迁移、反馈、产品隔离、Worker 凭据、盲审、批次调度、暂停取消、中断恢复、四会话跨 Repo 复核、页面请求竞态。
- Agent 静态挖掘 24 项通过；产品目录、任务队列、快照缓存和配置检查通过。
- BAC/TaskBoard BAC/进度组合：55 项通过，1 项受本地监听 `EPERM` 阻断。TaskBoard 另有 2 项需要监听端口的用例受相同限制阻断。
- 原有 audit-workbench 综合回归停在 tmux 样例未取得 `ses_tmux_fixture` 的断言，后续用例未完成，不能宣称整套回归通过。
- 页面完成了进程内 DOM 行为测试；当前无可用 Chrome DevTools MCP，未完成真实浏览器视觉与端到端验收。未启动真实审计目标、模型会话或动态测试，也未重启现有工作台服务。

有完整本地权限的主机上可执行 `npm run test:product-memory`、`npm run test:task-board`、`npm run test:bac`、`npm run test:audit-workbench` 完成端口及终端集成复验。
