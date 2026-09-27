# DSH Codex 多智能体桥接器

[English](README.md) | 中文

桥接器让持久 DeepSeek Harness worker 同时连接任意组合的 Codex、ChatGPT 网页版和 ChatGPT Windows 应用。一个命名 lane 拥有一个 DSH Session、启用时保存的一个 Codex 线程，以及一个命名 ChatGPT 对话。复用 lane 会保留记忆；换用另一个 lane 会启动可以并行运行的独立 worker。

这是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的实验性独立配套项目，不是 DeepSeek 官方发行版。它面向 Windows，并从相邻且已经构建的 Harness 源码 checkout 加载软件包。

## 安装

使用本项目之前，请安装 Node.js 24 或 22.19+，克隆并构建 DeepSeek Harness，然后配置其 DeepSeek 凭据。Codex 模式还需要已经登录的 `codex` CLI；ChatGPT 模式需要已经登录的 ChatGPT 网页版或 Windows 应用。

请把本仓库克隆为 Harness checkout 的直接子目录，使其父目录包含 `apps/`、`packages/` 和已经构建的 `apps/cli/lib/bin.js`：

```powershell
cd C:\work\deepseek-harness
git clone https://github.com/yelloooooooow/dsh-codex-multi-agent-bridge.git
```

桥接器不会安装或复制凭据。运行状态、Session 日志、控制 token 和浏览器 profile 保存在当前 Windows 用户的主目录下，并被本仓库的 `.gitignore` 排除。这些本地记录可能包含提示词、源码片段、命令输出、文件路径和 ChatGPT 消息；未经检查，不要把它们附加到公开 issue。

## 启动与恢复

双击 `Start Unified DSH Bridge.cmd`；旧名称 `Start Codex-DSH Bridge.cmd` 仍是功能相同的快捷方式。启动器会启动或复用带桥接路由的 DSH Web，询问 lane，接受一个或多个顾问编号，然后询问任务。任务留空会恢复该 lane 中断的 job。

输入 `1,2,3` 或 `all` 可以启用全部路线。以后启动可以更改顾问组合，而不会替换 lane 的 DSH Session。首次启用 Codex 时，请选择一个可见的现有 Codex 任务，或输入 `NEW`。外部 app-server 写入后，需要重新打开 Codex 页面才能看到，因为已经打开的页面不会订阅那个独立进程的实时事件流。

ChatGPT 网页版使用位于 `~/.codex-dsh-bridge/chatgpt-browser-profile` 的专用 Edge 或 Chrome profile。只需在该窗口登录一次。网页和应用路线都会继续 lane 对应的 `桥接对话 · <workspace> · <lane>`，不会每次咨询新建对话。

启动器会把每个 DSH Session 放入工作区对应的 DSH Web 分组，标题为 `桥接对话 · <lane>`。本地 Web patch 不修改鲸鱼挂件。bridge 正在运行时，请把对应 DSH Web Session 当作只读，避免手动消息与协调器竞争写入。

也可以继续使用命令行：

```powershell
node ".\dsh-codex-multi-agent-bridge\bridge.mjs" --task "Inspect the project and report evidence." --lane review-1 --advisors codex,chatgpt-web --web-visible --select-codex-thread
```

常用选项：

```text
--workspace PATH       Workspace available to the DSH worker
--lane NAME            Independent persistent worker lane; default is main
--advisors LIST        codex, chatgpt-web, chatgpt-app, or a comma-separated combination
--resume               Resume the selected lane's interrupted job
--max-cycles N         Optional safety cap; omitted means unlimited turns
--web-visible          Store the worker Session in ~/.dsh for Web visibility
--codex-thread ID      Bind an existing Codex task
--select-codex-thread  Select a visible Codex task during first setup
--dsh-model MODEL      Override the worker model
--dsh-effort LEVEL     Override worker reasoning effort
```

## 并发与切换

多次打开快捷方式并选择不同 lane，即可运行多个 worker。每个 lane 的锁会拒绝误开的第二个相同进程。Codex 工作和普通 DSH 工作仍然并行。

ChatGPT 网页版和 Windows 应用是共享 UI 资源。worker 会为完整的截图、输入、等待和读取回复过程获取跨进程租约，结束后释放。其他 lane 在等待期间仍可继续非 UI 工作。进程异常退出后，锁文件包含其进程 id；下次获取会移除这一个失效锁。串行化可以避免 agent 向另一个 lane 的对话输入或读取内容。

顾问列表只作用于当前 job，并可在恢复时更换。启用多个顾问时，DSH 先使用一个 ChatGPT 传输，在不可用时切换到另一个；选择 Codex 后，它仍是监督者。默认不会把同一个问题发送到每条路线，因为这会消耗 token，却不一定增加独立证据。

## 记录与 token 使用

每份 DSH 报告都是持久的增量检查点，包含事实、决策、假设、风险、未决问题、证据、改动文件、测试和精简咨询摘要。ChatGPT UI 的准确调用和结果保留在原始 DSH Session 日志中，`events.jsonl` 则提供小型跨 agent 索引。摘要不足时，Codex 可以检查任一记录。

状态默认位于 `~/.codex-dsh-bridge/<workspace-id>-lane-<lane>/`；`main` lane 为兼容性保留原来的纯工作区路径。状态文件包含对话标识和路由历史，但不包含 API key。桥接器读取 `DEEPSEEK_API_KEY` 或现有 DSH 凭据引用，而且不会打印它。

worker 使用 `sdk-minimal`、`deepseek-v4-flash`、低推理强度、token 计量和自动压缩。只有选中的 UI provider 会被挂载，因此未使用的浏览器或桌面工具目录不会增加 token。桥接器在 agent 之间发送精简检查点增量，同时保留原始记录，而不会复制完整 transcript。默认没有轮次上限。

## 失败行为与安全性

启用 ChatGPT 的终态结果必须包含一条新的顾问审查记录；缺少时，协调器会让 worker 返回审查。如果 ChatGPT 无法解决问题且没有启用 Codex，lane 会停在 `waiting-user`；提供所需权限或环境后，重新运行同一 lane 即可恢复。崩溃会保留待执行指令，并要求在重复可能有副作用的操作之前先检查状态。

如果端口 3080 属于不含桥接路由的 Harness Web 进程，请关闭那个旧 Web 控制台一次，再重新启动。如果专用浏览器已打开但调试端点没有启动，请关闭该 profile 的浏览器窗口后重试。Windows 应用路线需要已打开的桌面会话，以及 Cua Driver 所需的主机权限。

`sdk-minimal` profile 通过 `danger-full-access` 提供持久 PowerShell。工作区不是操作系统级隔离边界。worker 会遵循适用的 `AGENTS.md` 或 `CLAUDE.md`，提示词也禁止批量删除和泄露凭据，但提示词不能替代 OS 隔离。Codex app-server 以只读方式运行；ChatGPT UI 操作受当前桌面账户权限限制。

## 许可证

本项目使用 [MIT License](LICENSE)。上游归属信息见 [NOTICE.md](NOTICE.md)；分享诊断信息前请阅读 [SECURITY.md](SECURITY.md)。
