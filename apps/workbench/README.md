# 新版工作台：真实任务模式

React / NestJS 新版已接入原平台的真实任务创建、调度和执行控制。业务数据、Runner、队列、授权规则及落盘记录沿用原平台；原界面和首版封存预览继续保留。

## 文件覆盖率（Focus Area 文件关联）

左侧“审计任务 → 文件覆盖率”进入 `/audits/coverage`，选择审计查看启动时冻结的全部文件。任务详情也有同名入口。灰色表示暂无 Focus Area 定位关联，黄色表示任务的 `code_refs` 精确指向该文件；展开可查看关联任务、状态、行号和符号。关联率按文件去重，搜索、筛选和分页不改变分母，页面每 10 秒读取新发布的定位。

当前版本只统计定位关联，不表示文件已审查或漏洞已确认。目录/通配符、不在清单中的引用单列为定位缺口，API 任务不计入 Focus Area。没有源码清单的任务显示未就绪；没有通用任务面板的历史任务显示未采集关联。读取过程不启动 Agent、不扫描当前源码、不修改任务、报告或 watchdog。接口为 `GET /api/v2/products/:productId/audits/:auditId/file-coverage`，支持 `q`、`association=all|associated|unassociated`、`offset`、`limit`，返回契约为 `file-focus-coverage.v1`。

定向检查：`node --test .opencode/tests/run-file-focus-coverage-tests.mjs`。首次部署后端接口需要正常重启平台，先确认没有活动审计。

## 报告交付完整性与更正

专业 worker 在写回执前使用 `task-report-check.mjs <input.json>` 检查真实生产会话和 BAC Finding 原样交付；接收端再次执行确定性校验，错误包含任务、Finding 与差异字段。独立内容复核继续保留。

对于升级前已接收的组装错误，最终封存前可通过任务 CLI `correct-report <更正请求.json>` 提交新文件的路径/摘要、预期旧摘要与中文原因。服务保留原报告、旧复核绑定和更正记录，只切换当前版本；复核输入按内容摘要保存，更正后必须重新完成质量复核与独立三方验证。最终中文报告显示更正历史，已封存任务不接受此操作。更正不重跑挖掘任务，不解除动态环境隔离。

最终封存的校验、文件写入和面板提交与更正使用同一提交锁，避免并发操作封存旧版本。任务启动时为质量复核角色注入当前工作区和实际报告根的 `validation` 绝对路径编辑白名单，解决 OpenCode 写文件时相对路径规则不匹配的问题；该角色其他绝对路径仍拒绝编辑，浏览器权限保持关闭。正方、反方与 Moderator 沿用既有角色权限和只读源码契约，保留临时组装制品的能力。

## 运行监控、ttyd 终端与共享 OpenCode 会话（2026-10-09）

新任务由隐藏的 Node.js 监督进程直接启动 OpenCode，默认执行链路与环境探测不再调用 tmux/psmux。交互终端使用宿主机原生 ttyd，网关按任务启动 ttyd 与独立 `opencode attach` 客户端。浏览器终端由 ttyd 提供，工作台保留任务绑定、状态检查和子窗口入口；JSON 监控源码位于 `.opencode/web/dynamic-validation-observatory/monitor/`。旧 `web-terminal-monitor@0.2.0` 安装包仅作为回退档案保留在 `vendor/`，不再是运行依赖。迁移前文件备份位于 `reports/workbench-migration/ttyd-20261008/before-ttyd.tar.gz`。

先安装宿主机 ttyd，再构建监控资源并启动终端服务：

```sh
brew install ttyd # macOS；其他系统使用 ttyd 官方宿主机安装方式
npm --prefix apps/workbench run build:monitor
npm --prefix apps/workbench run start:monitor
```

ttyd 可执行路径通过 `WORKBENCH_TTYD_BIN` 覆盖。前端资源刷新即可加载；终端网关切换需要正常重启所属平台进程，重启前确认没有活动审计。已有运行任务保留原启动方式；更新后新建或通过原操作断点恢复的任务会启用共享服务。终端网关默认绑定 `127.0.0.1:4184`；仅复用协议、源码摘要和工作区一致的服务。每个任务及只读模式的 ttyd 使用随机本机端口和独立凭据，首次打开时启动，空闲两分钟后回收；缺少共享服务的旧任务仅保留日志查看，正常结束后可通过断点恢复切换新执行方式；交互只开放给当前运行审计的 OpenCode 会话，禁止创建任意 Shell。关闭页面或终端服务只释放附加客户端，不停止审计。

