# Windows 一键部署与连接智能体

准备 Windows、Node.js 24 或更高版本、Git 和可访问 npm 的网络。首次安装会下载固定版本 DSH 0.2.2-rc.1 和构建依赖。同一个 Windows 用户运行 DSH 和各智能体，CLI 可沿用该用户已有的登录。

```powershell
git clone https://github.com/henry2028/my-super-agent-windows.git
Set-Location my-super-agent-windows
powershell -NoProfile -ExecutionPolicy Bypass -File .\Deploy.ps1
```

复制 DSH 启动时打印的登录 URL 到浏览器。默认端口是 3082，遇到端口冲突时可为首次安装指定 `-Port 3182` 和 `-Profile superagent-alt`。登录 URL 应仅在本机使用。用启动窗口的 Ctrl+C 停止，再运行相同命令启动。脚本保留已生成的用户配置。只生成和检查配置可加 `-NoStart`。已有 DSH 0.2.2-rc.1 时可用 `-DshBin "C:\path\to\dsh\lib\bin.js"` 复用其官方 Node 入口。

安装把插件放入专用的 `superagent-windows` profile，默认使用 `%USERPROFILE%\.dsh`，也支持调用时设置 `DSH_HOME`。工单、数据库和回复都在该 home 的 `state\superagent-windows` 下。现有 DSH 的 web profile 继续独立运行。若已有 DSH 模型登录，专用 profile 复用同一 DSH home 的账户设置。全新用户在 DSH 模型设置配置自己的提供方，等模型可用后再派工。

## 连接自己的 Codex、Claude Code

先使用各 CLI 自带的登录或配置流程完成授权。插件沿用该 Windows 用户的 CLI 配置和登录，连接向导只保存路径和模型选择。

```powershell
node .\bin\workers.mjs superagent-windows list
node .\bin\workers.mjs superagent-windows configure
node .\bin\workers.mjs superagent-windows probe codex
node .\bin\workers.mjs superagent-windows probe claude
```

`list` 检查可执行文件。找不到时，选 `configure` 后填原生 `.exe` 的绝对路径，模型留空使用 CLI 默认。两者分别配置。 `probe` 在临时目录发出一次真实模型请求，可能计入用量。看到 `request completed` 即可重启专用 profile 后派工。若检测到 CLI 但请求失败，用同一 Windows 用户先直接运行该 CLI，验证账号、模型及网络访问。若 CLI 配置了本机模型转发，请先启动转发服务，再运行探针。

在工单写明「用 Codex 审核这次代码改动」或「用 Claude Code 复核这份交付」。工单会话可以用 `worker_start` 指定 `runtime: codex` 或 `runtime: claude`，在 `worker_status` 获取结果。DSH Codex worker 首次模型响应预算为 5 分钟。

## 连接其他 CLI 智能体

在连接向导选择 `custom`。填写给 DSH 使用的名称、可信任的原生 EXE 绝对路径、固定参数 JSON 数组。如果 CLI 需要自定义调用协议，用 `node.exe` 和绝对路径的适配脚本作为固定参数。适配器用 UTF-8 stdin 读取一次任务，在工单目录中运行，把最终答案写入 stdout，诊断写入 stderr。成功返回 0，失败返回非零。至少需要一段 stdout 才算成功。

例如，一个已安装的本地适配器可以填写名称 `my-agent`，程序 `C:\Program Files\nodejs\node.exe`，参数 `["C:/my-tools/my-agent-adapter.mjs"]`。运行 `node .\bin\workers.mjs superagent-windows probe my-agent`，重启后即可在工单中点名它。对应记录与 Codex、Claude 一样会显示进程归属。

向导把配置写入 `$DSH_HOME/profiles/superagent-windows/workers.json`。用户可自行编辑。内置项为 `codex`、`claude`，可设置 `command` 和 `model`。自定义项放在 `agents` 下，各项有 `command` 和 `args`。请把 API 密钥交给 CLI 的账户或环境配置，避免出现在参数和仓库里。自定义程序以当前 Windows 用户权限运行，须由操作者安装和信任。

## 本地及飞书工单

将一个 Markdown 文件写入安装脚本打印的本地工单目录。例如，先准备一个测试目录，请工单在该目录生成小文件并检查内容。可以从 Super-agent 的执行页查看工单及调度甘特图。同一文件的新内容是该工单的跟进。回复写入工单目录下的 `replies`。

工单目录的写入者相当于本机操作者。仅向信任的发送者开放接单，避免让其他账户向该目录写入。本地 DSH 执行会话沿用原插件的完整工具权限。

首次安装可加 `-Feishu` 启用飞书入口。准备专用机器人，用自己的 `lark-cli` 配置 bot-only 登录，在面板指定 CLI 并设置允许接单的发送者和聊天范围。使用已有 dsh-im 机器人时，需在同一 profile 安装提供 `exclusive-text-consumer` 能力的 dsh-im 版本，并在面板选择适配入口。认证细节见 [飞书和 GitHub 账户配置](docs/006-deployment.md#accounts)。

在工单机器人聊天中用 `/ws` 查看工作区、`/ws 序号` 选择、`/ws --default` 返回默认组。共享调度会话跟随最近一次明确的选择。已有工单和 worker 依照该工单自己的选择归组，多个工单并行时引用目标工单的原消息再发指令。文件执行目录由工单决定。

GitHub 接单可选。首次安装加 `-GitHub` 后在面板设置仓库、执行账号和接单策略。普通本地安装不需要 GitHub 或飞书凭据。

## 验收和故障排查

- 先看面板健康状态，再看对应工单或 worker 的错误和甘特图依赖。独立 worker 没有自己的 DSH 会话时，仍可通过甘特图定位其主会话和工单。
- Worker 等待按已派进程跟踪，分工和审核结果由宿主检查。模型负责拆分及提交工作，宿主没有按计划自动派发所有步骤。
- 若启动提示端口占用，确认是不是已有专用 profile 在运行。部署命令不会停止占用端口的进程。
- 更新时先停止专用 profile，再从自己的 checkout 执行 `git pull` 和原部署命令。保留 state 目录即可保留工单历史。
