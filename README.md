# DSH Codex Multi-Agent Bridge

English | [中文](README.zh.md)

The bridge keeps persistent DeepSeek Harness workers connected to any combination of Codex, ChatGPT Web, and the ChatGPT Windows app. A named lane owns one DSH Session, one saved Codex thread when enabled, and one named ChatGPT conversation. Reusing the lane preserves its memory; using another lane starts an independent worker that can run concurrently.

This is an experimental, independent companion project for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), not an official DeepSeek release. It targets Windows and loads packages from an adjacent built Harness source checkout.

## Install

Install Node.js 24 or 22.19+, clone and build DeepSeek Harness, and configure its DeepSeek credential before using this project. Codex mode also requires an authenticated `codex` CLI. ChatGPT modes require a signed-in ChatGPT Web session or Windows app.

Clone this repository as a direct child of the Harness checkout so its parent directory contains `apps/`, `packages/`, and the built `apps/cli/lib/bin.js`:

```powershell
cd C:\work\deepseek-harness
git clone https://github.com/yelloooooooow/dsh-codex-multi-agent-bridge.git
cd .\dsh-codex-multi-agent-bridge
npm install --ignore-scripts
```

The bridge does not install or copy credentials. Runtime state, Session logs, control tokens, and the browser profile stay under the current Windows user's home directory and are excluded by this repository's `.gitignore`. Those local records can contain prompts, source excerpts, command output, file paths, and ChatGPT messages; do not attach them to public issues without review.

## Start and resume

Double-click `Start Unified DSH Bridge.cmd`; the older `Start Codex-DSH Bridge.cmd` name remains an equivalent shortcut. The launcher starts or reuses the bridge-enabled DSH Web server, asks for a lane, accepts one or more adviser numbers, and then asks for the task. Leave the task empty to resume an interrupted job in that lane.

Choose `1,2,3` or `all` to enable every route. A later launch may change the adviser combination without replacing the lane's DSH Session. If Codex is enabled for the first time, select an existing visible Codex task or enter `NEW`. External app-server writes appear after the Codex page is reopened because an already open page does not subscribe to that separate process's live event stream.

ChatGPT Web uses a dedicated Edge or Chrome profile at `~/.codex-dsh-bridge/chatgpt-browser-profile`. Sign in once in that window. Web and app routes continue the lane's conversation named `桥接对话 · <workspace> · <lane>` instead of opening one conversation per consultation.

The launcher stores each DSH Session in the workspace's DSH Web group with the title `桥接对话 · <lane>`. The local Web patch does not modify the whale widget. Treat an active bridge Session as read-only in DSH Web so manual messages do not race the coordinator.

## Codex to ChatGPT

