# Security

The opt-in native workflow reads the current user's local Harness BrowserAuth credential in memory and only sends it to a configured loopback origin. Workflow configuration and delivery adapters are trusted local code: protect them like scripts with your user permissions. Reports, goal history, outbox records and logs may contain private project information; keep their state directories outside source control. A transport's acceptance is not a receiver or analysis acknowledgement. Do not clear real denials or blindly resend ambiguous side effects. The generic watcher does not patch official plugins, restart the desktop app or bypass quota/approval decisions.

## Reporting a vulnerability

Do not include credentials, private prompts, Session logs, browser profiles, or other sensitive data in a public issue. Report a vulnerability through GitHub's private security-advisory feature for this repository.

## Local sensitive data

The bridge reads an existing DeepSeek API key from the process environment or the DSH credential store. It does not write that key to bridge state or event logs. DSH Session logs and coordinator event logs can still contain prompts, file paths, command output, ChatGPT messages, and source excerpts from the work being performed.

The dedicated ChatGPT browser profile contains login cookies. It is stored under the user's home directory, outside this repository. Never copy that profile, `~/.dsh`, or `~/.codex-dsh-bridge` into a bug report or commit.

The Codex MCP installer records the local server path in Codex configuration and does not record ChatGPT or DeepSeek credentials. A consultation sends the selected question and context to ChatGPT through the dedicated signed-in Web profile and stores its trace in the DSH Session. The MCP does not read passwords, cookies, or unrelated ChatGPT conversations. Review the requested context before approving the tool call, and use a separate lane for each concurrent Codex conversation.

Codex `app` mode does not automate the unified desktop window that is running the caller. It uses the Web execution surface and labels that fact in its structured result; the cloud conversation is visible in the Windows app only when both surfaces use the same ChatGPT account and workspace. This avoids taking over the active Codex page or reading its accessibility tree.
