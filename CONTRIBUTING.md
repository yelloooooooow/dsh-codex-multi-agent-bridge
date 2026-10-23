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

Native workflow changes must preserve complete pending instructions, native revision CAS, manual pauses and genuine provider/approval blocks. Receipt ACK is not analysis ACK. Add focused offline coverage for lifecycle or delivery changes; do not create paid model turns or interrupt live workers merely to test a coordinator. Tests retain fixtures under ignored `.test-output/` and must not bulk-delete directories. Run real-host checks against an explicitly selected idle fixture when needed; document the exact scope, and never publish credentials, private Session IDs, desktop pipes or research logs.
