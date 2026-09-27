#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

import { DeepSeekHarness } from '../packages/sdk/client/lib/index.js'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const WEB_CONTROL_TOKEN_PATH = join(homedir(), '.codex-dsh-bridge', 'web-control-token')
const ADVISORS = new Set(['codex', 'chatgpt-web', 'chatgpt-app'])
const SUPERVISOR_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['delegate', 'complete', 'abort'] },
    instruction: { type: 'string' },
    rationale: { type: 'string' },
  },
  required: ['action', 'instruction', 'rationale'],
  additionalProperties: false,
}

const WORKER_PROTOCOL = `You are the persistent execution worker in a supervisor-worker loop.
Work directly in the assigned workspace and carry out as much of the instruction as safely possible before replying.
Before changing a file, read and follow only the AGENTS.md or CLAUDE.md files that govern that file: start at the workspace root and follow the directory path to the file's parent. Do not recursively scan unrelated directories for instructions.
Do not stop for routine implementation choices. Fix low-risk, reversible command mistakes and transient failures yourself. Do not claim success without concrete evidence.
Never delete multiple files or directories. Never reveal credentials or secret values.
Immediately request the supervisor when the goal or acceptance criteria are unclear; evidence contradicts your assumptions or plan; the method, architecture, or interpretation must materially change; an action may be destructive, irreversible, external, security-sensitive, privacy-sensitive, or high-impact; credentials or permissions are involved; unexpected files, state, or out-of-scope failures appear; multiple plausible paths have materially different outcomes; confidence is too low; an approach repeatedly fails; you discover that an earlier result may be wrong; or an error could propagate into serious consequences.
Do not suppress, bypass, or silently work around a semantic error. Report it when it needs judgment. When no new judgment is needed, continue autonomously and state the next action you will take.
Treat every report as a durable incremental checkpoint. Record every new material fact, decision, assumption, risk, and open question since the previous report; use empty arrays when a category has no new entries.
Your final response must be exactly one JSON object with no Markdown outside it:
{"event":"any short descriptive label","terminal":false,"needsSupervisor":false,"severity":"any short label","confidence":0.0,"summary":"brief factual status","question":"one focused question or empty string","facts":["new verified facts"],"decisions":["new decisions and why"],"assumptions":["unverified assumptions"],"risks":["new risks or empty"],"openQuestions":["unresolved questions"],"evidence":["short evidence"],"changedFiles":["paths"],"tests":["commands and outcomes"],"consultations":[{"advisor":"codex or chatgpt-web or chatgpt-app","conversation":"visible conversation name or id","question":"compact question","answer":"compact answer summary","outcome":"how it affected the work"}],"nextAction":"what you will do next or empty string"}
The event label is open-ended; choose the label that best describes what happened. Set terminal=true only when no more worker action is needed or safe. Set needsSupervisor=true whenever a new decision, correction, permission, or alignment is required. A terminal report is always reviewed by the supervisor.`

function advisorProtocol(advisors, conversationName) {
  const enabled = advisors.join(', ')
  const chatgpt = advisors.filter(advisor => advisor.startsWith('chatgpt-'))
  const chatgptInstructions = chatgpt.length === 0 ? '' : `
The enabled ChatGPT transports are ${chatgpt.join(' and ')}. They are real advisers, not output destinations. When uncertainty, contradictory evidence, architectural choice, possible error, or final verification needs outside judgment, consult ChatGPT before returning. Use the available transport tools to continue exactly one conversation named "${conversationName}". Create and rename it only if it does not exist. Never start a fresh conversation for a routine consultation.
Before using ChatGPT Web, call bridge_advisor_acquire with channel=web; before using the Windows app, call it with channel=app. Hold the lease for the entire snapshot/type/wait/read sequence and always call bridge_advisor_release in a finally-style cleanup. A lease serializes only shared UI consultations; continue non-UI work without it.
Send only the current question plus the minimum verified facts, constraints, attempted actions, and relevant evidence. Wait for and read the complete answer, then act on it. Record a compact question, answer summary, conversation identity, and outcome in consultations; the raw tool calls remain in the durable Session log. Prefer one transport and switch to another enabled transport if it is unavailable. Do not ask both the same question unless an independent second review has clear value.
Do not set needsSupervisor merely because you need ChatGPT: consult it first. Set needsSupervisor only if enabled advisers cannot resolve the issue, the adviser answer requires human authority, or the UI transport is unavailable after a safe retry. Before terminal=true, obtain a final ChatGPT review of the result and address any material finding.`
  const codexInstructions = advisors.includes('codex')
    ? '\nCodex is an enabled supervisor. Return needsSupervisor=true after any useful ChatGPT consultation when Codex judgment is still required. Codex performs the final review of terminal reports.'
    : '\nCodex is not enabled for this job. Continue from ChatGPT advice autonomously; reserve needsSupervisor=true for a decision that requires the human user.'
  return `ACTIVE ADVISORS: ${enabled}.${chatgptInstructions}${codexInstructions}`
}

