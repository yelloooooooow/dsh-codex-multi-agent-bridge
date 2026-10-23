/** Durable whole-package dispatch, native goal waiting, and result acknowledgement. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Validate an identifier before using it as a filename or native marker. */
export function safeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value)) throw new Error('Invalid identifier')
  return value
}

/** Replace a JSON record atomically; failed Windows replacements retain the temp file. */
export async function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temp, 'wx', 0o600)
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
  for (let attempt = 0; ; attempt++) {
    try { renameSync(temp, path); return } catch (error) {
      if (!['EACCES', 'EPERM', 'EBUSY'].includes(error.code) || attempt >= 4) throw error
      await new Promise(done => setTimeout(done, 20 * (attempt + 1)))
    }
  }
}

/** Read a persisted record; malformed records fail visibly rather than looking absent. */
export function readJson(path, fallback = undefined) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) : fallback
}

/** Resolve an existing workspace artifact, rejecting lexical and symlink escapes. */
export function artifactPath(workspace, path) {
  const root = realpathSync(workspace)
  const target = resolve(root, path)
  const inside = candidate => { const rel = relative(root, candidate); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) }
  if (!inside(target)) throw new Error('Artifact escapes workspace')
  let parent = target
  while (!existsSync(parent)) {
    const next = dirname(parent)
    if (next === parent) throw new Error('Cannot resolve artifact parent')
    parent = next
  }
  if (!inside(realpathSync(parent))) throw new Error('Artifact symlink escapes workspace')
  return target
}

/** Serialize a whole read/modify/write operation; only a provably dead owner's lock is removed. */
export async function withLock(path, action) {
  mkdirSync(dirname(path), { recursive: true })
  const owner = randomUUID()
  let acquired = false
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      try { writeFileSync(fd, JSON.stringify({ owner, pid: process.pid })) } finally { closeSync(fd) }
      acquired = true
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const observed = readFileSync(path, 'utf8')
      const old = JSON.parse(observed)
      if (!Number.isSafeInteger(old.pid) || old.pid < 1) throw new Error('Invalid lock owner; inspect manually')
      try { process.kill(old.pid, 0); throw new Error('Workflow operation already running') } catch (probe) {
        if (probe.code !== 'ESRCH') throw probe
      }
      if (readFileSync(path, 'utf8') === observed) unlinkSync(path)
    }
  }
  if (!acquired) throw new Error('Workflow lock busy')
  try { return await action() } finally {
    if (readJson(path)?.owner === owner) unlinkSync(path)
  }
}

const restricted = goal => /quota|approval|permission|budget|usage.limit/i.test(JSON.stringify(goal?.blockedReason ?? ''))
const marker = id => `[BRIDGE_INSTRUCTION_ID=${safeId(id)}]`
const digest = text => createHash('sha256').update(text).digest('hex')

/** Manage only explicitly registered worker Sessions through an injected native RPC adapter. */
export class WorkflowController {
  constructor({ workspace, stateDir, workers, autoResumeOwnedGoals = false }, native) {
    this.workspace = realpathSync(workspace)
    this.root = resolve(stateDir)
    this.workers = workers
    this.autoResumeOwnedGoals = autoResumeOwnedGoals
    if (!workers || !Object.keys(workers).length) throw new Error('Register at least one worker')
    for (const [name, row] of Object.entries(workers)) { safeId(name); if (typeof row.sessionId !== 'string' || !row.sessionId) throw new Error('Worker needs sessionId') }
    this.native = native
  }

  worker(name) {
    safeId(name)
    const row = this.workers[name]
    if (!row) throw new Error('Worker is not registered')
    return row
  }

  path(...parts) { return resolve(this.root, ...parts) }
  goal(worker) { return this.native('goals/get', { agentId: this.worker(worker).sessionId }) }
  change(worker, goal, action, request) {
    return this.native(`goals/${action}`, { agentId: this.worker(worker).sessionId, ref: { id: goal.id, revision: goal.revision }, ...(request ? { request } : {}) })
  }
  locked(worker, action) { this.worker(worker); return withLock(this.path('locks', `${worker}.lock`), action) }

