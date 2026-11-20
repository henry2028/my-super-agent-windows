# Super-agent for DeepSeek Harness — Windows

[中文](#中文) | [English](#english)

## 中文

这是基于 DeepSeek Harness（DSH）Super-agent 原型改造的 Windows 版本。它接收本地工单，并可选接入飞书或 GitHub，交由 DSH 会话处理，再按任务需要调用 Codex、Claude Code 或用户配置的其他 CLI 智能体。

本项目是研究原型，请在自己的环境验证后使用。上游文章中的部分设计是未来方向，已验证独立安装、本地工单、Codex 真实调用和核心调度；飞书、GitHub 及 Claude 的实际连接需要各安装者验收。

### 功能

- **接单和跟进**：监听本地 Markdown 工单目录。可选启用飞书机器人或 GitHub 来源，按配置的发送者、聊天范围和策略处理请求。
- **主会话和工单会话**：主会话负责路由和协调，每张工单有独立的执行会话及执行目录。会话、工单和 worker 的归属会持久保存，重启后可恢复。
- **分工和审核**：工单可登记步骤、依赖、目录边界及审核要求，记录真实外派进程与审核结果。模型负责拆分和调用 worker，宿主检查登记的计划与完成条件，计划本身不会自动启动所有步骤。
- **多智能体**：支持 DSH、Codex、Claude Code 和符合标准输入输出约定的自定义 CLI。进程池限制并发，同一目录的进程工作保持独占。worker 完成后结果回传给发起会话。
- **逐版协作**：工单写明「协作模式：逐版」后，执行器将每版制作外派，等待 Codex 审核并记录处理意见，再派下一版。派工后执行器结束当前回合，结果到达后自动唤醒。需要视觉审核时可加入 Claude。
- **恢复和可视化**：执行器处理 worker 完成通知和可继续的工作；调度甘特图显示工单、worker、步骤、依赖及状态。遇到需要人工输入或明确阻碍的情况，工单等待处理。
- **飞书工作区**：工单机器人提供 `/ws` 文字命令，可选择工作区并保留工单及子 worker 的归属。

### 安装

需要 Windows、Node.js 24 或更新版本、Git 和可访问 npm 的网络。运行 DSH、Codex、Claude 的 Windows 账号应各自完成所需登录。部署脚本安装官方 DSH 0.2.2-rc.5 和构建依赖，已有脚本管理的旧版运行时会升级。

```powershell
git clone https://github.com/henry2028/my-super-agent-windows.git
Set-Location my-super-agent-windows
powershell -NoProfile -ExecutionPolicy Bypass -File .\Deploy.ps1
```

脚本创建专用 `superagent-windows` profile，默认监听 `127.0.0.1:3082`。将 DSH 输出的登录 URL 复制到浏览器。启动窗口按 `Ctrl+C` 停止，再次运行部署命令即可启动。首次运行若需要其他端口，可指定新的 profile：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Deploy.ps1 -Profile superagent-alt -Port 3182
```

`-NoStart` 只安装并检查配置。`-DshBin "C:\path\to\dsh\lib\bin.js"` 可使用现有的官方 DSH 0.2.2-rc.5。首次安装加 `-Feishu` 或 `-GitHub` 可启用相应入口，后续运行保留首次使用的选项。脚本会保留已生成的用户配置。默认 DSH 数据根目录为 `%USERPROFILE%\.dsh`，也可设置 `DSH_HOME`。新用户需要在 DSH 模型设置中配置模型提供方。

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

### 使用流程示例：飞书派单与多智能体协作

以下以修复项目测试为例。开始前，启用并配置飞书工单机器人、允许的发送者和聊天范围，确认 DSH 模型以及需要使用的 Codex、Claude Code 已登录且连接探针通过。

1. **选择工作区。** 在飞书工单机器人聊天中发送 `/ws`，再根据返回的列表发送 `/ws 2` 等命令。工作区决定会话在 DSH 侧栏中的归组；工单执行目录仍由工单配置决定。如果多个工单同时进行，引用目标工单的原消息发送工作区命令。
2. **发送工单。** 私聊机器人，或在已配置接收范围的群聊中按机器人接收方式 @ 它。例如：

   > 请检查 `C:\work\my-project` 中失败的测试，修复相关代码并运行验证。请安排两个 worker 分别调查测试失败与相关实现，再请 Codex 对最终改动做独立审核。不要修改其他目录；遇到需要决定的问题先询问我。

   写明目标、项目绝对路径、允许修改的范围、验收标准和期望的协作方式。也可以要求 Claude Code 或已配置的自定义 worker 承担某一步。
3. **接单和建计划。** 系统按飞书来源、发送者、聊天范围及策略判断是否接单。接单后，主会话路由工单，工单会话读取上下文并登记分工计划，写明步骤、依赖、允许的读写范围及审核要求。用户可在 DSH 的 Super-agent 执行页查看工单和甘特图。
4. **派发和并行执行。** 工单会话根据计划调用 `worker_start`，为每个 worker 指定运行时、工作目录和任务说明，再把返回的 worker 编号绑定到计划。可独立开展的调查可以并行；进程池限制并发，同一目录同一时间只由一个进程占用。需要并行时，使用不同的现有任务目录或隔离的工作副本，并明确共享项目的只读范围。实际派发由模型执行，登记计划本身不会自动启动进程。
5. **汇总与审核。** 各 worker 结束后，结果回传给发起它的工单会话；工单会话读取调查结果、完成或整合修改并运行检查。依赖完成后，再启动要求的 Codex／Claude 等审核 worker，读取审核意见、处理问题并记录证据。进程成功退出本身不代表审核通过。
6. **查看结果或继续沟通。** 工单会话更新计划并报告结果，满足完成检查后由系统向原飞书会话回传。若等待用户决定或发生实际阻碍，查看飞书消息及执行页的状态，回复所需信息后继续。甘特图显示排队、执行、依赖及归属；飞书中也可引用原消息补充同一工单。

这是一个分工示例，实际并发数、步骤和执行顺序取决于任务、目录占用与配置。可根据需要在工单中明确指定 worker；先用连接探针确认对应 CLI 可用。

### 飞书与 GitHub

启用飞书后，在面板配置专用机器人 CLI、允许的发送者和聊天范围。若使用 dsh-im，需要在同一 profile 安装支持 `exclusive-text-consumer` 的版本，并选择相应接入方式。机器人聊天中发送 `/ws` 列出工作区，`/ws 序号` 选择，`/ws --default` 返回默认工作区。共享调度会话跟随最近一次明确选择。多个工单并行时，引用目标工单的原消息再切换，可定位当前工单。工作区归组与实际执行目录分别管理。

启用 GitHub 后，在面板配置仓库、执行账号和接单策略。使用拥有目标仓库写入权限的机器人 GitHub 用户账号，安装 GitHub CLI 并在独立配置目录登录，在面板填写该 CLI。飞书自建应用需启用机器人、消息接收与发送以及聊天成员读取权限，并发布应用版本。为机器人准备独立的 lark-cli 配置，并设置 strict mode 为 bot。本地工单无需配置这些账号。

### 故障排查与更新

- `list` 找不到 CLI 时，在向导中指定原生 `.exe` 路径。探针失败时，先以同一 Windows 用户直接运行 CLI，检查登录、模型、网络和本机转发服务。
- 端口被占用时，检查是否已有实例，或首次安装时选择其他 profile 和端口。
- 工单没有继续时，查看执行页的状态、依赖、worker 结果及是否等待人工输入。
- 更新前停止专用 profile，在仓库目录运行 `git pull`，然后重新执行原部署命令。保留 state 目录即可保留工单历史。

## English

This Windows edition adapts the DeepSeek Harness (DSH) Super-agent prototype. It accepts local work orders, optionally receives Feishu or GitHub requests, and coordinates DSH sessions with Codex, Claude Code, and operator-configured CLI workers.

This is a research prototype. Validate it in your environment before relying on it. Some ideas in the upstream design article remain future work. Independent installation, local intake, a real Codex request, and core scheduling have been verified. Feishu, GitHub, and Claude connections require validation by each installer.

### Features

- **Intake and follow-ups:** watch a local Markdown directory, with optional Feishu and GitHub sources governed by configured sender, chat, and policy rules.
- **Sessions and ownership:** a main session routes work; each ticket has an execution session and directory. Session, ticket, and worker ownership are persisted for recovery after restart.
- **Delegation and review:** record steps, dependencies, directory boundaries, required reviews, actual worker processes, and review outcomes. The model splits and starts work; the host checks the recorded plan and completion requirements. A plan does not automatically launch every step.
- **Multiple agents:** run DSH, Codex, Claude Code, and custom CLI workers that implement the stdin/stdout contract. The pool limits concurrency and reserves a working directory for one process at a time. Results return to the requesting session.
- **Iterative handoffs:** request “iterative delegation” to dispatch each version to a worker, wait for Codex review, record the disposition, and then start the next version. The coordinator yields after dispatch and wakes when results arrive. Claude can be included for visual review.
- **Recovery and visibility:** the executor handles worker completion and resumable work. The scheduling Gantt shows tickets, workers, steps, dependencies, and states. Tickets can wait for human input or a blocker to be resolved.
- **Feishu workspaces:** the work-order bot offers `/ws` text commands and preserves ticket and child-worker placement.

### Installation

You need Windows, Node.js 24 or later, Git, and access to npm. Use the same Windows account for DSH and the agent CLIs, and complete each CLI's own login. The installer downloads official DSH 0.2.2-rc.5 and build dependencies, upgrading an older installer-managed runtime.

```powershell
git clone https://github.com/henry2028/my-super-agent-windows.git
Set-Location my-super-agent-windows
powershell -NoProfile -ExecutionPolicy Bypass -File .\Deploy.ps1
```

The script creates a dedicated `superagent-windows` profile on `127.0.0.1:3082`. Open the login URL printed by DSH in your browser. Press `Ctrl+C` in the launch window to stop it and run the same command to start again. To use another port, choose a new profile on first installation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Deploy.ps1 -Profile superagent-alt -Port 3182
```

Use `-NoStart` to install and check configuration without starting the service. Use `-DshBin "C:\path\to\dsh\lib\bin.js"` to reuse an existing official DSH 0.2.2-rc.5 installation. Add `-Feishu` or `-GitHub` on initial installation to enable those sources, and retain the same options on later runs. Generated user configuration is preserved. The default DSH home is `%USERPROFILE%\.dsh`; `DSH_HOME` can select another location. New DSH users must configure a model provider in DSH settings.

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

### Example workflow: Feishu dispatch and multi-agent collaboration

This example fixes failing project tests. First enable and configure the Feishu work-order bot, its allowed senders and chat scope. Confirm that the DSH model and the Codex or Claude Code workers you intend to use are signed in and pass their connection probes.

1. **Choose a workspace.** Send `/ws` to the Feishu work-order bot, then choose an entry with a command such as `/ws 2`. The workspace groups sessions in the DSH sidebar; the ticket configuration still determines the execution directory. When multiple tickets are active, reply to the target ticket's original message to issue its workspace command.
2. **Send a work order.** Message the bot privately, or @ it in an enabled group according to the bot's intake configuration. For example:

   > Investigate the failing tests in `C:\work\my-project`, fix the relevant code, and run the checks. Assign two workers to investigate the failures and related implementation, then ask Codex for an independent review of the final changes. Do not modify other directories; ask me when a decision is needed.

   Include the goal, absolute project path, permitted changes, acceptance criteria, and desired collaboration. You can request Claude Code or a configured custom worker for a specific step.
3. **Intake and planning.** The system evaluates the Feishu source, sender, chat scope, and policy. Once accepted, the main session routes the ticket. Its execution session reads context and records a plan with steps, dependencies, read/write boundaries, and review requirements. Inspect the ticket and Gantt chart on the DSH Super-agent execution page.
4. **Dispatch and parallel work.** The ticket session calls `worker_start` with each worker's runtime, directory, and handoff, then binds the returned worker ID to the plan. Independent investigations may run in parallel, subject to pool capacity and the one-process-per-directory rule. Use distinct existing task directories or isolated working copies and identify shared source paths as read-only where appropriate. The model performs dispatch; recording a plan alone does not start processes.
5. **Integrate and review.** Completed workers return results to the requesting ticket session. It reads the findings, completes or integrates changes, and runs checks. Once dependencies are complete, it starts the requested Codex, Claude, or other review worker, reads findings, addresses issues, and records evidence. A successful process exit alone does not establish review approval.
6. **Receive results or continue.** The ticket session updates the plan and reports its outcome. After completion checks pass, the system replies to the originating Feishu conversation. If a decision or real blocker needs attention, inspect the Feishu message and execution page, then reply with the needed information. Use the Gantt chart to inspect queues, execution, dependencies, and ownership; reply to the original Feishu message to add a follow-up to the ticket.

This is an example split. Actual concurrency, steps, and ordering depend on the task, directory reservations, and configuration. Name the workers you want in the request and verify their CLIs with connection probes first.

### Feishu and GitHub

After enabling Feishu, configure a dedicated bot CLI, allowed senders, and chat scope in the panel. For dsh-im, install a version supporting `exclusive-text-consumer` in the same profile and select its transport. In the bot chat, send `/ws` to list workspaces, `/ws <number>` to select one, or `/ws --default` to return to the default. The shared dispatcher follows the most recent explicit selection. When multiple tickets are active, reply to a ticket's original message to select that ticket. Display grouping and the actual execution directory are managed separately.

After enabling GitHub, configure the repository, execution account, and intake policy in the panel. Use a bot GitHub user with write access, install the GitHub CLI, authenticate it with an isolated configuration directory, and specify that CLI in the panel. A Feishu self-built app needs bot capability, message receive/send and chat-member read permissions, and a published version. Give its lark-cli a separate configuration with strict mode set to bot. Local work orders do not require either account.

### Troubleshooting and updates

- If `list` cannot find a CLI, specify its native `.exe` path in the wizard. If a probe fails, run the CLI directly as the same Windows user and check authentication, model, network, and local relay services.
- If the port is occupied, check for an existing instance or choose another profile and port on initial installation.
- If a ticket does not continue, inspect its execution state, dependencies, worker result, and any pending human input.
- Stop the dedicated profile before updating, run `git pull` in the checkout, and run the original deployment command again. Keep the state directory to retain ticket history.

## License / 许可证

[MIT](LICENSE) · [Workspace compatibility license](compat/workspace/LICENSE)
