# Coding Agent 基座

Javelin 的任务板、源码范围冻结、交付回执、独立复核、漏洞归档和报告更新协议由后台维护。Coding Agent 负责读取源码、使用工具、委派分析并交付制品。更换基座不会改变“会话结束不等于审计完成”的规则。

## Web 使用

在“工作台设置”的 Coding Agent 配置中选择默认基座，并配置已安装程序的路径。支持 OpenCode v1、OpenCode v2 和 Grow。默认值只影响随后创建的任务；创建任务时可以覆盖基座，批量创建共享所选配置。已创建任务保留自己的基座，恢复和增量审计优先沿用该引擎的历史，不跨引擎解释 session ID。OpenCode 沿用原会话；Grow 恢复通过原生分支继承历史，记录新的真实 UUID 及父会话 UUID。

模型与 Agent 程序是不同设置。OpenCode 使用 provider/model 标识；Grow 使用本机 Grow 配置中的模型标识。未安装或版本不匹配的程序会显示不可用，不能把选择项存在理解为程序已安装。平台不会自动升级本机 Agent。

每个基座有独立的 ENABLE 开关。关闭后路径可留空，平台不再检测该程序，新建任务和产品联合审计也不提供该选项；开启时必须填写程序名或路径。关闭当前默认基座会自动选择其他已启用项；全部关闭时仍可查看历史记录，创建任务前需先启用一个基座。已有配置默认保持启用，不会自动停用程序；关闭开关不会中止正在运行的会话，恢复已停用基座的任务前需重新启用。

OpenCode v2 当前 npm 包是 `@opencode/cli`，提供 `opencode` 与 `opencode2` 两个命令；不能安装不存在的 `opencode-ai@2.0.29`。为保留 v1，可安装到独立 npm prefix，再在工作台配置对应平台 npm 包中原生 `bin/opencode` 或 `bin/opencode.exe` 的绝对路径。Windows 不选择 `.cmd` 包装脚本：

```bash
npm install --prefix "$HOME/.local/share/javelin/agents/opencode-v2/2.0.29" @opencode/cli@2.0.29
```

此命令是供维护者按需执行的安装方法，本次开发验证没有执行全局安装或替换现有 v1。包名与发布流程依据：[官方 CLI package.json](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/cli/package.json)、[npm 发布脚本](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/cli/script/publish.ts)。GitHub 的 v2 标签与 npm 发布可见性不同，不能仅凭 Releases 页面判断 v2 是否已发布。

## 原生交互入口

在平台仓库中执行下列命令之一。它只打开带审计角色及会话桥接的 TUI；随后在该会话输入审计要求，才会登记审计。

```bash
node .opencode/scripts/coding-agent.mjs --engine opencode --cwd /absolute/path/to/source
node .opencode/scripts/coding-agent.mjs --engine opencode-v2 --cwd /absolute/path/to/source
node .opencode/scripts/coding-agent.mjs --engine grow --cwd /absolute/path/to/source
```

Windows 的目录可以使用引号包裹的绝对路径。原生入口默认读取工作台保存的 Agent 程序路径；添加 `--command "C:\path\to\opencode.exe"` 或相应 Grow 程序路径可仅覆盖本次启动。添加 `--prepare-only` 只生成配置并显示命令、配置路径和预配会话编号，不打开 TUI、不调用模型。

OpenCode v2 入口使用 `--standalone` 创建当前 TUI 自己的服务，确保本次生成的角色、权限与插件配置实际生效。它不会借用已有后台服务中的其他配置。原生 `audit_register` 从宿主工具上下文取得真实 session ID，后台沿用该会话，不再启动主审计进程。直接执行一个尚未配置 Javelin 插件的 `opencode2`，不等价于上述入口。

Grow 原生入口将宿主 `--session-id` 的真实 UUID 写入角色说明，并加载 `audit-current-session` MCP。主 Agent 使用该 UUID 登记当前会话，通过 `audit_command` 操作后台任务板、通过 `audit_checkpoint` 校验交付。Grow MCP 桥不是宿主会话控制 API：原生 Grow 的暂停、恢复等交互控制须在宿主中操作；Web 托管 Grow 使用平台拥有的进程进行管理。原生入口生成的角色和配置不覆盖用户的 `~/.grow/config.toml`。