  /** Save instructions verbatim in a native goal, preserving every unfinished instruction. */
  async dispatch(worker, instructionId, text, { resume = true } = {}) {
    safeId(instructionId)
    if (typeof text !== 'string' || !text.trim()) throw new Error('Instruction is empty')
    return this.locked(worker, async () => {
      const path = this.path('instructions', worker, `${instructionId}.json`)
      const old = readJson(path)
      if (old && old.text !== text) throw new Error('Instruction ID reused with different content')
      let goal = await this.goal(worker)
      if (!resume && (!goal || goal.phase === 'complete')) throw new Error('Saved-only dispatch requires an unfinished goal')
      if (old?.status === 'APPLIED') return { status: 'APPLIED', deduplicated: true, goalId: old.goalId }
      if (!goal?.objective?.includes(marker(instructionId))) {
        if (old?.status === 'UNCERTAIN') return { status: 'UNCERTAIN', action: 'Inspect native goal; do not blindly replay a timed-out mutation' }
        const prefix = goal && goal.phase !== 'complete' ? goal.objective : ''
        const objective = `${prefix}${prefix ? '\n\n' : ''}${marker(instructionId)}\n${text}`
        // A process can die after admission but before readback. Never replay that mutation blindly.
        await atomicJson(path, { instructionId, text, status: 'UNCERTAIN' })
        try {
          const request = { objective, maxGoalRounds: Number.MAX_SAFE_INTEGER }
          if (!goal || goal.phase === 'complete') await this.native('goals/create', { agentId: this.worker(worker).sessionId, request })
          else await this.change(worker, goal, 'edit', request)
        } catch (error) {
          await atomicJson(path, { instructionId, text, status: 'UNCERTAIN', error: error.message })
          throw error
        }
      }
      goal = await this.goal(worker)
      if (!goal?.objective?.includes(`${marker(instructionId)}\n${text}`.trim())) throw new Error('Native goal readback differs from full instruction')
      await atomicJson(path, { instructionId, text, status: 'APPLIED', goalId: goal.id, revision: goal.revision })
      if (resume && !restricted(goal) && goal.phase !== 'blocked' && (goal.phase === 'paused' || goal.activation === 'disarmed')) goal = await this.change(worker, goal, 'resume')
      const previous = readJson(this.path('workers', `${worker}.json`), {})
      const keepWait = !resume && previous.status === 'WAITING' && previous.goalId === goal.id
      await atomicJson(this.path('workers', `${worker}.json`), { ...(keepWait ? previous : {}), status: restricted(goal) || goal.phase === 'blocked' ? 'BLOCKED' : resume ? 'WORKING' : keepWait ? 'WAITING' : 'SAVED', goalId: goal.id, revision: goal.revision, roundsStarted: goal.roundsStarted, instructionId })
      return { status: 'APPLIED', goalId: goal.id, revision: goal.revision, activation: goal.activation, blocked: restricted(goal) || goal.phase === 'blocked', activationConfirmed: false }
    })
  }

  /** Return whether a declared artifact dependency is satisfied; heartbeats are not events. */
  dependencyReady(dependency) {
    const path = artifactPath(this.workspace, dependency.path)
    if (!existsSync(path)) return false
    if (dependency.kind === 'created') return true
    if (dependency.kind !== 'terminal' || !dependency.runId) throw new Error('Expected created or terminal dependency with runId')
    const row = readJson(path)
    return row.run_id === dependency.runId && ['COMPLETE', 'FAILED', 'CANCELLED'].includes(row.status)
  }

  /** Pause only for an unmet named dependency; native pause does not stop external compute. */
  async wait(worker, jobId, dependency) {
    safeId(jobId)
    return this.locked(worker, async () => {
      const goal = await this.goal(worker)
      if (!goal || goal.phase !== 'active' || restricted(goal)) throw new Error('Wait requires an active, unrestricted native goal')
      if (this.dependencyReady(dependency)) return { status: 'DEPENDENCY_ALREADY_READY' }
      const path = this.path('workers', `${worker}.json`)
      await atomicJson(path, { status: 'REGISTERING_WAIT', goalId: goal.id, revision: goal.revision, jobId, dependency })
      const paused = await this.change(worker, goal, 'pause')
      await atomicJson(path, { status: 'WAITING', goalId: paused.id, revision: paused.revision, jobId, dependency })
      return { status: 'WAITING', modelPolling: false }
    })
  }

