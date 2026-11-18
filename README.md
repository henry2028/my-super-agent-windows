# Super-agent for DeepSeek Harness — Windows

[中文](#中文) | [English](#english)

## 中文

这是基于 DeepSeek Harness（DSH）Super-agent 原型改造的 Windows 版本。它接收本地工单，并可选接入飞书或 GitHub，交由 DSH 会话处理，再按任务需要调用 Codex、Claude Code 或用户配置的其他 CLI 智能体。

本项目是研究原型，请在自己的环境验证后使用。上游文章中的部分设计是未来方向，本实现的验收范围见 [功能核对](VERIFICATION.md)。

### 功能

- **接单和跟进**：监听本地 Markdown 工单目录。可选启用飞书机器人或 GitHub 来源，按配置的发送者、聊天范围和策略处理请求。
- **主会话和工单会话**：主会话负责路由和协调，每张工单有独立的执行会话及执行目录。会话、工单和 worker 的归属会持久保存，重启后可恢复。
- **分工和审核**：工单可登记步骤、依赖、目录边界及审核要求，记录真实外派进程与审核结果。模型负责拆分和调用 worker，宿主检查登记的计划与完成条件，计划本身不会自动启动所有步骤。
- **多智能体**：支持 DSH、Codex、Claude Code 和符合标准输入输出约定的自定义 CLI。进程池限制并发，同一目录的进程工作保持独占。worker 完成后结果回传给发起会话。
- **恢复和可视化**：执行器处理 worker 完成通知和可继续的工作；调度甘特图显示工单、worker、步骤、依赖及状态。遇到需要人工输入或明确阻碍的情况，工单等待处理。
- **飞书工作区**：工单机器人提供 `/ws` 文字命令，可选择工作区并保留工单及子 worker 的归属。

### 安装

需要 Windows、Node.js 24 或更新版本、Git 和可访问 npm 的网络。运行 DSH、Codex、Claude 的 Windows 账号应各自完成所需登录。首次部署下载固定版本的官方 DSH 0.2.2-rc.1 和构建依赖。

```powershell
git clone https://github.com/henry2028/my-super-agent-windows.git
Set-Location my-super-agent-windows
powershell -NoProfile -ExecutionPolicy Bypass -File .\Deploy.ps1
```

脚本创建专用 `superagent-windows` profile，默认监听 `127.0.0.1:3082`。将 DSH 输出的登录 URL 复制到浏览器。启动窗口按 `Ctrl+C` 停止，再次运行部署命令即可启动。首次运行若需要其他端口，可指定新的 profile：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Deploy.ps1 -Profile superagent-alt -Port 3182
```

`-NoStart` 只安装并检查配置。`-DshBin "C:\path\to\dsh\lib\bin.js"` 可使用现有的官方 DSH 0.2.2-rc.1。首次安装加 `-Feishu` 或 `-GitHub` 可启用相应入口，后续运行保留首次使用的选项。脚本会保留已生成的用户配置。默认 DSH 数据根目录为 `%USERPROFILE%\.dsh`，也可设置 `DSH_HOME`。新用户需要在 DSH 模型设置中配置模型提供方。

### 连接 Codex、Claude Code 和其他 worker

先在同一个 Windows 账号下通过各 CLI 完成登录，然后运行：

```powershell
node .\bin\workers.mjs superagent-windows list
node .\bin\workers.mjs superagent-windows configure
node .\bin\workers.mjs superagent-windows probe codex
node .\bin\workers.mjs superagent-windows probe claude
```

`list` 检测程序，`configure` 分别配置 `codex` 或 `claude`。程序路径留空使用自动检测，模型留空使用 CLI 默认值。`probe` 在临时目录发送真实模型请求，可能计入用量。显示 `request completed` 表示该探针成功。配置更改后重启专用 profile。使用其他 profile 时，将命令中的 `superagent-windows` 替换为实际名称。

要连接其他 CLI，在 `configure` 选择 `custom`，输入名称、可信任的原生程序绝对路径及固定参数 JSON 数组。程序以工单目录为工作目录，通过 UTF-8 stdin 接收一次任务，将最终答案写入 stdout、诊断写入 stderr，成功返回 0，失败返回非零。需适配其他协议时，可选择 `node.exe` 并将适配脚本路径放在参数数组。用 `probe <名称>` 测试后重启 profile。

连接配置保存在 DSH home 的 `profiles/<profile>/workers.json`。密钥请保存在 CLI 自己的账户或环境配置中。自定义程序以当前 Windows 用户权限运行，应由操作者安装和信任。

### 日常使用

1. 启动后打开 DSH 打印的登录 URL，在面板确认模型和本地工单来源可用。
2. 在脚本打印的工单目录创建一个 `.md` 文件，例如写入「检查指定项目的测试失败，用 Codex 独立审核修复」。默认路径是 DSH home 下的 `state/superagent-windows/tasks`。
3. 在 Super-agent 执行页查看工单、分工及甘特图。回复写入工单目录的 `replies/`。修改同一工单文件的内容会作为跟进。
4. 可在工单中明确要求 Codex 或 Claude 审核。工单会话也可通过 `worker_start` 指定 `runtime`，并通过 `worker_status` 查看结果。Codex 首次模型响应默认等待上限为五分钟。

本地工单目录的写入者等同于本机操作者。DSH 执行会话使用完整工具权限，请控制对该目录和飞书接单范围的访问。

### 飞书与 GitHub

启用飞书后，在面板配置专用机器人 CLI、允许的发送者和聊天范围。若使用 dsh-im，需要在同一 profile 安装支持 `exclusive-text-consumer` 的版本，并选择相应接入方式。机器人聊天中发送 `/ws` 列出工作区，`/ws 序号` 选择，`/ws --default` 返回默认工作区。共享调度会话跟随最近一次明确选择。多个工单并行时，引用目标工单的原消息再切换，可定位当前工单。工作区归组与实际执行目录分别管理。

启用 GitHub 后，在面板配置仓库、执行账号和接单策略。账户准备及来源设置见 [部署设计](docs/006-deployment.md)。本地工单无需配置这些账号。

### 故障排查与更新

- `list` 找不到 CLI 时，在向导中指定原生 `.exe` 路径。探针失败时，先以同一 Windows 用户直接运行 CLI，检查登录、模型、网络和本机转发服务。
- 端口被占用时，检查是否已有实例，或首次安装时选择其他 profile 和端口。
- 工单没有继续时，查看执行页的状态、依赖、worker 结果及是否等待人工输入。
- 更新前停止专用 profile，在仓库目录运行 `git pull`，然后重新执行原部署命令。保留 state 目录即可保留工单历史。

## English

This Windows edition adapts the DeepSeek Harness (DSH) Super-agent prototype. It accepts local work orders, optionally receives Feishu or GitHub requests, and coordinates DSH sessions with Codex, Claude Code, and operator-configured CLI workers.

This is a research prototype. Validate it in your environment before relying on it. Some ideas in the upstream design article remain future work. See [verification](VERIFICATION.md) for the tested scope and known limitations.

### Features

- **Intake and follow-ups:** watch a local Markdown directory, with optional Feishu and GitHub sources governed by configured sender, chat, and policy rules.
- **Sessions and ownership:** a main session routes work; each ticket has an execution session and directory. Session, ticket, and worker ownership are persisted for recovery after restart.
- **Delegation and review:** record steps, dependencies, directory boundaries, required reviews, actual worker processes, and review outcomes. The model splits and starts work; the host checks the recorded plan and completion requirements. A plan does not automatically launch every step.
- **Multiple agents:** run DSH, Codex, Claude Code, and custom CLI workers that implement the stdin/stdout contract. The pool limits concurrency and reserves a working directory for one process at a time. Results return to the requesting session.
- **Recovery and visibility:** the executor handles worker completion and resumable work. The scheduling Gantt shows tickets, workers, steps, dependencies, and states. Tickets can wait for human input or a blocker to be resolved.
- **Feishu workspaces:** the work-order bot offers `/ws` text commands and preserves ticket and child-worker placement.

### Installation

You need Windows, Node.js 24 or later, Git, and access to npm. Use the same Windows account for DSH and the agent CLIs, and complete each CLI's own login. The first installation downloads official DSH 0.2.2-rc.1 and build dependencies.

```powershell
git clone https://github.com/henry2028/my-super-agent-windows.git
Set-Location my-super-agent-windows
powershell -NoProfile -ExecutionPolicy Bypass -File .\Deploy.ps1
```

The script creates a dedicated `superagent-windows` profile on `127.0.0.1:3082`. Open the login URL printed by DSH in your browser. Press `Ctrl+C` in the launch window to stop it and run the same command to start again. To use another port, choose a new profile on first installation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Deploy.ps1 -Profile superagent-alt -Port 3182
```

Use `-NoStart` to install and check configuration without starting the service. Use `-DshBin "C:\path\to\dsh\lib\bin.js"` to reuse an existing official DSH 0.2.2-rc.1 installation. Add `-Feishu` or `-GitHub` on initial installation to enable those sources, and retain the same options on later runs. Generated user configuration is preserved. The default DSH home is `%USERPROFILE%\.dsh`; `DSH_HOME` can select another location. New DSH users must configure a model provider in DSH settings.

### Connect Codex, Claude Code, and other workers

First authenticate each CLI using its own login flow under the same Windows account. Then run:

```powershell
node .\bin\workers.mjs superagent-windows list
node .\bin\workers.mjs superagent-windows configure
node .\bin\workers.mjs superagent-windows probe codex
node .\bin\workers.mjs superagent-windows probe claude
```

`list` detects executables. Use `configure` separately for `codex` and `claude`; leave the executable path blank for automatic discovery and the model blank for the CLI default. `probe` sends a real model request from a temporary directory and may incur usage charges. `request completed` indicates success. Restart the dedicated profile after changing connections. Substitute your profile name if it differs from `superagent-windows`.

For another CLI, select `custom` in `configure` and enter a name, the absolute path to a trusted native executable, and fixed arguments as a JSON array. The program runs in the ticket directory, reads one UTF-8 prompt from stdin, writes its final answer to stdout and diagnostics to stderr, and returns zero on success or nonzero on failure. For other protocols, choose `node.exe` and pass an adapter script path in the arguments. Run `probe <name>` and restart the profile.

Connections are stored in `profiles/<profile>/workers.json` under DSH home. Keep secrets in the CLI's own account or environment configuration. Custom programs run with the current Windows user's permissions and should be installed and trusted by the operator.

### Daily use

1. Start the profile, open the login URL printed by DSH, and check that the model and local source are ready.
2. Create a `.md` file in the work-order directory printed by the script, such as a request to investigate failing tests and have Codex independently review the fix. The default is `state/superagent-windows/tasks` under DSH home.
3. Inspect the ticket, plan, and Gantt chart on the Super-agent execution page. Replies are written to `replies/` under the ticket directory. Editing the same work-order file submits a follow-up.
4. Request Codex or Claude review explicitly in the ticket. A ticket session can also call `worker_start` with a `runtime` and inspect the result with `worker_status`. The default Codex first-model-response timeout is five minutes.

Anyone able to write to the local ticket directory acts as the local operator. DSH execution sessions have full tool permissions, so control access to that directory and to the Feishu intake scope.

### Feishu and GitHub

After enabling Feishu, configure a dedicated bot CLI, allowed senders, and chat scope in the panel. For dsh-im, install a version supporting `exclusive-text-consumer` in the same profile and select its transport. In the bot chat, send `/ws` to list workspaces, `/ws <number>` to select one, or `/ws --default` to return to the default. The shared dispatcher follows the most recent explicit selection. When multiple tickets are active, reply to a ticket's original message to select that ticket. Display grouping and the actual execution directory are managed separately.

After enabling GitHub, configure the repository, execution account, and intake policy in the panel. See the [deployment design](docs/006-deployment.md) for account and source setup. Local work orders do not require either account.

### Troubleshooting and updates

- If `list` cannot find a CLI, specify its native `.exe` path in the wizard. If a probe fails, run the CLI directly as the same Windows user and check authentication, model, network, and local relay services.
- If the port is occupied, check for an existing instance or choose another profile and port on initial installation.
- If a ticket does not continue, inspect its execution state, dependencies, worker result, and any pending human input.
- Stop the dedicated profile before updating, run `git pull` in the checkout, and run the original deployment command again. Keep the state directory to retain ticket history.

## Documentation and license

- [Windows setup guide](WINDOWS-SETUP.md) · [Verification](VERIFICATION.md)
- [Original design documentation](docs/) · [Deployment](docs/006-deployment.md) · [Architecture](docs/007-architecture.md)
- [MIT license](LICENSE) · [Workspace compatibility license](compat/workspace/LICENSE)
