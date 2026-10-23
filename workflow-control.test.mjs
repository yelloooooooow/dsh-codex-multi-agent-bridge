import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { artifactPath, atomicJson, readJson, safeId, withLock, WorkflowController } from './workflow-control.mjs'
import { createWebRpc, runAdapter } from './workflow.mjs'

// Fixtures intentionally remain under an ignored directory: no recursive cleanup.
function fixture() {
  const root = resolve('.test-output'); mkdirSync(root, { recursive: true })
  const workspace = mkdtempSync(resolve(root, 'workflow-'))
  const config = { workspace, stateDir: resolve(workspace, 'state'), workers: { one: { sessionId: 'session-one' } } }
  let goal = null, failEdit = false
  const calls = []
  const native = async (method, args) => {
    calls.push({ method, args: structuredClone(args) })
    if (method === 'goals/get') return structuredClone(goal)
    if (method === 'goals/create') {
      if (goal && goal.phase !== 'complete') throw new Error('Already has goal')
      goal = { id: 'goal-1', revision: (goal?.revision ?? 0) + 1, phase: 'active', activation: 'armed', roundsStarted: 0, objective: args.request.objective.trim() }
    } else {
      if (args.ref.id !== goal.id || args.ref.revision !== goal.revision) throw new Error('Revision conflict')
      if (failEdit) { failEdit = false; throw new Error('Connection lost during mutation') }
      goal.revision++
      if (method === 'goals/edit') goal.objective = args.request.objective.trim()
      else if (method === 'goals/pause') { goal.phase = 'paused'; goal.activation = 'disarmed' }
      else if (method === 'goals/resume') { goal.phase = 'active'; goal.activation = 'armed' }
    }
    return structuredClone(goal)
  }
  return { workspace, config, calls, controller: new WorkflowController(config, native), get goal() { return goal }, failNextEdit() { failEdit = true } }
}