  /** Wake an owned wait once; a manual pause, newer goal or real blocker remains untouched. */
  async tick(worker) {
    return this.locked(worker, async () => {
      const path = this.path('workers', `${worker}.json`)
      const state = readJson(path)
      if (!state) return { status: 'UNASSIGNED' }
      let goal = await this.goal(worker)
      if (!goal || goal.id !== state.goalId) return { status: 'GOAL_CHANGED' }
      if (goal.phase === 'complete') {
        if (state.status !== 'COMPLETE') await atomicJson(path, { ...state, status: 'COMPLETE' })
        const expected = this.worker(worker).report
        if (!expected) return { status: 'COMPLETE' }
        const source = artifactPath(this.workspace, expected.path)
        if (!existsSync(source)) return { status: 'REPORT_MISSING', jobId: expected.jobId }
        const report = readJson(source)
        if (report.goal_id !== goal.id) throw new Error('Completion report belongs to another goal')
        const published = await this.publish(worker, expected.jobId, expected.event, expected.path)
        return { status: 'COMPLETE', deliveryId: published.deliveryId }
      }
      if (restricted(goal) || goal.phase === 'blocked') return { status: 'BLOCKED' }
      if (state.status === 'WORKING') {
        if (goal.phase === 'active' && goal.activation === 'disarmed' && this.autoResumeOwnedGoals) {
          const ref = `${goal.id}:${goal.revision}`
          if (state.resumeAttemptRef === ref) return { status: 'RESUME_NEEDS_ATTENTION' }
          await atomicJson(path, { ...state, resumeAttemptRef: ref })
          const resumed = await this.change(worker, goal, 'resume')
          await atomicJson(path, { ...state, resumeAttemptRef: `${resumed.id}:${resumed.revision}` })
          return { status: 'RESUME_REQUESTED', activationConfirmed: false }
        }
        if (goal.phase === 'paused') return { status: 'MANUAL_PAUSE' }
        return { status: 'WORKING', activationConfirmed: goal.roundsStarted > (state.roundsStarted ?? 0) }
      }
      if (state.status !== 'WAITING' && state.status !== 'WAKING') return { status: state.status }
      if (!this.dependencyReady(state.dependency)) return { status: 'WAITING' }
      const eventMarker = `[BRIDGE_EVENT_ID=${digest(`${goal.id}:${state.jobId}:${JSON.stringify(state.dependency)}`)}]`
      if (state.status === 'WAITING' && (goal.phase !== 'paused' || goal.revision !== state.revision)) return { status: 'PAUSE_CHANGED', action: 'Inspect pause ownership' }
      if (!goal.objective.includes(eventMarker)) {
        if (goal.phase !== 'paused' || goal.revision !== state.revision) return { status: 'PAUSE_CHANGED' }
        await atomicJson(path, { ...state, status: 'WAKING' })
        goal = await this.change(worker, goal, 'edit', { objective: `${goal.objective}\n\n${eventMarker}\nDependency is ready: ${state.dependency.path}. Read the existing full goal and checkpoint; this event adds no new task.` })
        if (!goal.objective.includes(eventMarker)) throw new Error('Wake event missing from native goal')
        await atomicJson(path, { ...state, status: 'WAKING', wakeRevision: goal.revision })
      } else if (goal.phase === 'paused' && (!state.wakeRevision || goal.revision !== state.wakeRevision)) {
        return { status: 'WAKE_NEEDS_ATTENTION', action: 'Inspect uncertain mutation or intervening manual pause' }
      }
      if (goal.phase === 'paused' || goal.activation === 'disarmed') goal = await this.change(worker, goal, 'resume')
      await atomicJson(path, { ...state, status: 'WORKING', revision: goal.revision, roundsStarted: goal.roundsStarted, lastEvent: eventMarker })
      return { status: 'WAKE_REQUESTED', activationConfirmed: false }
    })
  }