Grow TUI 的项目角色文件放在私有工作目录中，`--cwd` 指定的被测源码作为 `source_root` 传入登记。平台不会往被测仓库写入 `.grow` 配置；实际会话 `directory` 与被测源码 `source_root` 因此可以不同。

## OpenCode v1 与 v2 的核验基线

调研日期：2026-10-15。官方仓库为 [anomalyco/opencode](https://github.com/anomalyco/opencode)。本机现有 OpenCode 为 1.18.34，对照 [v1.18.34，aec0b9a6](https://github.com/anomalyco/opencode/tree/v1.18.34)；v2 按 [v2.0.29，042d0832](https://github.com/anomalyco/opencode/tree/v2.0.29) 的实现适配。仓库的 `2.0` 分支仍是早期探索快照，不能替代现行版本标签；旧 `specs/v2/config.md` 设计稿也不能替代已经落地的兼容代码。

| 能力 | v1.18.34 | v2.0.29 与平台处理 |
| --- | --- | --- |
| CLI | `run --format json --attach URL`；独立 `attach` TUI 命令 | 保留 `run --format json`；连接参数为 `--server`；TUI 直接 `opencode2 --server URL --session ID`。平台独立适配命令。 |
| 服务 | 原 `/session` 等 API | `/api/info`、`/api/session`、`/api/session/:id/prompt`、`/api/session/:id/interrupt`；服务返回对象也不同。 |
| 配置 | `agent/provider/permission/plugin` 等 | 原生 schema 多为复数；已有 v1 配置迁移。平台复用该迁移，转换目录、技能路径与嵌套深度。 |
| 插件 | 函数返回旧命名 hooks | 默认导出 `{id, setup(ctx)}` 或 Effect 版本；平台提供专用插件并隔离旧插件，不能直接复用旧 hook 模块。 |
| 内置工具 | `bash`、`task(subagent_type, task_id)` | `shell`、`subagent(agent, sessionID)`；角色提示词解释差异，保留业务 task ID 与宿主 session ID 的区分。 |
| MCP | 直接暴露工具名称 | 默认通过 Code Mode 的 `execute` 调用 `tools.<server>.<tool>`，以实际工具目录为准；保留角色权限及 MCP 启用状态。 |
| 实时输出 | CLI JSON 事件 | CLI 仍投影为 `step_start/text/tool_use/step_finish/error`；后台服务事件改为 `{type,data}`，插件需单独映射。 |
| 子 Agent | 子会话委派 | 原生支持后台子会话和完成通知；独立工作可异步执行，依赖交付的复核保持等待，避免高频状态轮询。 |

命令依据：[v1 run](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/cli/cmd/run.ts)、[v2 CLI 命令定义](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/cli/src/commands/commands.ts)。API 依据：[v2 session 协议](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/protocol/src/groups/session.ts)、[v2 server 协议](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/protocol/src/groups/server.ts)。

配置不是简单改键名：现行 [normalize 实现](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/config/normalize.ts)仍兼容旧 agent、provider、permission、command；[v1 migration](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/v1/config/migrate.ts)将旧 bash/task 权限映射到 shell/subagent。平台把原 Markdown Agent 的真实定义写入私有配置，保留技能范围、角色权限、模型及 MCP 设置。

插件依据：[v2 Promise 插件文档](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/plugin/src/README.md)、[工具钩子](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/plugin/src/promise/tool.ts)、[会话钩子](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/plugin/src/promise/session.ts)。本平台插件复用既有登记、心跳、任务控制和 Focus Area watchdog 逻辑，在边界转换 v2 上下文与事件；并发子会话的环境通过调用上下文隔离，不修改全局 `process.env`。

## v2 的实际优化与边界

v2 CLI 的事件订阅已关闭 Bun 默认五分钟请求期限，减少长任务监控连接被该期限打断的情况；这并不保证企业模型 API 永不超时。Javelin 仍保留持久化的自动恢复设置，并避免让插件与平台两层重试次数相乘。依据：[run 实现](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/cli/src/run/run.ts)。

v2 的后台子 Agent 会自动通知完成，可用于互不依赖的侦察与范围分析；它们仍必须提交原任务板回执，不以子会话自然语言总结替代报告。依据：[subagent 工具](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/tool/plugin/subagent.ts)。

Web 托管 v2 的后台启动 `serve --stdio --hostname 127.0.0.1 --port 0`，持有 stdin 租约、私有密码和真实 session 绑定。JSON 客户端与 ttyd TUI 连接同一服务器和 session；暂停调用 v2 interrupt，恢复沿用会话。服务、客户端均属于平台自己的进程树。依据：[standalone 服务生命周期](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/cli/src/services/standalone.ts)、[服务启动实现](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/cli/src/server-process.ts)。

v2 与 v1 默认使用相同的 `opencode/opencode.db` 数据库位置，不能仅隔离配置。Javelin 将 v2 的数据、缓存和状态固定到 `workspace/agent-data/opencode-v2/{data,cache,state}`；可用 `JAVELIN_OPENCODE_V2_HOME` 指定其他持久目录。不同执行批次、worker 与 ttyd 共享该 v2 专用数据根，保持恢复能力。平台仅在首次初始化时复制旧 `auth.json` 供 v2 导入凭据，不复制、打开或迁移 v1 的数据库。已写入私有目录的凭据不会被后续启动覆盖。依据：[数据目录](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/util/src/global.ts)、[CLI 数据库路径](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/cli/src/database-path.ts)。

配置文件和会话绑定含私有运行参数，写入任务私有目录。旧插件不会在 v2 中自动执行；第三方插件须明确兼容 v2 后另行配置。

## Grow 的适配与恢复

Grow 以本机 `grow 2.2.2 (afbe3e4) [stable]` 为验证基线，依据实际 `grow --help`、安装目录中的用户指南和隔离运行结果适配。当前没有找到足以确认该安装版本来源的公开官方源码仓库，因此不把它当作 OpenCode 的兼容分支，也不臆测两者共享内部实现。安装文档中的部分工具名称与本机实际协议不同，以真实模型请求中的工具 schema 为准。

后台使用 `--agent <私有角色文件> --prompt-file <私有输入文件> --output-format streaming-json`。平台把 Grow 的文本、推理、工具调用、用量和错误事件映射到工作台已有事件契约；结束事件的累计用量只作摘要，避免与逐轮用量重复计算。新会话由 `--session-id UUID` 指定；平台收到实际执行事件后才登记会话，单纯生成 UUID 或准备文件不代表任务已经运行。

每个主任务或独立 worker 使用自己的 `agent-runtime/grow-home`，包含模型配置副本、MCP 白名单和审计角色；不覆盖用户 `~/.grow/config.toml`。平台保留 Grow 的模型与超时设置，并关闭本次执行的自动更新、额外记忆和工作流机制。Javelin 的产品记忆继续通过既有审计协议提供。用户模型凭据仅进入私有配置，不写入公开报告或命令参数。

| 平台契约 | Grow 处理 |
| --- | --- |
| 审计角色与技能 | 从规范 `.opencode/agents` 和 `.opencode/skills` 加载，保留角色正文、漏洞类型与任务板回执规则。 |
| 静态工具 | `read` 映射为 `read_file`，`edit` 为 `search_replace/write`，`bash` 为 `run_terminal_command`。使用真实工具名，不能用安装文档中已经过时的别名。 |
| 子 Agent | `spawn_subagent` 创建独立 UUID；主编排可委派，唯一工作包 worker 使用 `--no-subagents`。三方复核仍要求三个独立会话。 |
| MCP | 通过 `search_tool` 和 `use_tool` 调用；静态 worker 排除浏览器权限，动态 worker 只获得显式允许的 `runtime-browser` 网关；子角色按 `mcpInheritance` 白名单继承。当前会话登记 MCP 只交给主角色。 |
| 动态 worker 的内置工具限制 | Grow 主角色校验要求包含读、改、执行工具。适配器声明这些兼容工具，同时用 `--deny Read/Write/Edit/Bash` 拒绝实际调用；允许的 MCP 网关仍可调用。 |
| 角色发现 | 2.2.2 未从自定义 `GROW_HOME/agents` 自动发现子角色，因此后台使用短 `--agents` 定义指向完整私有角色文件；TUI 在平台自有工作目录准备 `.grow/agents`。不修改被测源码目录。 |

Grow 的 `--resume` 是磁盘会话恢复，不能当作 OpenCode 的实时附着。工作台运行期间展示 JSON 事件；暂停或结束后才开放 ttyd。该交互分支用于检查代码、解释结果、记录后续指导，后台任务板服务此时已暂停，不能在其中领取、交付、复核或封存审计任务。关闭交互终端并在工作台恢复任务后，后台继承这段对话并重建任务服务。这一限制只针对 Web 暂停检查终端，上述原生 Grow 审计入口仍可在当前会话完整执行审计。

实际 2.2.2 验证发现：同一 UUID 的进程恢复后再次委派子 Agent，可能报 `turn_boundary_persistence_failed`，详细信息为 `ACP eventId conflicts with persisted event`；原后台参数恢复也能复现。平台因此采用 Grow 官方支持的 `--resume PARENT --fork-session --session-id NEW`，继承历史并建立新的事件命名空间。任务编号、任务板和报告保持原绑定，宿主会话 UUID 更新，并记录 `resumed_from_session_id`。

ttyd 预配分支不会直接改变后台会话绑定。只有 Grow 自己写入的 `sessions/<工作目录编码>/<UUID>/summary.json` 同时确认 UUID 和工作目录，平台才采用该交互分支作为下次恢复的父会话。用户只打开页面而未真正连接终端时，仍沿用上一个已存在的会话；再次打开终端但未连接，也不会丢失此前已经保存的交互指导。交互租约避免后台恢复与 ttyd 同时写会话。Grow 使用 ttyd `--once`，连接断开后释放该终端，重新连接时创建下一分支，避免重复创建同一个 UUID。

## 验证范围

本次在 macOS 临时目录下载官方 npm `@opencode/cli-darwin-arm64@2.0.29`，核对 npm SHA-512 完整性并验证真实程序版本。保留用户现有 v1；模型替换为本机 HTTP 固定响应服务，没有调用真实 LLM 或消耗企业额度。实际通过：

- `run --standalone --format json` 加载生成配置和新插件，产生真实会话、shell 与 JSON 事件；两个 `--file` 附件和末尾 prompt 均完整传入模型请求。
- 原生 `audit_register` 上报宿主真实 session ID、`engine=opencode-v2`；后续 shell 取得仅属于该会话的审计环境；本机 MCP 工具实际执行并生成验证标记。
- 平台 shared runner 启动真实 `serve --stdio`，通过 `/api/info` 与 `/api/session/:id` 查询同一会话；另一个真实 PTY TUI 通过 `--server/--session` 绘制出该任务标题、角色和实时内容。关闭自建 TUI 后 JSON 客户端仍正常完成，平台拥有的服务和客户端均回收。
- 自动化回归覆盖旧插件隔离、角色及权限映射、数据隔离、真实 session 身份桥接、watchdog 边界、同会话暂停恢复及原生入口准备。

Grow 适配测试共 15 项，其中实际二进制集成使用本机 Grow、隔离配置、本机固定响应模型服务和私有测试 MCP，未请求真实模型或业务测试环境。调用方式：

```bash
GROW_TEST_COMMAND=/absolute/path/to/grow node --test .opencode/lib/audit-runtime/engines/grow.test.mjs
```

验证覆盖私有配置与用户配置保护、模型目录、权限和角色映射、真实独立子会话、允许的 MCP 调用、被禁止的文件读取和命令执行、子角色 MCP 不继承、用量归一化、首个真实会话事件、交互分支持久化校验，以及“首次委派→TUI 参数分支恢复并委派→继承交互历史的后台分支恢复并委派”。恢复断言同时检查真实 UUID、前轮消息历史和子任务完成；TUI 参数探针加上 headless 输出选项自动验证，未声称实际 Grow 浏览器画面已人工验收。完整 18 个子角色的命令在模拟 260 字符 Windows 项目根后，计算 Windows 引号及反斜杠转义长度约 18 KB，低于 32,767 字符的进程命令行上限。

这些验证证明运行协议与集成路径可用，不等于真实企业代码审计质量或 Windows TUI 已实机验收。具体模型配置仍以各 Agent 自身支持为准。投入大规模审计前，应在实际企业模型配置下验收一个小型静态任务，再扩大并发和仓库规模。