function parseArgs(argv) {
  const options = {
    workspace: process.cwd(),
    lane: 'main',
    advisors: ['codex'],
    dshModel: 'deepseek-v4-flash',
    dshEffort: 'low',
    dshMaxTokens: 4096,
    codexEffort: 'medium',
    webControlUrl: process.env.DSH_BRIDGE_WEB_CONTROL_URL ?? 'http://127.0.0.1:3080/api/codex-dsh-bridge',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${name} requires a value`)
      return argv[index]
    }
    if (name === '--task') options.task = next()
    else if (name === '--task-env') options.task = process.env[next()]
    else if (name === '--resume-note') options.resumeNote = next()
    else if (name === '--resume-note-env') options.resumeNote = process.env[next()]
    else if (name === '--lane') options.lane = next()
    else if (name === '--lane-env') options.lane = process.env[next()] ?? ''
    else if (name === '--advisors') options.advisors = next().split(',').map(value => value.trim()).filter(Boolean)
    else if (name === '--workspace') {
      options.workspace = next()
      options.workspaceExplicit = true
    } else if (name === '--run-id') {
      options.runId = next()
      options.runIdExplicit = true
    }
    else if (name === '--state-dir') options.stateDir = next()
    else if (name === '--max-cycles') options.maxCycles = Number.parseInt(next(), 10)
    else if (name === '--dsh-model') options.dshModel = next()
    else if (name === '--dsh-effort') options.dshEffort = next()
    else if (name === '--dsh-max-tokens') options.dshMaxTokens = Number.parseInt(next(), 10)
    else if (name === '--codex-model') options.codexModel = next()
    else if (name === '--codex-effort') options.codexEffort = next()
    else if (name === '--codex-thread') options.codexThreadId = next()
    else if (name === '--select-codex-thread') options.selectCodexThread = true
    else if (name === '--web-visible') options.webVisible = true
    else if (name === '--web-control-url') options.webControlUrl = next()
    else if (name === '--resume') options.resume = true
    else if (name === '--protocol-test') options.protocolTest = true
    else if (name === '--help' || name === '-h') options.help = true
    else throw new Error(`unknown option: ${name}`)
  }
  return options
}

function usage() {
  return `DSH Codex Multi-Agent Bridge

Usage:
  node bridge.mjs --task "TASK" [options]
  node bridge.mjs --resume [--workspace PATH] [options]
  node bridge.mjs --protocol-test [options]

Options:
  --workspace PATH       Worker workspace (default: current directory)
  --lane NAME            Independent persistent agent lane (default: main)
  --advisors LIST        Comma-separated: codex,chatgpt-web,chatgpt-app
  --resume-note TEXT     Human answer or recovery context for a resumed lane
  --run-id NAME          Persistent bridge name (default: derived from workspace)
  --state-dir PATH       State root (default: ~/.codex-dsh-bridge/NAME)
  --max-cycles N         Optional DSH turn safety cap (default: unlimited)
  --web-visible          Store the worker session in ~/.dsh for Web visibility
  --web-control-url URL  Web bridge endpoint used for Workspace grouping
  --codex-thread ID      Resume an existing Codex supervisor thread
  --select-codex-thread  Interactively bind a visible Codex task on first setup
  --codex-model MODEL    Override the Codex supervisor model
  --codex-effort LEVEL   Codex reasoning effort (default: medium)
  --dsh-model MODEL      DSH model (default: deepseek-v4-flash)
  --dsh-effort LEVEL     DSH reasoning effort (default: low)
  --dsh-max-tokens N     DSH output cap per model request (default: 4096)`
}

function validateOptions(options) {
  if (options.help) return
  if (options.protocolTest) {
    options.task = 'Protocol test. The worker must ask the supervisor for a completion code. Hold the code amber-7 and do not reveal it in the first instruction. After the worker asks, provide the code. Complete only when the worker reports that it received amber-7. No files may be created or changed.'
    if (!options.runIdExplicit) options.runId = `protocol-test-${Date.now()}`
    if (options.maxCycles === undefined) options.maxCycles = 4
    options.dshMaxTokens = Math.min(options.dshMaxTokens, 512)
    options.advisors = ['codex']
  }
  if ((!options.task || options.task.trim() === '') && !options.resume) {
    throw new Error('--task, --task-env, --protocol-test, or --resume is required')
  }
  if (options.maxCycles !== undefined && (!Number.isSafeInteger(options.maxCycles) || options.maxCycles < 1)) {
    throw new Error('--max-cycles must be a positive integer')
  }
  if (!Number.isSafeInteger(options.dshMaxTokens) || options.dshMaxTokens < 64) {
    throw new Error('--dsh-max-tokens must be an integer of at least 64')
  }
  options.workspace = resolve(options.workspace)
  options.lane = options.lane.trim().toLowerCase()
  if (!/^[A-Za-z0-9._-]+$/.test(options.lane)) {
    throw new Error('--lane may contain only letters, numbers, dot, underscore, and hyphen')
  }
  options.advisors = [...new Set(options.advisors)]
  if (options.advisors.length === 0 || options.advisors.some(advisor => !ADVISORS.has(advisor))) {
    throw new Error('--advisors must contain one or more of codex,chatgpt-web,chatgpt-app')
  }
  options.runId ??= workspaceRunId(options.workspace, options.lane)
  if (!/^[A-Za-z0-9._-]+$/.test(options.runId)) {
    throw new Error('--run-id may contain only letters, numbers, dot, underscore, and hyphen')
  }
  options.stateDir = resolve(options.stateDir ?? join(homedir(), '.codex-dsh-bridge', options.runId))
}

export function workspaceRunId(workspace, lane = 'main') {
  const normalized = resolve(workspace).replaceAll('\\', '/').toLowerCase()
  const label = basename(workspace).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 12)
  const base = `workspace-${label}-${digest}`
  return lane === 'main' ? base : `${base}-lane-${lane.toLowerCase()}`
}

export function parseCodexThreadSelection(value, threads) {
  const choice = value.trim()
  if (/^new$/i.test(choice)) return { kind: 'new' }
  if (/^[1-9]\d*$/.test(choice)) {
    const thread = threads[Number.parseInt(choice, 10) - 1]
    if (thread) return { kind: 'existing', threadId: thread.id }
  }
  if (threads.some(thread => thread.id === choice)) return { kind: 'existing', threadId: choice }
  throw new Error('select a listed number or enter NEW')
}

function codexThreadLabel(thread) {
  const text = thread.name || thread.preview || '(untitled task)'
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 100)
}

async function askCodexThread(threads) {
  if (threads.length === 0) {
    throw new Error('no visible Codex task uses this workspace; open one in Codex first or pass --codex-thread ID')
  }
  console.log('\nVisible Codex tasks for this workspace:')
  for (const [index, thread] of threads.entries()) {
    console.log(`  ${index + 1}. ${codexThreadLabel(thread)}  [${thread.id}]`)
  }
  console.log('Enter a number to keep all supervisor messages in that visible task.')
  console.log('Enter NEW only if you want a separate app-server task that may require reopening Codex to display.')
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise(resolvePromise => {
      prompt.question('Codex task: ', resolvePromise)
    })
    return parseCodexThreadSelection(answer, threads)
  } finally {
    prompt.close()
  }
}

export function canReplaceUnstartedSupervisor(state, error) {
  const message = error instanceof Error ? error.message : String(error)
  return state.jobNumber === 1
    && state.cycles === 0
    && state.jobStarted === false
    && state.workerProtocolSent === false
    && !state.lastWorkerReport
    && !state.pendingInstruction
    && state.unreviewedWorkerReports.length === 0
    && message.includes('no rollout found for thread id')
}

export function prepareBridgeState(prior, options, task, startingNewJob) {
  const state = prior ? { ...prior } : {
    version: 4,
    runId: options.runId,
    lane: options.lane,
    advisors: options.advisors,
    task,
    workspace: options.workspace,
    dshSessionId: `bridge-${randomUUID()}`,
    codexThreadId: options.codexThreadId,
    cycles: 0,
    jobNumber: 1,
    jobCycleStart: 0,
    workerProtocolSent: false,
    jobStarted: false,
    status: 'starting',
    unreviewedWorkerReports: [],
  }
  if (prior && startingNewJob) {
    state.jobNumber = (prior.jobNumber ?? 1) + 1
    state.jobCycleStart = prior.cycles ?? 0
    state.jobStarted = false
    state.status = 'starting'
    state.unreviewedWorkerReports = []
    delete state.lastWorkerReport
    delete state.lastWorkerFingerprint
    delete state.repeatCount
    delete state.pendingInstruction
    delete state.result
    delete state.error
  }
  state.task = task
  state.workspace = options.workspace
  state.version = 4
  state.lane ??= options.lane
  state.advisors = options.advisors
  state.chatgptConversationName ??= `桥接对话 · ${basename(options.workspace)} · ${state.lane}`.slice(0, 80)
  state.jobNumber ??= 1
  state.jobCycleStart ??= 0
  state.workerProtocolSent ??= (state.cycles ?? 0) > 0
  state.jobStarted ??= (state.cycles ?? 0) > state.jobCycleStart
  state.dshHome = prior?.dshHome
    ?? (prior ? join(options.stateDir, 'dsh-home') : options.webVisible ? join(homedir(), '.dsh') : join(options.stateDir, 'dsh-home'))
  state.webVisible = resolve(state.dshHome).toLowerCase() === resolve(homedir(), '.dsh').toLowerCase()
  state.webControlUrl = options.webControlUrl
  state.codexThreadId ??= options.codexThreadId
  state.unreviewedWorkerReports ??= state.lastWorkerReport
    ? [{ cycle: state.cycles, report: state.lastWorkerReport }]
    : []
  return state
}

function safeJsonParse(text) {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1))
    throw new Error(`response was not JSON: ${trimmed.slice(0, 500)}`)
  }
}

function loadDeepSeekKey() {
  if (process.env.DEEPSEEK_API_KEY?.trim()) return process.env.DEEPSEEK_API_KEY.trim()
  const credentialsPath = join(homedir(), '.dsh', '.credentials.yaml')
  if (!existsSync(credentialsPath)) {
    throw new Error('DEEPSEEK_API_KEY is not set and ~/.dsh/.credentials.yaml does not exist')
  }
  const credentials = yaml.load(readFileSync(credentialsPath, 'utf8'))
  const key = credentials?.refs?.DEEPSEEK_API_KEY
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error('DEEPSEEK_API_KEY is not set and the DSH credential store has no DEEPSEEK_API_KEY reference')
  }
  return key.trim()
}

class CodexAppServer {
  constructor({ cwd }) {
    this.cwd = cwd
    this.serial = 0
    this.pending = new Map()
    this.listeners = new Set()
    this.stderr = ''
  }

  async start() {
    this.child = spawn('codex', ['app-server', '--stdio'], {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8000)
    })
    this.child.once('exit', (code, signal) => {
      const error = new Error(`Codex app-server exited (code=${String(code)}, signal=${String(signal)}): ${this.stderr}`)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    })
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => this.handleLine(line))
    await this.request('initialize', {
      clientInfo: {
        name: 'codex_dsh_bridge',
        title: 'Codex-DSH Bridge',
        version: '0.1.0',
      },
    })
    this.notify('initialized', {})
  }

  handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (process.env.CODEX_DSH_DEBUG === '1') {
      console.log(`[codex-rpc] ${message.method ?? 'response'} id=${String(message.id ?? '-')}`)
      if (message.method === 'error' || message.method === 'warning') {
        console.log(`[codex-rpc-detail] ${JSON.stringify(message.params ?? {})}`)
      }
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(`Codex JSON-RPC error: ${JSON.stringify(message.error)}`))
      else pending.resolve(message.result)
      return
    }
    if (message.method && message.id !== undefined) {
      this.send({
        id: message.id,
        error: { code: -32601, message: `Bridge does not implement server request ${message.method}` },
      })
      return
    }
    if (message.method) {
      for (const listener of this.listeners) listener(message)
    }
  }

  send(message) {
    if (!this.child?.stdin.writable) throw new Error('Codex app-server stdin is closed')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request(method, params, timeoutMs = 120000) {
    const id = ++this.serial
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectPromise(new Error(`Codex request ${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolvePromise(value)
        },
        reject: error => {
          clearTimeout(timer)
          rejectPromise(error)
        },
      })
      this.send({ method, id, params })
    })
  }

  notify(method, params) {
    this.send({ method, params })
  }

  async listVisibleThreads(cwd) {
    const result = await this.request('thread/list', {
      cwd,
      limit: 20,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
      sourceKinds: ['cli', 'vscode'],
    })
    return Array.isArray(result.data)
      ? result.data.filter(thread => thread?.ephemeral !== true && typeof thread?.id === 'string')
      : []
  }

  async openThread({ threadId, cwd, model }) {
    if (threadId) {
      const result = await this.request('thread/resume', { threadId, cwd })
      return result.thread.id
    }
    const params = {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      serviceName: 'codex_dsh_bridge',
    }
    if (model) params.model = model
    const result = await this.request('thread/start', params)
    return result.thread.id
  }

  async turn({ threadId, prompt, cwd, model, effort }) {
    const messages = []
    let completed
    const completion = new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('Codex supervisor turn timed out after 20 minutes')), 1200000)
      completed = {
        resolve: value => {
          clearTimeout(timer)
          resolvePromise(value)
        },
        reject: error => {
          clearTimeout(timer)
          rejectPromise(error)
        },
      }
    })
    let turnId
    const listener = message => {
      const params = message.params ?? {}
      if (params.threadId && params.threadId !== threadId) return
      if (turnId && params.turnId && params.turnId !== turnId) return
      if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
        messages.push(params.item.text ?? '')
      }
      if (message.method === 'turn/completed' && (!turnId || params.turn?.id === turnId || params.turnId === turnId)) {
        const turn = params.turn ?? params
        if (turn.status === 'failed') completed.reject(new Error(`Codex supervisor turn failed: ${JSON.stringify(turn.error)}`))
        else completed.resolve(turn)
      }
    }
    this.listeners.add(listener)
    try {
      const params = {
        threadId,
        input: [{ type: 'text', text: prompt }],
        cwd,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', access: { type: 'fullAccess' } },
        effort,
        summary: 'concise',
        outputSchema: SUPERVISOR_SCHEMA,
      }
      if (model) params.model = model
      const started = await this.request('turn/start', params)
      turnId = started.turn.id
      const turn = await completion
      if (messages.length === 0 && Array.isArray(turn.items)) {
        for (const item of turn.items) {
          if (item.type === 'agentMessage') messages.push(item.text ?? '')
        }
      }
      const text = messages.at(-1) ?? ''
      return safeJsonParse(text)
    } finally {
      this.listeners.delete(listener)
    }
  }

  async close() {
    if (!this.child) return
    this.child.stdin.end()
    await new Promise(resolvePromise => {
      const timer = setTimeout(() => {
        this.child.kill()
        resolvePromise()
      }, 3000)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolvePromise()
      })
    })
  }
}