  /** Compact only at an owned wait boundary, with explicit accepted work and verbatim pending requirements. */
  async compact(worker, { goalId, revision, objective, acceptedCompleted, pendingInstructions }) {
    return this.locked(worker, async () => {
      const state = readJson(this.path('workers', `${worker}.json`))
      const goal = await this.goal(worker)
      if (!goal || goal.id !== goalId || goal.revision !== revision || goal.phase !== 'paused' || state?.status !== 'WAITING' || state.goalId !== goal.id || state.revision !== goal.revision) throw new Error('Compaction requires the unchanged owned wait')
      if (!acceptedCompleted?.length || !pendingInstructions?.length || typeof objective !== 'string') throw new Error('Supply accepted work and every pending instruction')
      const acceptedIds = new Set()
      for (const row of acceptedCompleted) {
        safeId(row.instructionId)
        if (!row.reviewPath || !existsSync(artifactPath(this.workspace, row.reviewPath))) throw new Error('Completed instruction needs a saved acceptance review')
        const instruction = readJson(this.path('instructions', worker, `${row.instructionId}.json`))
        if (!instruction || instruction.goalId !== goal.id) throw new Error('Accepted instruction belongs to another goal')
        acceptedIds.add(row.instructionId)
      }
      const pendingIds = new Set(pendingInstructions)
      for (const file of readdirSync(this.path('instructions', worker))) {
        if (!file.endsWith('.json')) continue
        const row = readJson(this.path('instructions', worker, file))
        if (row.goalId === goal.id && row.status === 'APPLIED' && !acceptedIds.has(row.instructionId) && !pendingIds.has(row.instructionId)) throw new Error('Registered instruction missing from both accepted and pending lists')
        if (acceptedIds.has(row.instructionId) && pendingIds.has(row.instructionId)) throw new Error('Instruction cannot be both accepted and pending')
      }
      for (const id of pendingInstructions) {
        const row = readJson(this.path('instructions', worker, `${safeId(id)}.json`))
        if (!row || !objective.includes(`${marker(id)}\n${row.text}`.trim())) throw new Error('Pending instruction omitted or summarized')
      }
      await atomicJson(this.path('history', worker, `${goal.id}-${goal.revision}.json`), { goal, acceptedCompleted, pendingInstructions })
      await this.change(worker, goal, 'edit', { objective })
      const checked = await this.goal(worker)
      if (checked.objective !== objective.trim()) throw new Error('Compaction readback mismatch')
      for (const row of acceptedCompleted) {
        const file = this.path('instructions', worker, `${row.instructionId}.json`)
        const previous = readJson(file)
        if (!previous || previous.goalId !== goal.id) throw new Error('Accepted instruction belongs to another goal')
        await atomicJson(file, { ...previous, status: 'ARCHIVED_ACCEPTED', reviewPath: row.reviewPath })
      }
      await atomicJson(this.path('workers', `${worker}.json`), { ...state, revision: checked.revision })
      return { status: 'COMPACTED', revision: checked.revision }
    })
  }

  /** Publish immutable completion metadata before attempting any notification transport. */
  async publish(worker, jobId, event, reportPath) {
    this.worker(worker); safeId(jobId); safeId(event)
    const source = artifactPath(this.workspace, reportPath)
    const report = readJson(source)
    if (!report || report.job_id !== jobId || report.session_id !== this.worker(worker).sessionId || report.event !== event) throw new Error('Report ownership/event mismatch')
    const deliveryId = digest(`${worker}:${jobId}:${event}`)
    const path = this.path('outbox', `${deliveryId}.json`)
    return withLock(`${path}.lock`, async () => {
      const old = readJson(path)
      if (old) {
        if (JSON.stringify(old.report) !== JSON.stringify(report)) throw new Error('Event changed; publish a new version')
        return { status: old.transportStatus, deliveryId, deduplicated: true }
      }
      await atomicJson(path, { deliveryId, worker, jobId, event, reportPath: source, report, transportStatus: 'QUEUED', analysisStatus: 'PENDING', createdAt: new Date().toISOString() })
      return { status: 'QUEUED', deliveryId }
    })
  }

