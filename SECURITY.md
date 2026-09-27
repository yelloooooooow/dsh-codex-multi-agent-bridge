# Security

## Reporting a vulnerability

Do not include credentials, private prompts, Session logs, browser profiles, or other sensitive data in a public issue. Report a vulnerability through GitHub's private security-advisory feature for this repository.

## Local sensitive data

The bridge reads an existing DeepSeek API key from the process environment or the DSH credential store. It does not write that key to bridge state or event logs. DSH Session logs and coordinator event logs can still contain prompts, file paths, command output, ChatGPT messages, and source excerpts from the work being performed.

The dedicated ChatGPT browser profile contains login cookies. It is stored under the user's home directory, outside this repository. Never copy that profile, `~/.dsh`, or `~/.codex-dsh-bridge` into a bug report or commit.