function readState(path) {
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8'))
}

function saveState(path, state) {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function appendEvent(path, event) {
  appendFileSync(path, `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`, 'utf8')
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function acquireProcessLock(path, owner, description) {
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, 'wx')
      try {
        writeFileSync(descriptor, `${JSON.stringify({ owner, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`)
      } finally {
        closeSync(descriptor)
      }
      return () => {
        try {
          const current = JSON.parse(readFileSync(path, 'utf8'))
          if (current.owner === owner) unlinkSync(path)
        } catch {
          // A missing or replaced lock belongs to no cleanup action here.
        }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let stale = false
      let observed
      try {
        observed = readFileSync(path, 'utf8')
        const current = JSON.parse(observed)
        stale = !processIsAlive(current.pid)
      } catch {
        stale = true
      }
      if (!stale) throw new Error(`${description} is already in use`)
      try {
        if (observed === undefined || readFileSync(path, 'utf8') === observed) unlinkSync(path)
      } catch {
        // The next atomic create decides whether another process won cleanup.
      }
    }
  }
  throw new Error(`${description} could not acquire its process lock`)
}

function normalizeWorkerResponse(text) {
  try {
    const parsed = safeJsonParse(text)
    if (typeof parsed.terminal !== 'boolean') throw new Error('terminal must be a boolean')
    if (typeof parsed.needsSupervisor !== 'boolean') throw new Error('needsSupervisor must be a boolean')
    const confidence = Number.isFinite(parsed.confidence)
      ? Math.min(1, Math.max(0, parsed.confidence))
      : null
    return {
      event: typeof parsed.event === 'string' && parsed.event.trim() ? parsed.event.trim().slice(0, 80) : 'unspecified',
      terminal: parsed.terminal,
      needsSupervisor: parsed.needsSupervisor,
      severity: typeof parsed.severity === 'string' && parsed.severity.trim() ? parsed.severity.trim().slice(0, 40) : 'info',
      confidence,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      question: typeof parsed.question === 'string' ? parsed.question : '',
      facts: Array.isArray(parsed.facts) ? parsed.facts.map(String).slice(0, 30) : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map(String).slice(0, 30) : [],
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.map(String).slice(0, 30) : [],
      risks: Array.isArray(parsed.risks) ? parsed.risks.map(String).slice(0, 30) : [],
      openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions.map(String).slice(0, 30) : [],
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String).slice(0, 20) : [],
      changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles.map(String).slice(0, 100) : [],
      tests: Array.isArray(parsed.tests) ? parsed.tests.map(String).slice(0, 50) : [],
      consultations: Array.isArray(parsed.consultations)
        ? parsed.consultations.slice(0, 20).map(value => ({
            advisor: typeof value?.advisor === 'string' ? value.advisor.slice(0, 40) : '',
            conversation: typeof value?.conversation === 'string' ? value.conversation.slice(0, 160) : '',
            question: typeof value?.question === 'string' ? value.question.slice(0, 1000) : '',
            answer: typeof value?.answer === 'string' ? value.answer.slice(0, 2000) : '',
            outcome: typeof value?.outcome === 'string' ? value.outcome.slice(0, 1000) : '',
          }))
        : [],
      nextAction: typeof parsed.nextAction === 'string' ? parsed.nextAction : '',
    }
  } catch (error) {
    return {
      event: 'protocol-error',
      terminal: false,
      needsSupervisor: true,
      severity: 'warning',
      confidence: null,
      summary: `Worker returned a malformed envelope: ${error.message}`,
      question: 'How should the worker continue?',
      facts: [],
      decisions: [],
      assumptions: [],
      risks: [],
      openQuestions: [],
      evidence: [text.slice(0, 4000)],
      changedFiles: [],
      tests: [],
      consultations: [],
      nextAction: '',
    }
  }
}

