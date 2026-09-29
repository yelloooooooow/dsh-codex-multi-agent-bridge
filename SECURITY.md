# Security

## Reporting a vulnerability

Do not include credentials, private prompts, Session logs, browser profiles, or other sensitive data in a public issue. Report a vulnerability through GitHub's private security-advisory feature for this repository.

## Local sensitive data

The bridge reads an existing DeepSeek API key from the process environment or the DSH credential store. It does not write that key to bridge state or event logs. DSH Session logs and coordinator event logs can still contain prompts, file paths, command output, ChatGPT messages, and source excerpts from the work being performed.

The dedicated ChatGPT browser profile contains login cookies. It is stored under the user's home directory, outside this repository. Never copy that profile, `~/.dsh`, or `~/.codex-dsh-bridge` into a bug report or commit.

The Codex MCP installer records the local server path in Codex configuration and does not record ChatGPT or DeepSeek credentials. A consultation sends the selected question and context to ChatGPT through the dedicated signed-in Web profile and stores its trace in the DSH Session. The MCP does not read passwords, cookies, or unrelated ChatGPT conversations. Review the requested context before approving the tool call, and use a separate lane for each concurrent Codex conversation.

Codex `app` mode does not automate the unified desktop window that is running the caller. It uses the Web execution surface and labels that fact in its structured result; the cloud conversation is visible in the Windows app only when both surfaces use the same ChatGPT account and workspace. This avoids taking over the active Codex page or reading its accessibility tree.