test('full instructions append to the native goal, never to the chat prompt queue', async () => {
  const f = fixture(); await f.controller.dispatch('one', 'a', 'Keep every detail\nincluding line two')
  await f.controller.dispatch('one', 'b', 'Additional task')
  assert.match(f.goal.objective, /Keep every detail\nincluding line two/)
  assert.match(f.goal.objective, /Additional task/)
  assert(f.calls.every(c => c.method.startsWith('goals/')))
  assert(f.calls.filter(c => c.method !== 'goals/get').every(c => c.method === 'goals/create' || c.args.ref.revision))
})
test('the same instruction is idempotent, while changed content is rejected', async () => {
  const f = fixture(); await f.controller.dispatch('one', 'a', 'Task')
  const revision = f.goal.revision
  assert.equal((await f.controller.dispatch('one', 'a', 'Task')).deduplicated, true)
  assert.equal(f.goal.revision, revision)
  await assert.rejects(f.controller.dispatch('one', 'a', 'Changed'), /reused/)
})
test('unregistered Sessions and unsafe IDs never reach the native API', async () => {
  const f = fixture(); await assert.rejects(f.controller.dispatch('other', 'a', 'Task'), /not registered/)
  assert.throws(() => safeId('../escape'))
  assert.equal(f.calls.length, 0)
})
test('an uncertain mutation is retained and not blindly replayed', async () => {
  const f = fixture(); await f.controller.dispatch('one', 'a', 'Task'); f.failNextEdit()
  await assert.rejects(f.controller.dispatch('one', 'b', 'More'), /Connection lost/)
  const count = f.calls.filter(c => c.method === 'goals/edit').length
  assert.equal((await f.controller.dispatch('one', 'b', 'More')).status, 'UNCERTAIN')
  assert.equal(f.calls.filter(c => c.method === 'goals/edit').length, count)
})
test('restriction is saved and reported without automatically resuming', async () => {
  const f = fixture(); await f.controller.dispatch('one', 'a', 'Task')
  f.goal.phase = 'blocked'; f.goal.blockedReason = { code: 'quota_exceeded' }
  assert.equal((await f.controller.dispatch('one', 'b', 'Additional authorized task')).blocked, true)
  assert.equal(f.calls.some(c => c.method === 'goals/resume'), false)
})
test('an existing READY never makes the agent pause', async () => {
  const f = fixture(); await f.controller.dispatch('one', 'a', 'Task')
  writeFileSync(resolve(f.workspace, 'READY.json'), '{}')
  assert.equal((await f.controller.wait('one', 'job', { path: 'READY.json', kind: 'created' })).status, 'DEPENDENCY_ALREADY_READY')
  assert.equal(f.calls.some(c => c.method === 'goals/pause'), false)
})
test('saved-only instructions preserve an owned wait and cannot accidentally start a new goal', async () => {
  const f = fixture(); await assert.rejects(f.controller.dispatch('one', 'a', 'A', { resume: false }), /unfinished goal/)
  await f.controller.dispatch('one', 'a', 'A'); await f.controller.wait('one', 'job', { path: 'READY.json', kind: 'created' })
  await f.controller.dispatch('one', 'b', 'B', { resume: false })
  assert.equal((await f.controller.tick('one')).status, 'WAITING')
  writeFileSync(resolve(f.workspace, 'READY.json'), '{}')
  assert.equal((await f.controller.tick('one')).status, 'WAKE_REQUESTED')
})
test('a persisted wait survives controller restart and wakes once', async () => {
  const f = fixture(); await f.controller.dispatch('one', 'a', 'Task')
  await f.controller.wait('one', 'job', { path: 'READY.json', kind: 'created' })
  assert.equal((await f.controller.tick('one')).status, 'WAITING')
  writeFileSync(resolve(f.workspace, 'READY.json'), '{}')
  const resumed = new WorkflowController(f.config, async (...args) => {
    // Reuse the same host while the local controller is recreated.
    return f.controller.native(...args)
  })
  assert.equal((await resumed.tick('one')).status, 'WAKE_REQUESTED')
  assert.equal((await resumed.tick('one')).status, 'WORKING')
  assert.equal(f.calls.filter(c => c.method === 'goals/resume').length, 1)
  assert.match(f.goal.objective, /BRIDGE_EVENT_ID=/)
})
test('manual pause changes are not mistaken for the workflow-owned wait', async () => {
  const f = fixture(); await f.controller.dispatch('one', 'a', 'Task')
  await f.controller.wait('one', 'job', { path: 'READY.json', kind: 'created' })
  f.goal.revision++; writeFileSync(resolve(f.workspace, 'READY.json'), '{}')
  assert.equal((await f.controller.tick('one')).status, 'PAUSE_CHANGED')
  assert.equal(f.calls.some(c => c.method === 'goals/resume'), false)
})
test('an opted-in restart rearms only an owned active goal, once per unchanged revision', async () => {
  const f = fixture(); f.controller.autoResumeOwnedGoals = true
  await f.controller.dispatch('one', 'a', 'Task'); f.goal.activation = 'disarmed'
  assert.equal((await f.controller.tick('one')).status, 'RESUME_REQUESTED')
  f.goal.activation = 'disarmed'
  assert.equal((await f.controller.tick('one')).status, 'RESUME_NEEDS_ATTENTION')
  f.goal.phase = 'paused'; assert.equal((await f.controller.tick('one')).status, 'MANUAL_PAUSE')
})
test('terminal dependencies match run_id and ignore heartbeat-only updates', async () => {
  const f = fixture(); const file = resolve(f.workspace, 'run.json')
  const dependency = { path: 'run.json', kind: 'terminal', runId: 'current' }
  for (const row of [{ run_id: 'old', status: 'COMPLETE' }, { run_id: 'current', status: 'RUNNING', heartbeat: 5 }]) {
    writeFileSync(file, JSON.stringify(row)); assert.equal(f.controller.dependencyReady(dependency), false)
  }
  writeFileSync(file, JSON.stringify({ run_id: 'current', status: 'FAILED' }))
  assert.equal(f.controller.dependencyReady(dependency), true)
})
test('completed or replaced goals are never revived by a late watcher', async () => {
  const f = fixture(); await f.controller.dispatch('one', 'a', 'Task')
  f.goal.phase = 'complete'; assert.equal((await f.controller.tick('one')).status, 'COMPLETE')
  f.goal.id = 'new-goal'; assert.equal((await f.controller.tick('one')).status, 'GOAL_CHANGED')
})
test('compaction needs accepted work and preserves every remaining instruction verbatim', async () => {
  const f = fixture(); await f.controller.dispatch('one', 'a', 'Finished task'); await f.controller.dispatch('one', 'b', 'Pending exact text')
  await f.controller.wait('one', 'job', { path: 'READY.json', kind: 'created' })
  writeFileSync(resolve(f.workspace, 'review.md'), 'Accepted a')
  const plan = { goalId: f.goal.id, revision: f.goal.revision, objective: '[BRIDGE_INSTRUCTION_ID=b]\nPending exact text', acceptedCompleted: [{ instructionId: 'a', reviewPath: 'review.md' }], pendingInstructions: ['b'] }
  assert.equal((await f.controller.compact('one', plan)).status, 'COMPACTED')
  assert.equal(f.goal.objective, plan.objective)
  assert(existsSync(resolve(f.config.stateDir, 'history/one', `${plan.goalId}-${plan.revision}.json`)))
})
test('compaction rejects silently omitted registered requirements', async () => {
  const f = fixture(); await f.controller.dispatch('one', 'a', 'A'); await f.controller.dispatch('one', 'b', 'B'); await f.controller.dispatch('one', 'c', 'C')
  await f.controller.wait('one', 'job', { path: 'READY.json', kind: 'created' }); writeFileSync(resolve(f.workspace, 'review.md'), 'Accepted a')
  await assert.rejects(f.controller.compact('one', { goalId: f.goal.id, revision: f.goal.revision, objective: '[BRIDGE_INSTRUCTION_ID=b]\nB', acceptedCompleted: [{ instructionId: 'a', reviewPath: 'review.md' }], pendingInstructions: ['b'] }), /missing/)
})
test('invalid completed-instruction references are rejected before changing the goal', async () => {
  const f = fixture(); await f.controller.dispatch('one', 'a', 'A'); await f.controller.wait('one', 'job', { path: 'READY.json', kind: 'created' }); writeFileSync(resolve(f.workspace, 'review.md'), 'Review')
  const revision = f.goal.revision
  await assert.rejects(f.controller.compact('one', { goalId: f.goal.id, revision, objective: '[BRIDGE_INSTRUCTION_ID=a]\nA', acceptedCompleted: [{ instructionId: 'unknown', reviewPath: 'review.md' }], pendingInstructions: ['a'] }), /another goal/)
  assert.equal(f.goal.revision, revision)
})
test('accepted history does not have to accumulate in subsequent compact goals', async () => {
  const f = fixture(); await f.controller.dispatch('one', 'a', 'A'); await f.controller.dispatch('one', 'b', 'B')
  await f.controller.wait('one', 'job', { path: 'READY.json', kind: 'created' }); writeFileSync(resolve(f.workspace, 'review.md'), 'Accepted')
  await f.controller.compact('one', { goalId: f.goal.id, revision: f.goal.revision, objective: '[BRIDGE_INSTRUCTION_ID=b]\nB', acceptedCompleted: [{ instructionId: 'a', reviewPath: 'review.md' }], pendingInstructions: ['b'] })
  await f.controller.dispatch('one', 'c', 'C')
  await f.controller.wait('one', 'job', { path: 'OTHER_READY.json', kind: 'created' })
  assert.equal((await f.controller.compact('one', { goalId: f.goal.id, revision: f.goal.revision, objective: '[BRIDGE_INSTRUCTION_ID=c]\nC', acceptedCompleted: [{ instructionId: 'b', reviewPath: 'review.md' }], pendingInstructions: ['c'] })).status, 'COMPACTED')
})
test('publishing validates ownership and persists an immutable event offline', async () => {
  const f = fixture(); const path = resolve(f.workspace, 'report.json')
  const report = { job_id: 'job', session_id: 'session-one', event: 'done-v1', summary: 'Complete' }
  writeFileSync(path, JSON.stringify(report))
  const result = await f.controller.publish('one', 'job', 'done-v1', 'report.json')
  assert.equal(result.status, 'QUEUED'); assert.equal((await f.controller.publish('one', 'job', 'done-v1', 'report.json')).deduplicated, true)
  writeFileSync(path, JSON.stringify({ ...report, summary: 'Changed' }))
  await assert.rejects(f.controller.publish('one', 'job', 'done-v1', 'report.json'), /new version/)
})
async function published() {
  const f = fixture(); writeFileSync(resolve(f.workspace, 'report.json'), JSON.stringify({ job_id: 'job', session_id: 'session-one', event: 'done-v1', summary: 'Complete' }))
  const { deliveryId } = await f.controller.publish('one', 'job', 'done-v1', 'report.json'); return { ...f, deliveryId }
}
test('transport acceptance is not result analysis and is not replayed', async () => {
  const f = await published(); let sends = 0
  const send = async () => { sends++; return { status: 'ACCEPTED' } }
  const first = await f.controller.deliver(f.deliveryId, send)
  assert.equal(first.analysisStatus, 'PENDING')
  await f.controller.deliver(f.deliveryId, send); assert.equal(sends, 1)
})
test('a timeout after possible dispatch stays uncertain across restart', async () => {
  const f = await published(); let sends = 0
  const send = async () => { sends++; throw new Error('Timeout') }
  assert.equal((await f.controller.deliver(f.deliveryId, send)).transportStatus, 'UNCERTAIN')
  await f.controller.deliver(f.deliveryId, send); assert.equal(sends, 1)
  assert.equal((await f.controller.acknowledge(f.deliveryId)).transportStatus, 'RECEIVED')
})
test('receiver and analysis ACK outrank a delayed uncertain sender receipt', async () => {
  const f = await published(); let finishSend, entered
  const started = new Promise(done => { entered = done })
  const sending = f.controller.deliver(f.deliveryId, async () => { entered(); return new Promise(done => { finishSend = done }) })
  await started
  writeFileSync(resolve(f.workspace, 'review.md'), 'Independently analyzed')
  await f.controller.acknowledge(f.deliveryId, { analyzed: true, reviewPath: 'review.md', nextAction: 'Continue' })
  finishSend({ status: 'UNCERTAIN' })
  const result = await sending
  assert.equal(result.transportStatus, 'RECEIVED'); assert.equal(result.analysisStatus, 'ANALYZED')
})
test('finished owner reports are recovered without waking an extra model', async () => {
  const f = fixture(); await f.controller.dispatch('one', 'a', 'Task'); f.goal.phase = 'complete'
  f.config.workers.one.report = { jobId: 'job', event: 'done-v1', path: 'report.json' }
  assert.equal((await f.controller.tick('one')).status, 'REPORT_MISSING')
  writeFileSync(resolve(f.workspace, 'report.json'), JSON.stringify({ job_id: 'job', event: 'done-v1', session_id: 'session-one', goal_id: f.goal.id }))
  const recovered = await f.controller.tick('one')
  assert.equal(recovered.status, 'COMPLETE'); assert(recovered.deliveryId)
  assert(f.calls.every(c => c.method.startsWith('goals/')))
})
test('receiver ACK and analysis ACK stay separate and require an actual review', async () => {
  const f = await published()
  assert.equal((await f.controller.acknowledge(f.deliveryId)).analysisStatus, 'PENDING')
  await assert.rejects(f.controller.acknowledge(f.deliveryId, { analyzed: true }), /reviewPath/)
  writeFileSync(resolve(f.workspace, 'review.md'), 'Analyzed; use the existing next package')
  assert.equal((await f.controller.acknowledge(f.deliveryId, { analyzed: true, reviewPath: 'review.md', nextAction: 'Continue next package' })).analysisStatus, 'ANALYZED')
  assert.equal((await f.controller.acknowledge(f.deliveryId)).analysisStatus, 'ANALYZED')
})
test('an accepted pending result gets one separate notice, never a replay of its original payload', async () => {
  const f = await published(); await f.controller.deliver(f.deliveryId, async () => ({ status: 'ACCEPTED' }))
  let sends = 0
  const now = Date.now() + 20000
  const send = async packet => { sends++; assert.equal(packet.kind, 'ANALYSIS_NOTICE'); assert.equal(packet.originalDeliveryId, f.deliveryId); return { status: 'UNCERTAIN' } }
  assert.equal((await f.controller.remind(f.deliveryId, send, { now, graceMs: 1000 })).noticeOnly, true)
  await f.controller.remind(f.deliveryId, send, { now, graceMs: 1000 }); assert.equal(sends, 1)
  const saved = readJson(resolve(f.config.stateDir, 'outbox', `${f.deliveryId}.json`))
  assert.equal(saved.transportStatus, 'ACCEPTED'); assert.equal(saved.analysisStatus, 'PENDING')
})
test('queued quota-outage time is not counted as time given to analyze a delivered result', async () => {
  const f = await published(); let called = false
  assert.equal((await f.controller.remind(f.deliveryId, async () => { called = true }, { now: Date.now() + 9000000, graceMs: 1000 })).status, 'NO_NOTICE_NEEDED')
  assert.equal(called, false)
})
test('confirmed pre-send failure can retry, explicit denial cannot', async () => {
  const f = await published(); await f.controller.deliver(f.deliveryId, async () => ({ status: 'NOT_SENT' }))
  assert.equal((await f.controller.deliver(f.deliveryId, async () => ({ status: 'DENIED' }))).transportStatus, 'DENIED')
  let called = false; await f.controller.deliver(f.deliveryId, async () => { called = true }); assert.equal(called, false)
})
test('artifact paths cannot escape the workspace', () => {
  const f = fixture(); assert.throws(() => artifactPath(f.workspace, '../outside.json'), /escapes/)
})
test('concurrent local operations do not overwrite a live owner lock', async () => {
  const f = fixture(), path = resolve(f.config.stateDir, 'test.lock'); let release
  const first = withLock(path, () => new Promise(done => { release = done }))
  await assert.rejects(withLock(path, async () => {}), /already running/)
  release(); await first; assert.equal(existsSync(path), false)
})
test('atomic state is complete JSON and has no shared temporary filename', async () => {
  const f = fixture(), path = resolve(f.config.stateDir, 'atomic.json')
  await atomicJson(path, { a: 1 }); assert.deepEqual(readJson(path), { a: 1 })
  writeFileSync(resolve(f.workspace, 'bad.json'), '{bad')
  assert.throws(() => readJson(resolve(f.workspace, 'bad.json')), SyntaxError)
})
test('Web authentication refuses remote credential destinations before any network call', () => {
  assert.throws(() => createWebRpc({ baseUrl: 'https://remote.example' }), /loopback/)
  assert.throws(() => createWebRpc({ baseUrl: 'http://secret@127.0.0.1:3080' }), /loopback/)
})
test('transport adapter uses argv and bounded JSON, without a shell', async () => {
  const adapter = { command: [process.execPath, '-e', 'let x=""; process.stdin.on("data",c=>x+=c); process.stdin.on("end",()=>console.log(JSON.stringify({status:"ACCEPTED",operation:JSON.parse(x).operation})))'], timeoutMs: 5000 }
  assert.equal((await runAdapter(adapter, { operation: 'send' })).operation, 'send')
  await assert.rejects(runAdapter({ command: [process.execPath, '-e', 'console.log("bad")'], timeoutMs: 5000 }, {}), /invalid JSON/)
})