Windows 使用原生 ttyd（可执行 `winget install tsl0922.ttyd`）。交互终端通过系统 Windows PowerShell 启动 Node 附加启动器，再以 `opencode attach` 连接当前任务 session；显式指定工作目录，使用 `--` 分隔 ttyd 与客户端参数。ttyd 1.7.7 的 [Windows 命令拼接实现](https://github.com/tsl0922/ttyd/blob/1.7.7/src/pty.c#L203-L216) 使用固定的 256 字节缓冲区；PowerShell 命令保持短小，完整 Node/OpenCode 路径、session 和工作目录通过私有环境变量传递，不拼接到 Shell 脚本中。OpenCode 继承 ttyd 创建的 ConPTY，外层后台进程仍隐藏窗口。客户端结束后 PowerShell 同步退出，不保留任意 Shell；终端页面检查所属 ttyd 实例，PTY 启动失败会显示具体提示并支持重连。

Windows 手动验证已确认 `ttyd → powershell.exe → opencode` 能显示 TUI；平台的同 session 附加仍需在 Windows 验收。此调整不要求改用社区 ttyd 构建，继续使用本机已验证可用的版本。macOS/Linux 仍直接附加 OpenCode，JSON Runner 与 watchdog 不变。

2026-10-09 暂停与终端修复：修正页面刷新重叠时，响应体读取被取消却转换为空对象、随后触发 `items.map` 的问题。Windows 命令构造测试及宿主机真实 ttyd 的 TTY、中文输入、窗口尺寸、长参数验证通过；原生 Windows 的 OpenCode TUI 仍需在 Windows 机器验收，可先运行 `node --test apps/workbench/tests/ttyd-command.test.mjs`，再打开运行中任务的交互终端。

- **任务事件（默认）**：沿用 JSON 日志和 SSE，不创建终端进程。显示主 Agent 和子 Agent 工具调用、结果与来源，支持筛选、搜索和跟随。当前页面最多缓存 500 条事件，进度以任务板交付为准。
- **原始 JSON**：沿用原事件渲染器供排查。日志读取失败时保留上次结果。
- **交互终端（按需）**：点击“交互终端 ↗”弹出独立子窗口，以 `opencode attach` 在新 PTY 中连接原任务的同一 session。可以输入后续指令，OpenCode 会话保存指令和响应，JSON 执行器继续收集执行输出。父页面继续显示 JSON 事件，重复点击聚焦同一子窗口；关闭子窗口只断开附加客户端，关闭任务详情也不会关闭子窗口。子窗口支持重连、全屏、尺寸调整与只读切换。弹窗被浏览器拦截时提供新标签页入口。没有共享会话的旧任务不显示可连接入口，不通过 tmux/psmux 回退。

每次执行在原有受控进程树中启动本机 `opencode serve`，随后执行 `opencode run --attach ... --session ... --format json`。服务继承原任务配置、插件和 `AUDIT_*` 环境；watchdog、任务板、长期记忆和交付判定沿用原逻辑。取消和收尾关闭任务所属服务；暂停先停止提交指令的 JSON 客户端，再通过 OpenCode session abort 中止当前执行，保留会话服务和上下文；恢复继续同一个 session。Windows 无需 SIGSTOP/SIGCONT 或 psmux。中断恢复复用 session ID，但创建新服务与连接凭据。任务结束后终端不能绕过 Runner 继续执行，须使用原有恢复或新建重试操作。

服务凭据仅保存在任务状态目录的 `opencode-server.json`（0600），不进入 API、URL 或前端；结束时移除。网关转发每个 WebSocket 消息前检查任务状态和绑定摘要，暂停、结束和旧连接不能继续输入；同时定期清理已失效的 ttyd。客户端只能提交任务编号，不能指定 Shell 命令、OpenCode 服务地址或任意 tmux socket。关闭网关仅结束 ttyd 和其附加客户端，不操作审计 Runner。显式开启的 4173 原界面和 4181 新版均按需打开独立终端子窗口；任务详情不再内嵌终端。

`build:monitor` 将组件与所需样式嵌入已有 `app.js/styles.css`，避免为本次更新更改后台静态路由。生成段不可手工修改。`check:monitor` 核对源码和已生成资源一致，`test:monitor` 验证日志适配、页面生命周期、旧任务连接拒绝边界，以及共享服务的输入、暂停、恢复、取消、崩溃与断开。下文较早的 EPERM、旧进程和端口说明是历史排查记录，不代表本次环境状态。

2026-10-04 接入验收：27 项监控专项测试、7 项原功能继承测试、4 项产品记忆界面测试与 TypeScript 检查通过。使用 Chrome DevTools MCP 在真实 `test_long_memory` 任务上核验了终端只读连接、实时事件增长、来源与搜索筛选、视图展开和独立滚动位置、刷新保留同一终端节点，以及关闭重开。最终页面 console 的 error/warn 均为 0，验证期间未重启审计后台。

2026-10-05 共享会话验收：76 项相关测试通过，TypeScript 与监控构建一致性检查通过；本机 OpenCode 1.18.34 配合本地模型响应替身，通过 Chrome DevTools MCP 验证了真实 TUI、同 session 输入、JSON 后续事件、断开重连与正常退出清理。正式页面默认显示事件，未自动创建终端。完整旧回归套件仍有历史记忆回填字段及漏洞确认状态断言未通过，未更改这些业务规则。记录位于 `reports/workbench-migration/shared-opencode-20261005/verification.json`。

2026-10-05 子窗口验收：13 项前端测试与监控构建一致性检查通过。Chrome DevTools MCP 配合隔离的真实 OpenCode 会话验证点击弹窗、同窗口复用、关闭后任务继续运行、重新打开连接及父页面保持事件监控；父子页面 console error/warn 均为 0。此项只更新前端资源，未重启审计后台。记录位于 `reports/workbench-migration/terminal-popup-20261005/verification.json`。

2026-10-08 ttyd 迁移验收：34 项监控测试与 7 项原功能回归通过，类型检查和生产构建通过。Chrome DevTools MCP 配合真实 OpenCode 1.18.34、本机模型响应替身验证 TUI、同 session 中文输入、只读限制、缩放、重连、关闭后重开、JSON 事件及任务结束清理；关闭页面后原任务继续运行。正式平台已加载 ttyd 1.7.7，未修改 watchdog 与 JSON 执行协议。证据位于 `reports/workbench-migration/ttyd-20261008/verification.json`。

## 启动并提交任务

在仓库根目录执行，直接运行于宿主机。以下命令适用于 Windows PowerShell、macOS 和 Linux，构建需要 Node.js 22.22.3 或更高版本：

```sh
# 首次安装或拉取依赖变更后，同步构建依赖及当前系统的原生组件
npm --prefix apps/workbench ci --include=dev --include=optional
npm --prefix apps/workbench run build

# 当前工作区已构建，可直接执行这一条
npm --prefix apps/workbench run start:platform
```

`build` 不会自动安装依赖。监控构建需要 `devDependencies` 中的 `esbuild`，React Router、TypeScript 和 Vite 也属于构建依赖；显式 `--include=dev` 可避免生产环境安装设置遗漏它们。`--include=optional` 保留当前系统需要的原生组件。出现 `Cannot find package 'esbuild'` 时，先执行上面的 `ci` 命令，成功后再构建；无需全局安装 esbuild，也不要从 macOS/Linux 复制 `node_modules` 到 Windows。只在仓库根目录或 `.opencode` 安装依赖不会同步 `apps/workbench` 的依赖。

打开 `http://127.0.0.1:4181`，点击“创建审计”：

1. 填写任务名，选择产品和模型。
2. 选择已有源码对象，或登记本机源码绝对目录。当前 Runner 仅支持一个完整源码目录；多范围、过滤规则及不可用对象会明确禁用。
3. 选择 Focus Area 或 API 策略；API 策略须填写接口清单。可调整历史记忆、越权专项和补充说明。
4. 默认只进行静态审计。动态测试须明确勾选授权并填写环境说明；未启用或环境为空时记为 `SKIPPED`。完整自由文本作为私有上下文交给 Agent，不要求固定账号字段或 JSON 格式。
5. 提交后进入真实任务详情。队列可能先将任务置为等待状态；可以按实际状态执行立即调度、暂停、恢复、取消、断点恢复。取消需要在页面再次确认。断点恢复仍由原平台核验源码和已有制品等条件。

默认只开放 4181 新界面，4173 原界面保留入口不启动，4181 的 `/legacy` 及 `/legacy/` 返回 404。审计执行服务独立提供本机 4183 API，不提供任何工作台页面；新界面不依赖 4173。脚本复用或启动这一执行服务，遇到只读、未知或未加载当前代码的服务会明确退出，不关闭或替换已有进程。自定义 `WORKBENCH_UPSTREAM` 时须先启动对应 API 服务，不能将本机 4173 原界面配置为后台。

需要原界面时，显式执行：

```bash
npm --prefix apps/workbench run start:platform -- --legacy
```

此时同时开放 4181 新界面与 `http://127.0.0.1:4173/` 原界面，页面中的“原界面保留入口”指向 4173；两者使用同一个执行服务及任务数据，不创建第二个 Runner。再次按默认命令启动就不开放原界面。

升级前已有旧版服务运行时，先确认活动任务已结束，再执行 `node .opencode/scripts/audit-service.mjs stop`，随后重新运行启动命令。停止保护会拒绝关闭仍有活动任务的服务；不要为切换界面强制结束任务。

保持 Web 终端运行以访问页面。Ctrl+C 只关闭本次 Web 服务和终端连接；独立审计后台及其任务继续运行。后台状态和停止入口为 `node .opencode/scripts/audit-service.mjs status|stop`；存在运行、排队或暂停任务时拒绝停止。后台自身重启后，已落盘任务保留，后台创建的活动任务需要断点恢复，原生会话通过重新登记接回。

## 双入口与执行会话

Web 负责创建入口、进度展示、任务管理、人工复核和报告整合。`start-platform.mjs` 只连接独立执行服务，不再拥有审计进程的生命周期。执行服务对任务目录持有独占锁；只读 Runner 不迁移登记文件、不恢复或改写活动任务。

- **Web 创建**：后台冻结源码范围、创建任务板和执行会话。公开详情中的 `execution` 提供引擎、入口、归属、运行标识和实际 session ID。前端以 audit ID 打开 ttyd，终端服务从私有连接文件解析同一个会话，认证信息不发给页面。
- **原生 OpenCode 创建**：本项目配置加载当前会话插件。Orchestrator 先调用 `audit_register`；插件从 `ToolContext.sessionID` 取真实 ID，后台仅登记并准备任务板/制品服务，主任务继续留在当前会话。插件为该会话及其子会话注入 `AUDIT_*` 环境，回传事件，通过原生 SDK 执行暂停/恢复指令。原生终端进程由用户持有，后台不发送进程终止信号。
- **恢复与完成**：重复登记复用原任务。原生会话失联后停止后台领取并保留制品；重新登记沿用已有范围和制品。暂停状态不会因重连而自动运行。两种入口都按既有任务板、报告摘要和独立复核门禁判定完成，`session.idle` 不等于审计完成。未授权动态测试保持 `SKIPPED`。

原生入口配置变更需要 OpenCode 重新加载配置；已经运行且未加载插件的进程不会被平台自动重启。在本项目打开原生 OpenCode 后，直接说明要审计的源码目录即可。后台控制入口只接受本机私有连接文件中的令牌，不接受浏览器 Origin。主会话记录与专业 worker 会话各自独立；登记主会话不会停止专业任务调度。

`audit-agent-session.v1` 提供与前端无关的登记/心跳协议；`.opencode/scripts/audit-session-mcp.mjs` 是通用 stdio MCP 桥接，提供 `audit_register`、`audit_command`、`audit_checkpoint`。宿主须传递真实当前 session ID，不能生成替代 ID。可将 Codex/Grow 的当前会话接到同一任务板、记忆接口与进度记录；此桥接不接管宿主输入、不承诺其 TUI 直连。当前后台创建主会话、专业 worker 和动态执行仍由 OpenCode 适配实现；Web 请求创建尚未适配的引擎会明确返回 `agent-launch-unavailable`，不会把该引擎名称静默当作 OpenCode 执行。其他引擎的完整启动、控制和专业执行适配需要单独验证，不能仅凭安装 CLI 就宣称可切换。

验证入口：`node --test .opencode/tests/run-audit-runtime-tests.mjs`。测试使用隔离源码和受控执行替身，覆盖双入口、重复登记、事件、暂停/恢复、失联、单写入者、鉴权与真实报告门禁；不联系被测应用。

## 入口与回退

| 入口 | 命令 | 默认地址与能力 |
| --- | --- | --- |
| 新平台任务模式 | `start:audit-workbench:platform` | 4181，真实任务创建与执行 |
| 新版只读融合 | `start:audit-workbench:modern` | 4181，真实数据只读，与任务模式二选一 |
| 原平台 | `start:audit-workbench` / `start:audit-workbench:runner` | 4173，原界面完整保留 |
| 首版封存预览 | `start:audit-workbench:preview` | 4180，原始演示效果，不执行真实审计 |

表中为历史命令兼容入口，均使用 `npm --prefix .opencode run <命令>`。日常使用上面的 `apps/workbench` 启动命令；需要同时保留原界面时使用 `--legacy`，不要额外启动旧版独立 Runner。默认隐藏“原界面保留入口”；显式启用后才链接到 4173。`/api/workbench/legacy` 与 `/legacy` 均不再作为旧界面入口。

新版保留 React 导航和概览；真实业务页面直接装配原平台的完整 HTML、样式和交互控制器，以 Shadow DOM 隔离样式。控制器在切换菜单时持续保留，避免丢失产品选择、筛选、任务详情和事件订阅。它不是重新实现的 React 表单，也不再用展示性卡片代替原功能。包括产品与对象、目录与长期记忆、产品审计批次、任务面板与执行控制、新建重试、漏洞处置、完整报告、动态验证与 HTTP 证据、运行环境、模型与队列设置。

新建重试会显式读取原任务的私有重试草稿，回填模型、源码对象、策略、API 清单、历史记忆、专项、补充说明和测试环境。提交时生成新任务编号及幂等键，原任务保持原样；断点恢复仍沿用原任务编号。已完成任务使用“再次审计”，执行不完整的任务不会错误显示断点恢复。

任务列表“操作”列和任务详情“概览”均提供“删除任务”，适用于所有产品。排队、已完成、失败、中断、已取消及历史制品任务可在确认后删除；运行中或暂停中的任务须先取消并等待结束。删除会清理此任务的运行状态、可归属报告、临时工作区、验证/处置记录和对象关联，保留源码及其他任务。删除期间禁止同时调度或恢复；版本或产品归属发生变化时拒绝操作并提示刷新。

新版默认 API 服务为 `http://127.0.0.1:4183`，可通过 `WORKBENCH_UPSTREAM` 指定无凭据的 HTTP(S) origin，浏览器不能修改上游。`WORKBENCH_PORT` 可以修改新版端口。若手动启动原平台，增加 `--modern-ui-origin http://127.0.0.1:4181` 可以显示返回新版的链接。

保留副本：

- 首版预览：`apps/workbench/.releases/preview-20261001/`，当前生产构建不会覆盖。
- 融合前源码：`reports/workbench-migration/baseline-20261002-001219/`，包括源码、SHA-256 清单和原 Git 状态。
- 开启任务写入前源码：`reports/workbench-migration/before-task-write-20261002-112939/`，保留上一阶段的新版只读实现。

备份与封存目录均被 Git 忽略，换机器时需单独复制。恢复源码前先保存后续修改，将归档解包到独立目录对比；不要覆盖未提交工作。显式开启 4173 原界面不需要迁移或回滚业务数据。

## 执行状态与问题定位

创建表单立即显示，产品、模型、执行器和源码选项分别加载。默认同机模式的模型选项直接读取本机配置；需要转发的初始化接口等待上限为 5 秒，浏览器等待上限为 8 秒；不自动重试，失败项单独显示错误与请求编号，手动重试会保留已填写内容。所有必需选项就绪后才允许创建任务。

真实页面沿用原平台的事件订阅、执行日志、任务面板和事件监控窗口；顶部刷新与页面内刷新都能重新读取原记录。概览每 15 秒刷新。新增概览中的源码对象数量、风险分布和动态验证入口；风险分布可以跳转至对应等级的发现列表。

创建请求在同一次表单中使用固定任务编号和幂等键，不自动重试 POST。结果不明时保留原提交内容，可先查看任务列表或用同一请求确认结果。操作携带原任务版本；412 版本冲突保留原错误并刷新页面状态。产品归属由服务端查询原平台，不相信浏览器提交的归属信息。

新版接口诊断默认写入 `reports/platform/workbench-api/requests.jsonl`，可用 `WORKBENCH_DIAGNOSTICS_DIR` 指定目录。仅记录时间、请求编号、路由、任务编号、HTTP 状态和耗时；转发失败时增加上游等待阶段（headers/body）、已收到的上游状态及系统错误码，不记录私有表单正文、账号、请求头、响应正文或底层异常文本。错误提示中的请求编号可与此文件关联。

用户启动任务后，分析运行问题时提供任务 ID 即可。结合新版接口诊断、原平台 `reports/platform/audit-runs/<audit-id>/`、任务执行工作区和所属源码对象的报告目录，可以区分界面刷新问题、接口失败、队列等待和 Agent 执行错误。分析前先读记录，不自动重复启动、恢复或取消用户任务。

## 验证

```sh
npm --prefix apps/workbench run typecheck
npm --prefix apps/workbench run build
npm --prefix .opencode run test:audit-workbench:platform
```

任务模式的接口与内核回归覆盖任务创建和控制、授权开关、幂等、版本冲突、模型读取、中文与二进制传输、实时事件流、分页筛选、完整报告、原页面入口、只读及跨站写入隔离、新建重试的完整回填与独立任务创建。全部内核测试使用临时目录、受控队列和进程替身，不启动实际 Agent。产品记忆另有页面控制器生命周期和旧响应隔离测试。逐项覆盖及最近结果见 `reports/workbench-migration/feature-parity-20261002/verification.json`。

当前会话连接本机端口被 EPERM 拒绝，且没有可用的 Chrome DevTools MCP；本轮未完成浏览器渲染、实际按钮交互和真实 Agent 运行验收。接口与构建通过不等于全平台运行通过。动态安全验证本轮为 `SKIPPED`，未访问被审计目标。

保留此前带端口的回归命令 `npm --prefix .opencode run test:audit-workbench:modern`。此前融合阶段的 14 项接入测试通过；完整旧平台回归曾停在 `run-audit-workbench-tests.mjs:626` 的 `memory_mode: full` 预期差异。本轮没有改旧业务或修订该断言，因此不宣称全平台回归通过。

## 创建表单加载故障修复（2026-10-02）

现场日志中，`/api/workbench/task-options` 请求 `0ca8aed1-ab2f-49b3-9bdb-6ac362667b34` 在 15005 ms 后返回 503，而同期概览与任务列表正常。旧表单等待产品、模型及执行器的聚合结果，且首次失败会自动重试一次，导致整屏长时间仅显示加载提示。

修复后改用独立的 `task-products`、`task-models`、`task-runner` 接口，源码目录也单独读取；前后端同时对获取响应和读取正文设置时限，关闭表单会取消浏览器请求。初始化失败不会清空输入，也不会自动执行或重复提交任务。原聚合接口保留兼容，使用相同的上游时限。

上一轮拆分初始化接口后，现场确认失败项是模型配置：请求 `6c1aed35-c788-4cc6-9d82-4379dae4329d` 在 5001 ms 后返回 503。用户随后确认，在浏览器直接访问原平台的 `/api/v1/settings/model` 和 `/api/v1/findings?live=1` 都立即返回。这将排查范围缩小到新版转发链路；不能据此断言原平台配置读取缓慢，也尚未证实全局 fetch 阻塞的具体原因。

## 发现、报告和转发链路修复（2026-10-02）

- 新版到原平台的所有请求（包括任务写入、预检、报告和 SSE）改用独立的 Node HTTP(S) 连接池，不共享全局 fetch 调度器或环境代理。请求地址仍由服务端固定配置，拒绝重定向；取消和超时会释放实际响应流。不进行自动 POST 重试。
- 发现列表使用原服务的筛选、页码、总数和页大小；原服务每页 50 条。搜索及风险筛选覆盖完整结果集，任务详情可跳转到该任务全部发现。页面保留标题和筛选控件，读取失败有明确状态，不伪装成零条发现。
- 报告日期改用原接口的 `sealed_at`。报告弹窗读取完整正文和原平台的 Markdown 渲染结果，在禁止脚本及同源权限的 iframe 中显示，可切换 Markdown。下载明确请求 `format=original`，保持封存字节，包括 BOM 和换行。404 等失败不会被保存成报告文件。
- 诊断记录可区分上游响应头未返回与正文未结束，并通过页面请求编号关联；不记录私有数据。

本轮构建及 32 项测试通过；47 个首版封存文件的 SHA-256 与基线一致，原平台 `server.mjs` 与本轮修复前备份一致。验证记录位于 `reports/workbench-migration/read-pages-fix-20261002/`，本轮修复前源码位于 `reports/workbench-migration/before-data-pages-fix-20261002-144155/`。

当前会话访问本机端口仍受 `EPERM` 限制，未绕过限制启动浏览器，因此模型现场超时是否消失及最终页面效果仍待重启新版后复验。这段修复记录当时的两个端口为独立进程，现已变化：当时检查的 4173 和 4181 曾共用 PID 57710。此为历史记录；当前执行服务已独立，默认关闭 4173，Web 重启不停止后台任务。

## 本机模型配置读取

默认同机部署（审计 API 地址为 `http://127.0.0.1:4183`）的模型选项直接读取本机配置，复用原平台 `OpenCodeModelCatalog` 的 JSON/JSONC 解析和模型 ID 规则。读取范围与原平台一致：项目 `.opencode/opencode.json[c]`、XDG 配置目录及其中的 `opencode/opencode.json[c]`。当前选择从 `reports/platform/opencode-model-settings.json` 只读取得；同设 `AUDIT_WORKBENCH_STATE_ROOT` 时使用该运行目录旁的选择文件。不会另建设置存储，也不会返回 API key、供应商 URL 或原始配置。

`WORKBENCH_MODEL_SOURCE` 默认为 `auto`：上述默认同机地址走文件读取，自定义上游走该上游的模型接口。需要匹配原平台独立的自定义目录或运行账号时，可显式使用 `upstream`；`local` 可显式选择当前宿主机配置。任务提交仍由原平台核验模型。原选择已不在目录中时，表单保留该选择并要求重新选择，不静默换成默认模型。

实际本机配置验证：新版生产 API 处理器返回 HTTP 200、12 个选项（包含“默认”），选中 `aliyun/qwen3.8-flash`；耗时约 10 ms，上游请求数为 0。该验证在进程内执行，读取实际配置文件，未绑定网络端口。记录见 `reports/workbench-migration/model-config-direct-read/actual-config-verification.json`。模型读取与真实任务调度是两个独立的验收项；该结果不代表 Langflow 任务已经启动。

## Langflow / Qwen 真实任务启动

已核对 OpenCode 配置存在 `aliyun/qwen3.8-flash`，Langflow 已登记在产品目录中，源码位于 `/Users/wh4lter/Workspace/opensources/langflow`。用户本次指定本地 Docker 中的 Langflow 测试；该对象已有环境说明指向 `http://127.0.0.1:7860/`。现有容器保持运行，平台和控制工具在宿主机执行。

本次准备的任务文件为 `reports/workbench-migration/langflow-qwen38/task-request.json`，编号固定为 `audit-langflow-qwen38-785fb863d95c`。环境文本完整传递给 Agent，默认仅允许导航与正常交互，不授予测试输入或状态变更。文件目前只完成参数准备，**尚未提交或启动**；实时状态以同目录 `progress.json` 及运行后生成的 `.result.json` 为准。

在宿主机正常重启 4181 新版后执行：

```sh
node apps/workbench/scripts/launch-task.mjs reports/workbench-migration/langflow-qwen38/task-request.json
```

该命令先核对运行中后端版本、实际模型目录、产品和源码路径、Runner、概览、任务列表、发现列表、八个页面及保留原界面的 HTTP 入口，以及已有报告的完整正文、封存日期和下载 SHA-256。HTTP 入口检查不等同于浏览器渲染验收。全部预检通过后才创建任务；排队时按当前版本请求调度，观察同一任务直至运行或明确等待。再次执行会先查固定编号，不另建任务；失败或中断任务不会自动恢复。

运行状态只能证明调度已开始。结果中的 `modelResponseVerified` 和 `targetContactVerified` 初始为 `false`，需继续读取实际模型输出与 Chrome DevTools 测试记录后确认，不能把排队、进程启动或旧任务证据当作本次验收通过。

当前 Codex 会话连接本机新版端口返回 `EPERM`，所以没有从此会话执行真实提交，也没有经其他工具绕过权限。只验证任务参数可用可加 `--validate-only`，该选项不会请求服务或提交任务。

## 任务提交超时调查（2026-10-02）

请求 `2da11765-269d-4100-8695-f25eab8b214b` 在等待原平台响应头 60 秒后返回 503；对应任务 `audit-1790934617478-d467000c` 未找到运行目录或产品关联记录。随后概览请求也在等待响应头时超时。当前证据尚不能确定原进程内部卡在哪个步骤，不能将隔离测试通过当作现场故障已修复。

已修复启动时无条件复用旧代码后台的问题：原平台健康接口现在返回模块加载时固定的核心源码摘要，新版启动器核对本机默认后台的摘要。缺少版本信息或摘要不一致时返回 `UPSTREAM_RESTART_REQUIRED`，要求正常重启原后台，不会继续发布连接旧内核的新版，也不会自动启动第二个 Runner。自定义远程上游不按本机文件摘要判断版本。

新增验证使用真实 Node HTTP 编解码、连接池、请求流、模型目录、SQLite 产品目录、队列与对象锁，只在内存中连接隔离服务，最后的 Agent 启动动作使用测试替身。动态环境文本完整保存，创建响应正常返回后释放对象锁，重复提交只调度一次；当前 42 项相关测试通过。该测试不绑定端口，不调用模型或联系被测应用。

本次实际执行 `npm --prefix .opencode run start:audit-workbench:platform` 仍因当前会话连接本机端口被 `EPERM` 拒绝而退出。旧进程未被停止，新平台与真实任务均未由此次尝试启动。需要恢复本机会话网络权限或由宿主机终端完成运行后，才能确认并修复现场剩余问题。

## 技术结构

测试环境占用可在“运行环境 → 测试环境占用”中查看。列表显示目标、原任务、占用时间、动态阶段失败原因和清理状态。已结束且无清理遗留的旧占用会在下次申请时自动回收；清理未知或失败时，需要填写核对说明后解除。活动任务或仍有执行进程的占用不能解除，操作还会校验版本，防止旧页面释放新的占用。核对记录单独存档，原任务证据和清理结论不被改写；解除占用不会自动重启任务或访问测试目标。

相关回归：`node .opencode/tests/run-runtime-environment-lease-tests.mjs`、`node .opencode/tests/run-runtime-testing-tests.mjs`。

前端为 React、TypeScript、React Router、Vite、Tailwind CSS、shadcn/ui 与 TanStack Query；后端为 NestJS、Fastify 和 SSE。构建输出位于 `build/`，依赖由 `package-lock.json` 固定。

| 文件或目录 | 职责 |
| --- | --- |
| `app/components/create-real-audit.tsx` | 真实任务表单、授权开关和提交结果 |
| `app/routes/audit-detail.tsx` | 执行控制、状态同步和日志 |
| `server/task-contract.ts` | 写入参数白名单和协议校验 |
| `server/live.service.ts` | 原平台任务、发现、报告、日志与 SSE 适配 |
| `server/upstream-transport.ts` | 独立 HTTP(S) 连接池、流读取和取消 |
| `server/local-models.ts` | 复用原解析器，只读本机模型及当前选择 |
| `server/runtime.service.ts` | 只读、预览、真实任务模式边界 |
| `server/main.ts` | HTTP、防跨站写入、诊断、SPA 与回退入口 |
| `scripts/start-platform.mjs` | 宿主机启动、原服务预检与进程归属管理 |
| `scripts/launch-task.mjs` | 新版入口检查、指定模型任务提交、固定编号观察 |
| `tests/task-*.test.mjs`、`tests/read-pages.test.mjs`、`tests/upstream-transport.test.mjs` | 不绑定端口的接口、传输与原业务内核契约测试 |

开发热更新仍可使用 `npm --prefix apps/workbench run dev`（5180 前端、4180 API）；不要与封存预览同时占用 4180。shadcn/ui 许可见 `THIRD_PARTY_NOTICES.md`。


## 完整功能继承与当前加载状态（2026-10-02）

本次构建将服务版本提升至 `apiVersion: 3`，运行配置同时提供 `featureVersion: 1`。前端读取不到这个功能版本时会明确要求重启后台，避免新静态资源请求尚未加载的接口。顶部返回链接、原界面静态资源、原 API、下载和 SSE 都在同一入口工作；保留原后台端口并不意味着可以缺少原后台进程。

当前监听进程在这次修改之前启动，尚未加载新后端。需要在启动平台的终端正常停止并重新执行 `npm --prefix .opencode run start:audit-workbench:platform`，再刷新页面；若有活动任务，停止平台会影响它们。本轮未停止这个进程，也未以第二个 Runner 修改其数据。4173 的现场可访问性、浏览器操作和真实任务启动仍待权限可用后的验收，不能将本次代码修复记为这些验收已通过。
