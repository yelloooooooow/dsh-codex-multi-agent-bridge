# Recommended workflow: whole-package ownership, native goals, event-driven recovery

Use one lead to define the objective, budget and acceptance conditions. Each worker owns implementation, routine repair, execution, monitoring and collection for one complete package. The lead reads the actual artifacts, analyzes the result and assigns the next package. Model choice is deployment-specific; this design does not assume that using a cheaper executor always saves tokens.

## Responsibilities

```text
Lead instruction → complete native goal → autonomous worker → controller / optional ops backend
                                             ↑                         ↓
                                      event-driven wake ← artifact/run watcher
Worker result → durable outbox → receipt ACK → independent analysis + next disposition → analysis ACK
```

A goal stores unfinished instructions. A checkpoint stores current job/run IDs, outputs and unresolved decisions. A controller owns compute and resources. A watcher checks explicit events without model polling. Delivery state records whether a notification was sent or received; analysis state records whether someone actually reviewed the result. None of these states is a substitute for scientific or technical acceptance.

The DSH goal service stores objectives; the goal-round-driver admits subsequent rounds. A saved goal or successful resume request is not evidence that a new round started. Inspect id, revision, phase, activation and roundsStarted, plus actual process receipts.

## Whole-package delegation

Provide the complete objective, inputs, output locations, budget, editable scope, reused artifacts, acceptance conditions, waiting dependencies and escalation conditions once. Workers save ordinary progress to the checkpoint and repair reversible path, shell, executor and environment failures through already authorized supported routes. They immediately escalate material contradictions, earlier invalid results, changes to method or budget, new authority requirements, or concrete blockers that remain after targeted repair. Real quota and approval refusals must not be bypassed.

Append new instructions directly to the native goal with stable instruction IDs, revision CAS and readback. A queued chat message is not a persisted goal edit. Preserve unfinished text verbatim. Reusing an ID with changed content is rejected; an uncertain timed-out mutation is not blindly replayed.

Suggested instruction:

> Store these complete instructions in the native goal and use a multistep task until the package is finished. Preserve all unfinished requirements when adding instructions. Own routine authorized repairs; report material errors or blockers immediately. Save ordinary progress in the checkpoint. When no independent work remains and a compute result is required, register the exact event and sleep without model polling. Persist the report and notification before finishing. Keep the result pending analysis until the lead has reviewed artifacts and recorded the next disposition.

## Opt-in native workflow CLI

The existing `bridge.mjs` adviser loop remains available. `workflow.mjs` manages explicitly registered, existing DSH Web Sessions. Do not run both coordinators against the same Session. Copy `examples/workflow.config.json` to an ignored `workflow.local.json`, then set the actual workspace, state directory and Session bindings. Relative paths are resolved from the configuration file's directory.

```powershell
node workflow.mjs dispatch --config workflow.local.json --worker worker-1 --id package-001 --file task.md
node workflow.mjs inspect --config workflow.local.json
node workflow.mjs wait --config workflow.local.json --worker worker-1 --job package-001 --file results/READY.json --kind created
node workflow.mjs watch --config workflow.local.json --interval-ms 30000
```

`inspect` is compact by default; add `--full` only when you need the entire goal. Web RPC uses the existing user's BrowserAuth credential in memory and accepts loopback origins only. No credential is copied into configuration or logs. The adapter was verified with a read-only call against the installed host; DSH's API and authentication remain version-specific, so validate upgrades with inspection rather than guessing payloads or disabling authentication.

An already-present READY file does not cause a pause. For mutable run-state files, use `--kind terminal --run-id <actual_run_id>`: only matching COMPLETE/FAILED/CANCELLED states wake the worker, not heartbeats or another run's completion. A failed run needs handling, not acceptance. Workspace escapes, including symlinks, are rejected.

`start-workflow-watcher.ps1 -Config ./workflow.local.json` starts a hidden Windows process and reports its PID, creation time and log paths. One watcher owns each state directory, checks different workers concurrently and prints only changed states. It does not start simulations, kill compute processes or spend model tokens while nothing actionable changes.

With explicit `autoResumeOwnedGoals=true`, an owned active/disarmed goal gets one recovery attempt per unchanged revision. Manual pauses, changed goals and genuine blocked states are preserved. Resume is a request; subsequent progress still needs observation.

## Publish, receive, analyze

Write a durable report with `job_id`, `session_id`, `goal_id`, `event`, and `summary`, keeping full evidence in the workspace:

```powershell
node workflow.mjs publish --config workflow.local.json --worker worker-1 --job package-001 --event complete_v1 --file reports/complete_v1.json
node workflow.mjs ack --config workflow.local.json --id <deliveryId>
node workflow.mjs ack --config workflow.local.json --id <deliveryId> --analyzed --review reviews/result.md --next "Continue the defined next package"
```