function workerFingerprint(worker) {
  return JSON.stringify([
    worker.event,
    worker.summary.trim(),
    worker.question.trim(),
    worker.nextAction.trim(),
    worker.facts,
    worker.decisions,
    worker.assumptions,
    worker.risks,
    worker.openQuestions,
    worker.evidence,
    worker.consultations,
  ])
}

function routeWorkerReport(state, worker) {
  const fingerprint = workerFingerprint(worker)
  state.repeatCount = fingerprint === state.lastWorkerFingerprint ? (state.repeatCount ?? 1) + 1 : 1
  state.lastWorkerFingerprint = fingerprint
  if (!worker.terminal && !worker.needsSupervisor && state.repeatCount >= 2) {
    worker.needsSupervisor = true
    worker.routingReason = `The worker repeated the same report ${state.repeatCount} times without observable progress.`
  }
  return worker.terminal || worker.needsSupervisor
}

function autonomousContinuationPrompt(worker) {
  const next = worker.nextAction.trim()
  return next
    ? `Continue autonomously. Execute your stated next action: ${next}`
    : 'Continue autonomously toward the assigned goal. Take the next safe, evidence-producing step.'
}

function auditInstructions(audit) {
  return `Coordinator event log: ${audit.eventsPath}
Raw DSH session root: ${audit.rawSessionRoot}
DSH session id: ${audit.dshSessionId}`
}

