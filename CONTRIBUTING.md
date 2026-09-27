# Contributing

Keep the bridge small and local to a DeepSeek Harness source checkout. Do not add telemetry, credential collection, automatic uploads, or committed runtime state.

Before opening a pull request, run:

```powershell
node --check .\bridge.mjs
node --check .\advisor-ui-lease-plugin.mjs
node --test .\bridge-state.test.mjs
```

Update `README.md` and `README.zh.md` together when behavior changes. Test every selected provider composition without including API keys or private Session data in fixtures or command output.