Publication persists an outbox record even when the bridge is offline. Event metadata is immutable: corrections use a new event version. Optionally declare `report: {"jobId":"package-001","event":"complete_v1","path":"reports/complete_v1.json"}` on a worker. After its goal completes, the watcher registers a matching goal/session report if the worker forgot publication. A missing report produces REPORT_MISSING; it does not fabricate a result or revive a completed goal.

ACCEPTED means the transport admitted a notification; RECEIVED means the receiver acknowledged it. Both leave analysis PENDING. Only an explicit analysis ACK with an existing review file and next disposition marks ANALYZED. A delayed sender receipt cannot overwrite a stronger receiver/analysis ACK. An uncertain send stays UNCERTAIN/SENDING rather than being replayed on a timer. Only confirmed NOT_SENT may retry automatically; DENIED remains blocked.

## Connect an authorized Codex delivery adapter

This release does not embed private desktop pipes, identities, installations or a copy of an official plugin. Configure a trusted local adapter:

```json
{
  "deliveryAdapter": {"command": ["node", "C:/local/codex-delivery-adapter.mjs"], "timeoutMs": 30000},
  "analysisNoticeAfterMs": 900000
}
```

The adapter reads one JSON packet from stdin. For `operation=probe`, return `{"allowed":true}` only after availability and any applicable official quota/approval checks; otherwise return `{"allowed":false,"reason":"..."}`. For `operation=send`, consume deliveryId, jobId, event, reportPath and a bounded summary. Return one of ACCEPTED, RECEIVED, NOT_SENT, DENIED or UNCERTAIN. NOT_SENT requires evidence that sending never happened; a timeout after possible dispatch is UNCERTAIN. Never claim that a result was analyzed.

Commands run as argv with shell=false and windowsHide=true. Timeouts terminate only the adapter child. Without an adapter, native goal control and durable publication work, but notifications are **not automatically delivered to Codex**. A deployment can connect its existing verified native sender and quota keeper; validate a real round trip before relying on unattended delivery.

Optional pending-analysis reminders are one separate ANALYSIS_NOTICE referencing the saved result, never a replay of the task. Analysis suppresses reminders and preserves the original receipt. Time spent queued during quota unavailability is not counted as analysis time. Uncertain reminder delivery is recorded without a repeated-send loop. This does not promise recovery from every desktop hang or host restart.

## Compact accepted history without losing requirements

At an owned WAITING/paused boundary, use `compact --file plan.json` with exact goalId/revision, replacement objective, `acceptedCompleted:[{"instructionId":"...","reviewPath":"reviews/accepted.md"}]`, and `pendingInstructions:["..."]`. Every registered instruction must be accepted or pending. Pending marker+text stays verbatim. The previous goal and review references are archived; CAS and readback reject concurrent edits rather than overwriting them.

## Ops, parallel work and recovery

Use dsh-ops for bounded reads, programmatic summaries, script files and optional process hosting. The reviewed installed version 0.3.0 did not make background readout an active model wakeup; its connection-owned job map and temporary result references were not durable project records. These observations are version-specific. Retain native goals, events and durable artifacts when adopting ops; never keep the sole result in a short-lived reference.

Assign independent responsibilities and disjoint output paths to workers. A shared controller can allocate currently free CPU cores, GPU memory and RAM across jobs; worker count is not a hard core quota. Avoid nested BLAS oversubscription and duplicated runs. Reuse accepted datasets, models and checks. Preflight only concrete new risks; do not repeatedly hash full archives or recompute successful jobs. Persist trained weights and predictions before reporting, so postprocessing failures can resume without retraining.

After compaction, quota recovery or restart, read the current goal, one checkpoint, pending results and real process receipts before launching work. Check run ID, PID, creation time and command line; a failed SSH read does not establish compute failure. Ordinary executor errors differ from genuine permission refusal.

Provider capacity errors, usage limits, absent active turns and a stale desktop thinking indicator are distinct. Official turn steering requires an active turn; do not replay a full task when a different recovery/start operation is needed. An observed official-plugin/desktop mismatch rejected even read-only requests; check discovery, read-only calls and the app-matched plugin rather than spoofing identities or patching official code. This generic release does not automatically restart the desktop application, which could interrupt unrelated chats.

## Verification and limitations

Offline tests cover instruction preservation/CAS, waiting and restart recovery, manual pauses, run identity, report recovery, immutable events, sender/ACK races, uncertain delivery and omitted compaction requirements. Existing consultation and MCP handshake tests remain. A real read-only DSH `goals/get` call succeeded. No new live model/worker was created for an end-to-end experiment and no running research watcher/keeper was replaced. Before deployment, verify a short real goal→wait→wake and report→receipt→analysis flow, including host interruption and process restart.

Codex protocol reference: [official App Server documentation](https://learn.chatgpt.com/docs/app-server). DSH goals use a different host interface; do not substitute Codex goal/turn methods. Distinguish implemented code, offline tests, real read-only checks, real round-trip evidence and unverified behavior in reports.
