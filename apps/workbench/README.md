# 新版工作台：真实任务模式

React / NestJS 新版已接入原平台的真实任务创建、调度和执行控制。业务数据、Runner、队列、授权规则及落盘记录沿用原平台；原界面和首版封存预览继续保留。

## 启动并提交任务

在仓库根目录执行，直接运行于宿主机：

```sh
# 首次安装或源码更新后构建
npm --prefix apps/workbench ci
npm --prefix apps/workbench run build

# 当前工作区已构建，可直接执行这一条
npm --prefix .opencode run start:audit-workbench:platform
```

打开 `http://127.0.0.1:4181`，点击“创建审计”：

1. 填写任务名，选择产品和模型。
2. 选择已有源码对象，或登记本机源码绝对目录。当前 Runner 仅支持一个完整源码目录；多范围、过滤规则及不可用对象会明确禁用。
3. 选择 Focus Area 或 API 策略；API 策略须填写接口清单。可调整历史记忆、越权专项和补充说明。
4. 默认只进行静态审计。动态测试须明确勾选授权并填写环境说明；未启用或环境为空时记为 `SKIPPED`。完整自由文本作为私有上下文交给 Agent，不要求固定账号字段或 JSON 格式。
5. 提交后进入真实任务详情。队列可能先将任务置为等待状态；可以按实际状态执行立即调度、暂停、恢复、取消、断点恢复。取消需要在页面再次确认。断点恢复仍由原平台核验源码和已有制品等条件。

启动脚本先检查原服务：4173 上已有可执行 Runner 时直接复用；默认原服务未运行时，在本机启动原平台并开启 Runner。已有只读服务、未知服务或无法确认服务状态时会明确退出，不自动关闭或替换原进程。请在原终端正常停止只读服务，再使用上述命令。自定义 `WORKBENCH_UPSTREAM` 时须先启动该上游，脚本不会自动启动远端或自定义端口的服务。

保持终端运行。Ctrl+C 会停止本次启动的新服务，以及由本次启动脚本创建的原服务和所属任务进程；复用的原服务保持运行。原平台正常重启不会删除已落盘任务，但活动任务可能需要断点恢复。

## 入口与回退

| 入口 | 命令 | 默认地址与能力 |
| --- | --- | --- |
| 新平台任务模式 | `start:audit-workbench:platform` | 4181，真实任务创建与执行 |
| 新版只读融合 | `start:audit-workbench:modern` | 4181，真实数据只读，与任务模式二选一 |
| 原平台 | `start:audit-workbench` / `start:audit-workbench:runner` | 4173，原界面完整保留 |
| 首版封存预览 | `start:audit-workbench:preview` | 4180，原始演示效果，不执行真实审计 |

表中命令均使用 `npm --prefix .opencode run <命令>`。新界面顶部的“返回原工作台”指向同端口的 `/legacy/`，直接返回原页面；原来错误的 `/api/workbench/legacy` 地址也会跳转到这个页面。浏览器不必切换到 4173。原页面的 API 经固定上游转发，业务仍需要原后台正常运行。

新版保留 React 导航和概览；真实业务页面直接装配原平台的完整 HTML、样式和交互控制器，以 Shadow DOM 隔离样式。控制器在切换菜单时持续保留，避免丢失产品选择、筛选、任务详情和事件订阅。它不是重新实现的 React 表单，也不再用展示性卡片代替原功能。包括产品与对象、目录与长期记忆、产品审计批次、任务面板与执行控制、新建重试、漏洞处置、完整报告、动态验证与 HTTP 证据、运行环境、模型与队列设置。

新建重试会显式读取原任务的私有重试草稿，回填模型、源码对象、策略、API 清单、历史记忆、专项、补充说明和测试环境。提交时生成新任务编号及幂等键，原任务保持原样；断点恢复仍沿用原任务编号。已完成任务使用“再次审计”，执行不完整的任务不会错误显示断点恢复。

新版默认上游为 `http://127.0.0.1:4173`，可通过 `WORKBENCH_UPSTREAM` 指定无凭据的 HTTP(S) origin，浏览器不能修改上游。`WORKBENCH_PORT` 可以修改新版端口。若手动启动原平台，增加 `--modern-ui-origin http://127.0.0.1:4181` 可以显示返回新版的链接。

保留副本：

- 首版预览：`apps/workbench/.releases/preview-20261001/`，当前生产构建不会覆盖。
- 融合前源码：`reports/workbench-migration/baseline-20261002-001219/`，包括源码、SHA-256 清单和原 Git 状态。
- 开启任务写入前源码：`reports/workbench-migration/before-task-write-20261002-112939/`，保留上一阶段的新版只读实现。

备份与封存目录均被 Git 忽略，换机器时需单独复制。恢复源码前先保存后续修改，将归档解包到独立目录对比；不要覆盖未提交工作。返回 `/legacy/` 或 4173 原界面不需要迁移或回滚业务数据。

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

当前会话访问本机端口仍受 `EPERM` 限制，未绕过限制启动浏览器，因此模型现场超时是否消失及最终页面效果仍待重启新版后复验。这段修复记录当时的两个端口为独立进程，现已变化：最近检查 4173 和 4181 均由 PID 57710 监听。重启该进程会同时停止两端口，不能再按“仅重启新版、不影响原后台”理解。

## 本机模型配置读取

默认同机部署（原平台地址为 `http://127.0.0.1:4173`）的模型选项直接读取本机配置，复用原平台 `OpenCodeModelCatalog` 的 JSON/JSONC 解析和模型 ID 规则。读取范围与原平台一致：项目 `.opencode/opencode.json[c]`、XDG 配置目录及其中的 `opencode/opencode.json[c]`。当前选择从 `reports/platform/opencode-model-settings.json` 只读取得；同设 `AUDIT_WORKBENCH_STATE_ROOT` 时使用该运行目录旁的选择文件。不会另建设置存储，也不会返回 API key、供应商 URL 或原始配置。

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