Codex Desktop includes [Computer Use for its built-in browser](https://learn.chatgpt.com/docs/browser#computer-use-in-the-browser), but that browser capability alone does not provide a persistent ChatGPT adviser conversation with lane isolation, reply capture, and audit records. This project exposes that complete local loop as the `consult_chatgpt` MCP tool.

Double-click `Install Codex ChatGPT Bridge.cmd`, then start a new Codex conversation or restart Codex. The installer keeps credentials out of Codex configuration: it installs dependencies and registers only the absolute path of `codex-chatgpt-mcp.mjs` under the local MCP name `dsh_chatgpt_advisor`.

Ask Codex to consult ChatGPT when another judgment is useful. The tool accepts `web`, `app`, and `auto`. All three use an isolated signed-in Web surface for execution; `app` records that the intended presentation surface is the Windows app. This is deliberate: the [current unified desktop app](https://help.openai.com/en/articles/20001276-moving-to-the-new-chatgpt-desktop-app) hosts ChatGPT and the active Codex turn in one main window, so synchronous app automation would replace the page that is invoking the tool. When Web and the app use the same account and workspace, the persistent cloud conversation appears in the Windows app's Recents with its complete transcript.

Each Codex conversation must reuse one short lane name, while concurrent Codex conversations use different lanes. The bridge prefixes these lanes with `codex-`, continues the corresponding named ChatGPT conversation, and uses the same cross-process UI leases as DSH-originated consultations. The result reports the requested transport and the actual delivery surface, so `app` is never presented as direct desktop UI automation.

Codex sends one focused question and optional compact context. A low-effort DSH relay operates the Web UI, waits for the complete response, stores the full tool trace in its DSH Session, and returns a compact answer plus the conversation and Session identifiers to Codex. This adds one DSH relay turn to each consultation; Codex does not copy the complete prior transcript into ChatGPT. DSH-originated `chatgpt-app` jobs remain available through the unified launcher because they do not synchronously replace their own Codex caller.

Command-line use remains available:

```powershell
node ".\dsh-codex-multi-agent-bridge\bridge.mjs" --task "Inspect the project and report evidence." --lane review-1 --advisors codex,chatgpt-web --web-visible --select-codex-thread
```

Useful options:

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

## Concurrency and switching

Launch the shortcut more than once and choose different lane names to run multiple workers. A per-lane lock rejects an accidental second process for the same lane. Codex work and ordinary DSH work remain parallel.

ChatGPT Web and the Windows app are shared UI resources. The worker acquires a cross-process lease for the complete snapshot, input, wait, and reply-read sequence, then releases it. Other lanes continue non-UI work while they wait. A dead process leaves a lock containing its process id; the next acquisition removes that one stale lock. This serialization prevents agents from typing into or reading another lane's conversation.

The adviser list is job-local and may change on resume. When several advisers are enabled, DSH uses one ChatGPT transport and switches to another if it is unavailable; Codex remains the supervisor when selected. Repeating the same question through every route is not the default because it spends tokens without adding independent evidence.

## Records and token use

Every DSH report is a durable incremental checkpoint with facts, decisions, assumptions, risks, open questions, evidence, changed files, tests, and compact consultation summaries. Exact ChatGPT UI calls and results remain in the raw DSH Session log, while `events.jsonl` provides a small cross-agent index. Codex can inspect either record when a summary is insufficient.

State defaults to `~/.codex-dsh-bridge/<workspace-id>-lane-<lane>/`; the `main` lane retains the original workspace-only path for compatibility. State files contain conversation identifiers and routing history but no API keys. The bridge reads `DEEPSEEK_API_KEY` or the existing DSH credential reference without printing it.

The worker uses `sdk-minimal`, `deepseek-v4-flash`, low reasoning, token metering, and automatic compaction. Only selected UI providers are mounted, so an unused browser or desktop tool catalog adds no tokens. The bridge sends compact checkpoint deltas between agents and keeps the raw record available instead of copying the full transcript. There is no default turn limit for normal bridge jobs; each Codex MCP call is one bounded adviser request with a configurable timeout.

## Failure behavior and safety

A ChatGPT-enabled terminal result must contain a fresh adviser-review record. Without one, the coordinator sends the worker back for review. If ChatGPT cannot resolve an issue and Codex is not enabled, the lane stops in `waiting-user`; rerun the same lane after supplying the needed authority or environment. A crash preserves the pending instruction and requires state inspection before a possibly side-effecting action is repeated.

If port 3080 belongs to a Harness Web process without the bridge route, close that older Web console once and restart the launcher. If the dedicated browser opens without a debugging endpoint, close that browser profile's windows and retry. The Windows app route requires an open desktop session and the host permissions required by Cua Driver.

The `sdk-minimal` profile exposes persistent PowerShell with `danger-full-access`. The workspace is not an operating-system confinement boundary. The worker follows applicable `AGENTS.md` or `CLAUDE.md` instructions and is told not to bulk-delete or reveal credentials, but prompts do not replace OS isolation. Codex app-server runs read-only; ChatGPT UI actions are limited by the active desktop account.

## License

This project is available under the [MIT License](LICENSE). See [NOTICE.md](NOTICE.md) for upstream attribution and [SECURITY.md](SECURITY.md) before sharing diagnostics.
