# Contributing

Keep the bridge small and local to a DeepSeek Harness source checkout. Do not add telemetry, credential collection, automatic uploads, or committed runtime state.

Before opening a pull request, run:

```powershell
npm install --ignore-scripts
npm run check
npm test
npm audit --audit-level=high
```

Update `README.md` and `README.zh.md` together when behavior changes. Test every selected provider composition without including API keys or private Session data in fixtures or command output. Codex-originated `app` requests must remain explicit Web delivery with app synchronization; do not add synchronous automation of the unified desktop window because that window hosts the active Codex caller.
