# Changelog

## 0.3.0 — 2026-10-23

- Add an opt-in native DSH Web workflow CLI for explicitly registered existing Sessions: verbatim instruction dispatch with revision CAS/readback, event-driven waits, owned-goal restart requests, and reviewed compaction of accepted history.
- Add durable immutable result publication, matching-goal completion-report recovery, separate receiver/analysis ACKs, race-safe late sender receipts and one optional bounded pending-analysis notice.
- Add a configurable local notification adapter interface with explicit probe, denial and uncertain-send states. No private Codex desktop pipe, identity or credential is distributed; without an adapter, publication remains local.
- Add a hidden Windows watcher launcher, compact inspection and parallel checks across registered workers. No model polling while waiting, bulk cleanup, automatic desktop restart or deployment to existing workers.
- Document whole-package delegation, mature tooling reuse, dsh-ops boundaries, shared compute ownership, restart practices and verification limits in English and Chinese.
- Make legacy bridge state replacement atomic and await persistence before continuing. Load the Harness SDK only when executing the bridge; support an explicit DSH_HARNESS_ROOT so offline tests do not require a built adjacent checkout.
- Update the MCP SDK to a fixed security release, retaining the existing consultation and stdio handshake tests.

Validation uses offline lifecycle/transport regressions and one real read-only native goals/get request. It does not establish end-to-end delivery or recovery for every Desktop/Harness installation. Deployment-specific senders and quota readers still need their own real round-trip check.
