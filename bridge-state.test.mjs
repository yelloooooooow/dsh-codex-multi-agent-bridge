import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import {
  canReplaceUnstartedSupervisor,
  parseCodexThreadSelection,
  prepareBridgeState,
  workspaceRunId,
} from './bridge.mjs'
import { apply as applySessionLabel } from './session-label-plugin.mjs'

test('one workspace keeps one bridge identity across completed jobs', () => {
  const workspace = 'C:\\work\\deepseek-harness'
  const options = {
    runId: workspaceRunId(workspace),
    workspace,
    lane: 'main',
    advisors: ['codex'],
    stateDir: join(workspace, '.bridge-state-test'),
    webVisible: false,
    webControlUrl: 'http://127.0.0.1:3080/api/codex-dsh-bridge',
    codexThreadId: 'codex-thread-1',
  }
  const first = prepareBridgeState(undefined, options, 'first task', true)
  first.status = 'completed'
  first.cycles = 3
  first.workerProtocolSent = true
  first.jobStarted = true
  first.lastWorkerReport = { terminal: true }
  first.result = 'accepted'

  const second = prepareBridgeState(first, options, 'second task', true)

  assert.equal(second.dshSessionId, first.dshSessionId)
  assert.equal(second.codexThreadId, first.codexThreadId)
  assert.equal(second.jobNumber, 2)
  assert.equal(second.jobCycleStart, 3)
  assert.equal(second.task, 'second task')
  assert.equal(second.status, 'starting')
  assert.equal(second.workerProtocolSent, true)
  assert.equal(second.jobStarted, false)
  assert.equal(second.lastWorkerReport, undefined)
  assert.equal(second.result, undefined)
})

test('workspace identity is stable across Windows path casing', () => {
  assert.equal(workspaceRunId('C:\\work\\deepseek-harness'), workspaceRunId('c:\\WORK\\DEEPSEEK-HARNESS'))
  assert.equal(workspaceRunId('C:\\work\\deepseek-harness', 'main'), workspaceRunId('C:\\work\\deepseek-harness'))
  assert.notEqual(workspaceRunId('C:\\work\\deepseek-harness', 'review-1'), workspaceRunId('C:\\work\\deepseek-harness', 'review-2'))
})

test('a lane keeps its Session while a later job changes adviser combinations', () => {
  const workspace = 'C:\\work\\deepseek-harness'
  const base = {
    runId: workspaceRunId(workspace, 'parallel-1'),
    workspace,
    lane: 'parallel-1',
    advisors: ['codex', 'chatgpt-web'],
    stateDir: join(workspace, '.bridge-state-test'),
    webVisible: false,
    webControlUrl: 'http://127.0.0.1:3080/api/codex-dsh-bridge',
  }
  const first = prepareBridgeState(undefined, base, 'first task', true)
  first.status = 'completed'
  const second = prepareBridgeState(first, { ...base, advisors: ['chatgpt-app'] }, 'second task', true)

  assert.equal(second.dshSessionId, first.dshSessionId)
  assert.equal(second.lane, 'parallel-1')
  assert.deepEqual(second.advisors, ['chatgpt-app'])
  assert.equal(second.chatgptConversationName, first.chatgptConversationName)
})

test('only an uninitialized first supervisor task can be replaced', () => {
  const state = {
    jobNumber: 1,
    cycles: 0,
    jobStarted: false,
    workerProtocolSent: false,
    unreviewedWorkerReports: [],
  }
  const missingRollout = new Error('Codex JSON-RPC error: no rollout found for thread id task-1')

  assert.equal(canReplaceUnstartedSupervisor(state, missingRollout), true)
  assert.equal(canReplaceUnstartedSupervisor({ ...state, jobStarted: true }, missingRollout), false)
  assert.equal(canReplaceUnstartedSupervisor({ ...state, jobNumber: 2 }, missingRollout), false)
  assert.equal(canReplaceUnstartedSupervisor(state, new Error('network unavailable')), false)
})

test('visible Codex task selection requires an explicit listed task or NEW', () => {
  const threads = [{ id: 'thread-one' }, { id: 'thread-two' }]

  assert.deepEqual(parseCodexThreadSelection('2', threads), {
    kind: 'existing',
    threadId: 'thread-two',
  })
  assert.deepEqual(parseCodexThreadSelection('thread-one', threads), {
    kind: 'existing',
    threadId: 'thread-one',
  })
  assert.deepEqual(parseCodexThreadSelection('NEW', threads), { kind: 'new' })
  assert.throws(() => parseCodexThreadSelection('', threads), /listed number or enter NEW/)
  assert.throws(() => parseCodexThreadSelection('3', threads), /listed number or enter NEW/)
})

test('the bridge Session receives one fixed user title', () => {
  const previous = process.env.DSH_BRIDGE_SESSION_ID
  const previousTitle = process.env.DSH_BRIDGE_SESSION_TITLE
  process.env.DSH_BRIDGE_SESSION_ID = 'bridge-session'
  process.env.DSH_BRIDGE_SESSION_TITLE = '桥接对话 · review-1'
  try {
    let created
    let title
    let renames = 0
    const ctx = {
      on(event, listener) {
        assert.equal(event, 'session/created')
        created = listener
      },
      sessionTitle: {
        get: () => title === undefined ? undefined : { title },
        rename: (_session, value) => {
          title = value
          renames += 1
        },
      },
    }
    applySessionLabel(ctx)
    created({ id: 'another-session' })
    created({ id: 'bridge-session' })
    created({ id: 'bridge-session' })
    assert.equal(title, '桥接对话 · review-1')
    assert.equal(renames, 1)
  } finally {
    if (previous === undefined) delete process.env.DSH_BRIDGE_SESSION_ID
    else process.env.DSH_BRIDGE_SESSION_ID = previous
    if (previousTitle === undefined) delete process.env.DSH_BRIDGE_SESSION_TITLE
    else process.env.DSH_BRIDGE_SESSION_TITLE = previousTitle
  }
})