function initialSupervisorPrompt(task, audit, jobNumber) {
  return `You are the supervising agent for a cheaper DeepSeek Harness execution worker.
The worker has one persistent PowerShell tool and keeps the same conversation across instructions.
Plan and review; let the worker execute. Avoid repeating the full task or prior transcript in later instructions.
Return action=delegate with one self-contained first instruction. Use action=complete only if no worker action is needed, and abort only for an unsafe or impossible goal.
The coordinator lets the worker continue autonomously for nonterminal reports that do not request supervision. You will only receive reports that request judgment, detect possible drift or repeated non-progress, or claim a terminal outcome. Answer only what is needed. For a terminal report, verify the evidence and either delegate a focused correction/check, complete, or abort.
Every worker report is durably logged. When a report is insufficient, inconsistent, risky, or terminal, use read-only inspection of the workspace, coordinator log, or raw DSH JSONL session before deciding. Do not assume that a compact report contains every relevant detail.

Audit locations:
${auditInstructions(audit)}

User goal:
${task}

This is bridge job ${jobNumber}. Treat it as a new goal while retaining useful verified context from earlier jobs in this same workspace.`
}

function feedbackSupervisorPrompt(reports, audit, task) {
  return `These are all worker checkpoints since your previous decision, in chronological order:
${JSON.stringify(reports)}

Audit locations:
${auditInstructions(audit)}

Current user goal:
${task}

Use this current goal for acceptance checking. Inspect the workspace or raw session when the checkpoints leave a material gap, conflict, risk, or unsupported terminal claim. Decide the next state. Keep a delegated instruction short and do not repeat evidence the worker already has in its session.`
}

function recoverySupervisorPrompt(instruction, error, reports, audit) {
  return `The coordinator stopped while this DeepSeek instruction may have been partially executed:
${instruction}

Coordinator error:
${error || 'unknown'}

Unreviewed checkpoints before the interruption:
${JSON.stringify(reports)}

Audit locations:
${auditInstructions(audit)}

Do not assume the instruction is safe to repeat. Use read-only inspection when useful, then delegate one idempotent recovery/check instruction, complete if the goal is already satisfied, or abort if state cannot be established safely.`
}