  /** Deliver queued events once; ambiguous dispatches are retained without blind retransmission. */
  async deliver(deliveryId, sender) {
    safeId(deliveryId)
    const path = this.path('outbox', `${deliveryId}.json`)
    const claim = await withLock(`${path}.lock`, async () => {
      const row = readJson(path)
      if (!row) throw new Error('Unknown delivery')
      if (!['QUEUED', 'NOT_SENT'].includes(row.transportStatus)) return { admitted: false, row }
      const attemptId = randomUUID()
      await atomicJson(path, { ...row, transportStatus: 'SENDING', attemptId, sendStartedAt: new Date().toISOString() })
      return { admitted: true, row, attemptId }
    })
    if (!claim.admitted) return claim.row
    let receipt
    try {
      receipt = await sender({ deliveryId, worker: claim.row.worker, jobId: claim.row.jobId, event: claim.row.event, reportPath: claim.row.reportPath, summary: String(claim.row.report.summary ?? '').slice(0, 1200), requiresArtifactAnalysis: true })
      if (!['ACCEPTED', 'RECEIVED', 'NOT_SENT', 'DENIED', 'UNCERTAIN'].includes(receipt?.status)) throw new Error('Unknown transport receipt')
    } catch (error) { receipt = { status: 'UNCERTAIN', error: error.message } }
    // Do not hold the lock while the host sends: receiver/analysis ACK can arrive first.
    return withLock(`${path}.lock`, async () => {
      const current = readJson(path)
      if (current.attemptId !== claim.attemptId) throw new Error('Delivery attempt changed')
      const status = current.transportStatus === 'RECEIVED' ? 'RECEIVED' : receipt.status
      const next = { ...current, transportStatus: status, receipt,
        ...(['ACCEPTED', 'RECEIVED'].includes(status) && !current.acceptedAt ? { acceptedAt: new Date().toISOString() } : {}) }
      await atomicJson(path, next)
      return next
    })
  }

  /** Send one separate reminder after a grace period, without replaying the original task/result. */
  async remind(deliveryId, sender, { graceMs = 900000, now = Date.now() } = {}) {
    safeId(deliveryId)
    if (!Number.isSafeInteger(graceMs) || graceMs < 1000) throw new Error('Reminder grace must be >=1000ms')
    const path = this.path('outbox', `${deliveryId}.json`)
    const claim = await withLock(`${path}.lock`, async () => {
      const row = readJson(path)
      if (!row) throw new Error('Unknown delivery')
      const since = Date.parse(row.acceptedAt ?? row.sendStartedAt ?? '')
      if (row.analysisStatus === 'ANALYZED' || row.notice || !Number.isFinite(since) || now - since < graceMs || !['ACCEPTED', 'RECEIVED', 'SENDING', 'UNCERTAIN'].includes(row.transportStatus)) return null
      await atomicJson(path, { ...row, notice: { status: 'SENDING', createdAt: new Date(now).toISOString() } })
      return { deliveryId: `${deliveryId}-notice`, originalDeliveryId: deliveryId, kind: 'ANALYSIS_NOTICE', jobId: row.jobId, event: row.event, reportPath: row.reportPath, summary: 'Saved result still awaits analysis. Read the current checkpoint and report. This notice adds no task; ignore it if already analyzed.' }
    })
    if (!claim) return { status: 'NO_NOTICE_NEEDED' }
    let receipt
    try {
      receipt = await sender(claim)
      if (!['ACCEPTED', 'RECEIVED', 'NOT_SENT', 'DENIED', 'UNCERTAIN'].includes(receipt?.status)) throw new Error('Unknown notice receipt')
    } catch (error) { receipt = { status: 'UNCERTAIN', error: error.message } }
    await withLock(`${path}.lock`, async () => {
      const row = readJson(path)
      await atomicJson(path, { ...row, notice: { ...row.notice, status: receipt.status, superseded: row.analysisStatus === 'ANALYZED', receipt } })
    })
    return { status: receipt.status, originalDeliveryId: deliveryId, noticeOnly: true }
  }

  /** Receiver ACK stops replay; analysis ACK additionally requires a review and a next disposition. */
  async acknowledge(deliveryId, { analyzed = false, reviewPath, nextAction } = {}) {
    safeId(deliveryId)
    const path = this.path('outbox', `${deliveryId}.json`)
    return withLock(`${path}.lock`, async () => {
      const row = readJson(path)
      if (!row) throw new Error('Unknown delivery')
      if (analyzed && (!reviewPath || !nextAction?.trim())) throw new Error('Analysis requires reviewPath and nextAction')
      if (analyzed && !existsSync(artifactPath(this.workspace, reviewPath))) throw new Error('Analysis review does not exist')
      const next = { ...row, transportStatus: 'RECEIVED', acceptedAt: row.acceptedAt ?? new Date().toISOString(), analysisStatus: analyzed ? 'ANALYZED' : row.analysisStatus, ...(analyzed ? { reviewPath, nextAction } : {}) }
      await atomicJson(path, next)
      return next
    })
  }
}
