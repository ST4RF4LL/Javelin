# Javelin

Javelin 是一个多 Agent 安全审计平台，支持源码审计、授权动态测试及两者联合分析，覆盖 Web、Java、Python、C/C++、AI 与平台配置。通过工作台管理任务，使用 OpenCode v1、OpenCode v2 或 Grow 执行分析，经独立复核后输出中文报告和可追溯证据。

## 必备工具

- **Git**：获取平台代码及管理源码版本。
- **Node.js 22.22.3+ 与 npm**：运行审计后台、安装依赖并构建工作台。
- **至少一个 Agent 执行器**：OpenCode v1、OpenCode v2 或 Grow，须预先配置可用模型。安装与路径配置见 [Agent 基座说明](docs/agent-engines.md)。

按需安装以下工具；它们不是启动工作台的统一前提：

| 能力 | 所需工具 |
| --- | --- |
| 源码模式扫描 | OpenGrep 或 Semgrep，至少一个 |
| BAC 越权专项（新任务默认开启） | Python 3.10+ |
| Web 动态测试 | Google Chrome；Chrome DevTools MCP 由平台调用 |
| 交互终端 | ttyd；默认日志与事件查看无需安装 |
| 密钥、依赖及深度数据流扫描 | 分别使用 Gitleaks、OSV-Scanner、Joern + JDK |
| Decision Model 连接测试 | curl（Windows 为 curl.exe） |

支持 Windows、macOS 和 Linux，直接部署在宿主机，不使用 Docker、Podman 或 Compose。依赖须在部署机器上安装，不跨操作系统复制 `node_modules`。

## 安装部署

预先安装上述基础工具后，执行以下命令。Windows PowerShell、macOS 和 Linux 使用相同命令：

```sh
# 获取当前 dev 分支
git clone --branch dev https://github.com/ST4RF4LL/Javelin.git
cd Javelin

# 分别安装审计后台与工作台依赖
npm --prefix .opencode ci --include=optional
npm --prefix apps/workbench ci --include=dev --include=optional

# 从模板生成本地配置，保留已有配置
node -e "const fs=require('node:fs'); const p='.opencode/opencode.json'; if (!fs.existsSync(p)) fs.copyFileSync(p+'.bak', p)"

# 构建并启动
npm --prefix apps/workbench run build
npm --prefix apps/workbench run start:platform
```

打开 **http://127.0.0.1:4181**，在工作台设置中核对 Agent 程序路径与默认模型，再登记源码或运行环境并创建任务。`.opencode/opencode.json` 为本机配置，不进入 Git。

需要局域网访问时，将启动命令改为：

```sh
npm --prefix apps/workbench run start:platform -- --host 0.0.0.0
```

审计后台默认监听 `127.0.0.1:4183`，独立于网页进程运行；关闭网页或按 Ctrl+C 不会停止正在执行的审计。升级、停服与故障排查见 [工作台说明](apps/workbench/README.md)。

## 核心能力

- **三种审计模式**：静态、动态、联合；动态测试支持 Web 与 SSH，必须显式授权并提供环境，未授权或环境为空时跳过。
- **四种可组合挖掘策略**：高风险 Focus Area、逐接口 API、逐文件威胁发现、CREED 单函数假设分析。
- **六个专业领域**：Web、Java、Python、C/C++、AI、平台安全；可按任务启用 BAC 越权分析和 Agent 工具边界专项。
- **任务调度与恢复**：队列、并发控制、暂停、继续、取消、失败工作项增量重试，以及执行日志和回执诊断。
- **证据复核与报告**：质量复核及独立正方、反方、Moderator 裁决；保留确认漏洞、反证、执行缺口和清理状态，支持基于报告或单漏洞定向验证。
- **产品与长期记忆**：多 Repo 批次审计、源码快照、历史事实、跨仓库关联与待办；可连接本地 KnowledgeWorkFlow 只读知识库。
- **可追溯交付**：中文报告、JSON 模型、静态扫描 SARIF、运行证据与 HAR / Bruno 导出。报告保存在 `reports/`，临时文件位于 `tmp/`，被审计源码保持只读。
- **Decision Model**：已支持配置、启停及连接测试，当前尚未参与审计调度决策。

更多说明：[任务面板](docs/task-board.md) · [运行测试](docs/runtime-testing-workflow.md) · [越权专项](docs/bac-analysis.md) · [产品记忆](docs/product-memory-implementation.md) · [Agent 边界挖掘](docs/agent-vulnerability-mining.md)。