function runUsage(run) {
  return run.events
    .filter(event => event.type === 'assistant/message' && event.data?.usage)
    .reduce((sum, event) => {
      const usage = event.data.usage
      return {
        inputTokens: sum.inputTokens + (usage.inputTokens ?? 0),
        outputTokens: sum.outputTokens + (usage.outputTokens ?? 0),
        totalTokens: sum.totalTokens + (usage.totalTokens ?? 0),
      }
    }, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
}

function addDshUsage(state, usage) {
  state.dshUsage = {
    inputTokens: (state.dshUsage?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (state.dshUsage?.outputTokens ?? 0) + usage.outputTokens,
    totalTokens: (state.dshUsage?.totalTokens ?? 0) + usage.totalTokens,
  }
}

function workerPrompt(instruction, { includeProtocol, startJob, runId, jobNumber, task, advisors, conversationName }) {
  const protocol = includeProtocol ? `桥接对话\nUnified DSH Bridge ${runId}\n\n${WORKER_PROTOCOL}\n\n` : ''
  const job = startJob ? `NEW BRIDGE JOB ${jobNumber}\nCURRENT USER GOAL:\n${task}\n\n` : ''
  return `${protocol}${job}${advisorProtocol(advisors, conversationName)}\n\nCOORDINATOR INSTRUCTION:\n${instruction}`
}

function finalReceiptPrompt(decision, jobNumber) {
  return `COORDINATOR FINAL RECEIPT FOR BRIDGE JOB ${jobNumber}
The coordinator decided ${decision.action.toUpperCase()}.
Reason: ${decision.rationale}
Do not perform more work for this job. Acknowledge the decision with one terminal JSON checkpoint using the established bridge envelope.`
}

function bridgeManagedDecision(state, resumeNote) {
  if (state.pendingInstruction) {
    return {
      action: 'delegate',
      instruction: `The prior process stopped while this instruction may have been partially executed: ${state.pendingInstruction}\nInspect current state before continuing and do not blindly repeat side effects.${resumeNote ? `\nHuman resume note: ${resumeNote}` : ''}`,
      rationale: 'Recover from the durable pending-instruction record.',
    }
  }
  if (state.status === 'waiting-user' && resumeNote?.trim()) {
    return {
      action: 'delegate',
      instruction: `Continue the current goal using this human answer or recovery context: ${resumeNote.trim()}`,
      rationale: 'The user supplied the information requested by the worker.',
    }
  }
  if (!state.lastWorkerReport) {
    return {
      action: 'delegate',
      instruction: 'Begin the current goal. Work autonomously and use the enabled ChatGPT adviser when the active-adviser policy requires it.',
      rationale: 'The selected advisers operate inside the persistent DSH worker session.',
    }
  }
  if (state.lastWorkerReport.terminal) {
    const needsChatgptReview = state.advisors.some(advisor => advisor.startsWith('chatgpt-'))
      && !state.lastWorkerReport.consultations?.some(consultation => consultation.advisor.startsWith('chatgpt-'))
    if (needsChatgptReview) {
      return {
        action: 'delegate',
        instruction: `Before completion, use one enabled ChatGPT transport to review the current result in "${state.chatgptConversationName}". Address material findings, then return a fresh terminal checkpoint whose consultations entry summarizes that final review.`,
        rationale: 'The recovered terminal checkpoint does not contain the required ChatGPT final review.',
      }
    }
    return {
      action: 'complete',
      instruction: '',
      rationale: state.lastWorkerReport.summary || 'The worker completed the goal after the required adviser review.',
    }
  }
  return {
    action: 'delegate',
    instruction: autonomousContinuationPrompt(state.lastWorkerReport),
    rationale: 'Continue from the last durable worker checkpoint.',
  }
}

async function groupWebSession(state) {
  if (!state.webVisible) return
  if (!existsSync(WEB_CONTROL_TOKEN_PATH)) {
    throw new Error(`Web bridge token is unavailable at ${WEB_CONTROL_TOKEN_PATH}; start Web with the bridge patch`)
  }
  const token = readFileSync(WEB_CONTROL_TOKEN_PATH, 'utf8').trim()
  const response = await fetch(state.webControlUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ workspace: state.workspace, sessionId: state.dshSessionId }),
    signal: AbortSignal.timeout(5000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Web bridge returned HTTP ${response.status}: ${text.slice(0, 500)}`)
  const value = JSON.parse(text)
  state.webWorkspaceId = value.workspaceId
  delete state.webGroupingError
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  validateOptions(options)
  if (options.help) {
    console.log(usage())
    return
  }

  mkdirSync(options.stateDir, { recursive: true })
  const statePath = join(options.stateDir, 'state.json')
  const eventsPath = join(options.stateDir, 'events.jsonl')
  const lockPath = join(options.stateDir, 'bridge.lock')
  let lockReleased = false
  const lockOwner = `${options.runId}:${process.pid}:${randomUUID()}`
  const releaseLaneLock = acquireProcessLock(lockPath, lockOwner, `bridge lane ${options.lane}`)

  const releaseLock = () => {
    if (lockReleased) return
    lockReleased = true
    releaseLaneLock()
  }
  process.once('exit', releaseLock)

  const prior = readState(statePath)
  if (options.resume && !prior) {
    releaseLock()
    throw new Error(`no saved run exists at ${statePath}`)
  }
  const terminalStatuses = ['completed', 'aborted', 'cycle-limit']
  if (options.resume && terminalStatuses.includes(prior.status)) {
    releaseLock()
    throw new Error(`saved run is already ${prior.status}`)
  }
  if (!options.resume && prior && !terminalStatuses.includes(prior.status)) {
    releaseLock()
    throw new Error(`bridge job is ${prior.status} at ${statePath}; use --resume before starting another job`)
  }
  if (prior && !options.workspaceExplicit) options.workspace = prior.workspace
  if (prior && resolve(prior.workspace).toLowerCase() !== resolve(options.workspace).toLowerCase()) {
    releaseLock()
    throw new Error(`saved bridge workspace is ${prior.workspace}, not ${options.workspace}`)
  }
  if (prior?.lane && prior.lane !== options.lane) {
    releaseLock()
    throw new Error(`saved bridge lane is ${prior.lane}, not ${options.lane}`)
  }
  if (prior?.codexThreadId && options.codexThreadId && prior.codexThreadId !== options.codexThreadId) {
    releaseLock()
    throw new Error(`saved bridge already uses Codex task ${prior.codexThreadId}`)
  }
  const task = options.task?.trim() || prior?.task
  if (!task) {
    releaseLock()
    throw new Error('the saved run has no task')
  }
  if (options.advisors.includes('codex') && !prior?.codexThreadId && !options.codexThreadId && options.selectCodexThread) {
    const discovery = new CodexAppServer({ cwd: options.workspace })
    try {
      await discovery.start()
      const selection = await askCodexThread(await discovery.listVisibleThreads(options.workspace))
      if (selection.kind === 'existing') {
        options.codexThreadId = selection.threadId
        options.codexThreadBinding = 'visible-existing'
      } else {
        options.codexThreadBinding = 'app-server-created'
      }
    } finally {
      await discovery.close()
    }
  }
  const startingNewJob = !options.resume
  const state = prepareBridgeState(prior, options, task, startingNewJob)
  state.codexThreadBinding ??= options.codexThreadBinding
  state.advisorHistory ??= []
  state.advisorHistory.push({ jobNumber: state.jobNumber, resumed: options.resume, advisors: state.advisors })
  saveState(statePath, state)

  const audit = {
    eventsPath,
    rawSessionRoot: join(state.dshHome, 'sessions'),
    dshSessionId: state.dshSessionId,
  }

  const usesCodex = state.advisors.includes('codex')
  const codex = usesCodex ? new CodexAppServer({ cwd: options.workspace }) : undefined
  let releaseCodexThreadLock = () => {}
  let deepSeekKey
  try {
    deepSeekKey = loadDeepSeekKey()
  } catch (error) {
    releaseLock()
    throw error
  }
  const harness = new DeepSeekHarness({
    dshBin: join(REPO_ROOT, 'apps', 'cli', 'lib', 'bin.js'),
    profile: 'sdk-minimal',
    patches: [
      join(SCRIPT_DIR, 'sdk-resume.patch.yml'),
      join(SCRIPT_DIR, 'compaction.patch.yml'),
      join(SCRIPT_DIR, 'session-label.patch.yml'),
      ...(state.advisors.some(advisor => advisor.startsWith('chatgpt-')) ? [join(SCRIPT_DIR, 'advisor-ui-lease.patch.yml')] : []),
      ...(state.advisors.includes('chatgpt-web') ? [join(SCRIPT_DIR, 'chatgpt-web.patch.yml')] : []),
      ...(state.advisors.includes('chatgpt-app') ? [join(SCRIPT_DIR, 'chatgpt-app.patch.yml')] : []),
      ...(state.webVisible ? [join(SCRIPT_DIR, 'web-visible.patch.yml')] : []),
    ],
    dshHome: state.dshHome,
    cwd: options.workspace,
    processCwd: REPO_ROOT,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: deepSeekKey,
      DSH_BRIDGE_SESSION_ID: state.dshSessionId,
      DSH_BRIDGE_SESSION_TITLE: `桥接对话 · ${state.lane}`,
      DSH_BRIDGE_LEASE_ID: `${state.runId}-${process.pid}`,
      DSH_BRIDGE_BROWSER_ENDPOINT: process.env.DSH_BRIDGE_BROWSER_ENDPOINT ?? 'http://127.0.0.1:9223',
    },
    provider: 'deepseek-official',
    model: options.dshModel,
    reasoningEffort: options.dshEffort,
    maxTokens: options.dshMaxTokens,
    initializeTimeoutMs: 30000,
  })

  try {
    console.log(`[bridge] run=${state.runId}`)
    console.log(`[bridge] job=${state.jobNumber}`)
    console.log(`[bridge] lane=${state.lane}`)
    console.log(`[bridge] advisers=${state.advisors.join(',')}`)
    console.log(`[bridge] workspace=${state.workspace}`)
    let decision
    let decisionSource = usesCodex ? 'codex' : 'bridge'
    if (!usesCodex) {
      decision = bridgeManagedDecision(state, options.resumeNote)
    } else {
      await codex.start()
      let createdSupervisor = !state.codexThreadId
      try {
        state.codexThreadId = await codex.openThread({
          threadId: state.codexThreadId,
          cwd: state.workspace,
          model: options.codexModel,
        })
      } catch (error) {
        if (!options.resume || !canReplaceUnstartedSupervisor(state, error)) throw error
        console.warn(`[bridge] replacing uninitialized supervisor task ${state.codexThreadId}`)
        state.codexThreadId = await codex.openThread({
          threadId: undefined,
          cwd: state.workspace,
          model: options.codexModel,
        })
        createdSupervisor = true
      }
      if (createdSupervisor) {
        await codex.request('thread/name/set', {
          threadId: state.codexThreadId,
          name: `Codex-DSH Supervisor: ${state.runId}`,
        })
        state.codexThreadBinding = 'app-server-created'
      }
      const threadLockName = createHash('sha256').update(state.codexThreadId).digest('hex')
      releaseCodexThreadLock = acquireProcessLock(
        join(homedir(), '.codex-dsh-bridge', 'codex-thread-locks', `${threadLockName}.lock`),
        lockOwner,
        `Codex task ${state.codexThreadId}`,
      )
      state.status = 'supervising'
      delete state.error
      saveState(statePath, state)
      console.log(`[bridge] supervisor thread=${state.codexThreadId}`)
      console.log(`[bridge] supervisor binding=${state.codexThreadBinding ?? 'saved-or-explicit'}`)
    }

    if (usesCodex && state.pendingInstruction) {
      decision = await codex.turn({
        threadId: state.codexThreadId,
        prompt: recoverySupervisorPrompt(state.pendingInstruction, state.error, state.unreviewedWorkerReports, audit),
        cwd: state.workspace,
        model: options.codexModel,
        effort: options.codexEffort,
      })
      state.unreviewedWorkerReports = []
      saveState(statePath, state)
    } else if (usesCodex && state.lastWorkerReport) {
      if (state.lastWorkerReport.terminal === false && state.lastWorkerReport.needsSupervisor === false) {
        decision = {
          action: 'delegate',
          instruction: autonomousContinuationPrompt(state.lastWorkerReport),
          rationale: 'Resuming the worker from its last safe autonomous checkpoint.',
        }
        decisionSource = 'bridge'
      } else {
        const reports = state.unreviewedWorkerReports.length > 0
          ? state.unreviewedWorkerReports
          : [{ cycle: state.cycles, report: state.lastWorkerReport }]
        decision = await codex.turn({
          threadId: state.codexThreadId,
          prompt: feedbackSupervisorPrompt(reports, audit, state.task),
          cwd: state.workspace,
          model: options.codexModel,
          effort: options.codexEffort,
        })
        state.unreviewedWorkerReports = []
        saveState(statePath, state)
      }
    } else if (usesCodex) {
      decision = await codex.turn({
        threadId: state.codexThreadId,
        prompt: initialSupervisorPrompt(task, audit, state.jobNumber),
        cwd: state.workspace,
        model: options.codexModel,
        effort: options.codexEffort,
      })
    }

    while (true) {
      appendEvent(eventsPath, { source: decisionSource, decision })
      if (decision.action === 'complete') {
        if (state.jobStarted) {
          const receipt = await harness.run(finalReceiptPrompt(decision, state.jobNumber), {
            sessionId: state.dshSessionId,
          })
          const usage = runUsage(receipt)
          addDshUsage(state, usage)
          appendEvent(eventsPath, {
            source: 'dsh-final-receipt',
            jobNumber: state.jobNumber,
            usage,
            report: normalizeWorkerResponse(receipt.finalResponse),
          })
        }
        state.status = 'completed'
        state.result = decision.rationale
        delete state.pendingInstruction
        saveState(statePath, state)
        console.log(`[bridge] COMPLETE: ${decision.rationale}`)
        break
      }
      if (decision.action === 'abort') {
        if (state.jobStarted) {
          const receipt = await harness.run(finalReceiptPrompt(decision, state.jobNumber), {
            sessionId: state.dshSessionId,
          })
          const usage = runUsage(receipt)
          addDshUsage(state, usage)
          appendEvent(eventsPath, {
            source: 'dsh-final-receipt',
            jobNumber: state.jobNumber,
            usage,
            report: normalizeWorkerResponse(receipt.finalResponse),
          })
        }
        state.status = 'aborted'
        state.result = decision.rationale
        delete state.pendingInstruction
        saveState(statePath, state)
        console.log(`[bridge] ABORT: ${decision.rationale}`)
        process.exitCode = 2
        break
      }
      if (decision.action !== 'delegate' || !decision.instruction?.trim()) {
        throw new Error(`invalid supervisor decision: ${JSON.stringify(decision)}`)
      }
      if (options.maxCycles !== undefined && state.cycles - state.jobCycleStart >= options.maxCycles) {
        state.status = 'cycle-limit'
        state.result = `Stopped after ${options.maxCycles} worker turns`
        saveState(statePath, state)
        console.log(`[bridge] STOPPED: ${state.result}`)
        process.exitCode = 3
        break
      }

      state.pendingInstruction = decision.instruction
      state.status = 'working'
      saveState(statePath, state)
      console.log(`[bridge] DSH turn ${state.cycles + 1}: ${decision.instruction.slice(0, 240)}`)
      const run = await harness.run(workerPrompt(decision.instruction, {
        includeProtocol: !state.workerProtocolSent,
        startJob: !state.jobStarted,
        runId: state.runId,
        jobNumber: state.jobNumber,
        task: state.task,
        advisors: state.advisors,
        conversationName: state.chatgptConversationName,
      }), {
        sessionId: state.dshSessionId,
      })
      const worker = normalizeWorkerResponse(run.finalResponse)
      const wakeSupervisor = routeWorkerReport(state, worker)
      const usage = runUsage(run)
      state.cycles += 1
      state.workerProtocolSent = true
      state.jobStarted = true
      state.lastWorkerReport = worker
      state.unreviewedWorkerReports.push({ cycle: state.cycles, report: worker })
      addDshUsage(state, usage)
      state.status = `worker:${worker.event}`
      delete state.pendingInstruction
      saveState(statePath, state)
      appendEvent(eventsPath, { source: 'dsh', cycle: state.cycles, usage, report: worker })
      console.log(`[bridge] DSH ${worker.event} (${usage.totalTokens} tokens): ${worker.summary || worker.question}`)

      if (state.webVisible) {
        try {
          await groupWebSession(state)
          saveState(statePath, state)
          console.log(`[bridge] Web workspace=${state.webWorkspaceId}`)
        } catch (error) {
          state.webGroupingError = error instanceof Error ? error.message : String(error)
          saveState(statePath, state)
          console.warn(`[bridge] Web grouping unavailable: ${state.webGroupingError}`)
        }
      }

      const missingChatgptFinalReview = worker.terminal
        && state.advisors.some(advisor => advisor.startsWith('chatgpt-'))
        && !worker.consultations.some(consultation => consultation.advisor.startsWith('chatgpt-'))
      if (missingChatgptFinalReview) {
        decision = {
          action: 'delegate',
          instruction: `Before completion, use one enabled ChatGPT transport to review the current result in "${state.chatgptConversationName}". Address material findings, then return a fresh terminal checkpoint whose consultations entry summarizes that final review.`,
          rationale: 'ChatGPT-enabled jobs require an auditable final adviser review.',
        }
        decisionSource = 'bridge'
        console.log('[bridge] requesting the required ChatGPT final review')
      } else if (wakeSupervisor) {
        if (usesCodex) {
          console.log(`[bridge] waking supervisor: ${worker.routingReason ?? (worker.terminal ? 'terminal report' : 'worker requested alignment')}`)
          const reports = state.unreviewedWorkerReports
          decision = await codex.turn({
            threadId: state.codexThreadId,
            prompt: feedbackSupervisorPrompt(reports, audit, state.task),
            cwd: state.workspace,
            model: options.codexModel,
            effort: options.codexEffort,
          })
          state.unreviewedWorkerReports = []
          saveState(statePath, state)
          decisionSource = 'codex'
        } else if (worker.terminal) {
          decision = bridgeManagedDecision(state, options.resumeNote)
          decisionSource = 'bridge'
        } else {
          state.status = 'waiting-user'
          state.result = worker.question || worker.summary || 'The worker needs human input.'
          saveState(statePath, state)
          console.log(`[bridge] WAITING FOR USER: ${state.result}`)
          process.exitCode = 4
          break
        }
      } else {
        decision = {
          action: 'delegate',
          instruction: autonomousContinuationPrompt(worker),
          rationale: 'The worker reported safe autonomous progress and does not need a new supervisor judgment.',
        }
        decisionSource = 'bridge'
        console.log(`[bridge] autonomous continuation: ${decision.instruction}`)
      }
    }
  } catch (error) {
    state.status = 'crashed'
    state.error = error instanceof Error ? error.message : String(error)
    saveState(statePath, state)
    throw error
  } finally {
    await Promise.allSettled([harness.close(), codex?.close()])
    releaseCodexThreadLock()
    releaseLock()
  }
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch(error => {
    console.error(`[bridge] ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exitCode = 1
  })
}
