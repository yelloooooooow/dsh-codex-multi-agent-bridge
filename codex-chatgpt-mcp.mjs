#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { workspaceRunId } from './bridge.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const BRIDGE_PATH = join(SCRIPT_DIR, 'bridge.mjs')
const BROWSER_SCRIPT = join(SCRIPT_DIR, 'ensure-chatgpt-browser.ps1')
const OUTPUT_LIMIT = 64 * 1024
const REQUEST_ENV = 'DSH_CODEX_CHATGPT_REQUEST'

const TRANSPORT_ADVISORS = {
  web: 'chatgpt-web',
  app: 'chatgpt-web',
  auto: 'chatgpt-web',
}

/**
 * Validate and normalize one Codex consultation request.
 * @param {unknown} input Untrusted MCP tool arguments.
 * @returns {{question: string, context: string, lane: string, transport: keyof typeof TRANSPORT_ADVISORS, workspace: string, timeoutMs: number}} Resolved request.
 */
export function normalizeConsultationRequest(input) {
  const value = input && typeof input === 'object' ? input : {}
  const question = typeof value.question === 'string' ? value.question.trim() : ''
  if (!question) throw new Error('question must not be empty')
  const context = typeof value.context === 'string' ? value.context.trim() : ''
  if (question.length + context.length > 12000) {
    throw new Error('question and context must total at most 12000 characters')
  }
  const lane = typeof value.lane === 'string' ? value.lane.trim().toLowerCase() : ''
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(lane)) {
    throw new Error('lane must be 1-63 lowercase letters, numbers, dots, underscores, or hyphens')
  }
  const transport = value.transport ?? 'auto'
  if (!Object.hasOwn(TRANSPORT_ADVISORS, transport)) throw new Error('transport must be web, app, or auto')
  const workspace = resolve(typeof value.workspace === 'string' && value.workspace.trim() ? value.workspace : process.cwd())
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`workspace is not a directory: ${workspace}`)
  }
  const timeoutMinutes = value.timeout_minutes ?? 20
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 60) {
    throw new Error('timeout_minutes must be an integer from 1 through 60')
  }
  return { question, context, lane, transport, workspace, timeoutMs: timeoutMinutes * 60_000 }
}

/**
 * Build the bridge task while keeping copied context deliberately small.
 * @param {{question: string, context: string, transport: string}} request Consultation request.
 * @returns {string} DSH relay instruction.
 */
export function consultationTask(request) {
  const preferred = request.transport === 'app'
    ? 'Use ChatGPT Web as the isolated execution surface; the caller records Windows app as the requested presentation surface.'
    : 'Use only the ChatGPT Web transport.'
  return `This is a Codex-requested adviser consultation. Do not modify workspace files and do not perform unrelated work.
Continue the named ChatGPT conversation assigned by the bridge. Send one focused message containing the question and only the supplied context. Wait for the complete response and read it before replying. ${preferred}
Return one terminal checkpoint. Put a faithful, self-contained answer in summary and record the consultation. Do not ask ChatGPT for an additional review of its own answer.

QUESTION:
${request.question}${request.context ? `\n\nMINIMUM CONTEXT FROM CODEX:\n${request.context}` : ''}`
}

/**
 * Build child-process arguments for a consultation lane.
 * @param {ReturnType<typeof normalizeConsultationRequest>} request Resolved request.
 * @returns {string[]} Bridge command arguments after the Node executable.
 */
export function buildBridgeArgs(request) {
  return [
    BRIDGE_PATH,
    '--task-env', REQUEST_ENV,
    '--workspace', request.workspace,
    '--lane', `codex-${request.lane}`,
    '--advisors', TRANSPORT_ADVISORS[request.transport],
    '--dsh-effort', 'low',
    '--dsh-max-tokens', '4096',
    '--web-visible',
  ]
}

function appendBounded(current, chunk) {
  const next = current + chunk.toString('utf8')
  return next.length <= OUTPUT_LIMIT ? next : next.slice(-OUTPUT_LIMIT)
}

async function runChild(command, args, options) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout = appendBounded(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = appendBounded(stderr, chunk) })
    const timer = setTimeout(() => {
      child.kill()
      rejectPromise(new Error(`process timed out after ${Math.round(options.timeoutMs / 60000)} minutes`))
    }, options.timeoutMs)
    child.once('error', error => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code, signal, stdout, stderr })
    })
  })
}

async function ensureWebBrowser(timeoutMs) {
  const result = await runChild('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', BROWSER_SCRIPT,
  ], {
    cwd: SCRIPT_DIR,
    env: process.env,
    timeoutMs: Math.min(timeoutMs, 60_000),
  })
  if (result.code !== 0) {
    throw new Error(`ChatGPT browser startup failed: ${(result.stderr || result.stdout).trim().slice(-2000)}`)
  }
}

/**
 * Select the compact answer returned to Codex from persisted bridge state.
 * @param {Record<string, unknown>} state Parsed bridge state.
 * @returns {{answer: string, advisor: string, conversation: string, status: string, dshSessionId: string}} Tool result.
 */
export function consultationResult(state) {
  const report = state?.lastWorkerReport
  const consultations = Array.isArray(report?.consultations) ? report.consultations : []
  const consultation = [...consultations].reverse().find(item => String(item?.advisor ?? '').startsWith('chatgpt-'))
  const answer = String(consultation?.answer || report?.summary || state?.result || '').trim()
  if (!answer) throw new Error('the bridge completed without a ChatGPT answer')
  return {
    answer,
    advisor: String(consultation?.advisor || ''),
    conversation: String(consultation?.conversation || state?.chatgptConversationName || ''),
    status: String(state?.status || ''),
    dshSessionId: String(state?.dshSessionId || ''),
  }
}

async function consultWeb(request) {
  await ensureWebBrowser(request.timeoutMs)
  const bridgeLane = `codex-${request.lane}`
  const statePath = join(homedir(), '.codex-dsh-bridge', workspaceRunId(request.workspace, bridgeLane), 'state.json')
  const result = await runChild(process.execPath, buildBridgeArgs(request), {
    cwd: SCRIPT_DIR,
    env: { ...process.env, [REQUEST_ENV]: consultationTask(request) },
    timeoutMs: request.timeoutMs,
  })
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(-4000)
    throw new Error(`bridge consultation failed (code=${String(result.code)}, signal=${String(result.signal)}): ${detail}`)
  }
  if (!existsSync(statePath)) throw new Error(`bridge state was not written: ${statePath}`)
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  return {
    ...consultationResult(state),
    lane: request.lane,
    transportRequested: request.transport,
    deliverySurface: request.transport === 'app' ? 'web-synced-to-windows-app' : 'web',
    note: request.transport === 'app'
      ? 'The unified desktop app hosts the active Codex turn, so this request used the isolated Web surface. With the same ChatGPT account, the persistent cloud conversation and transcript are visible in the Windows app.'
      : 'Reuse this lane for later consultations in the same Codex conversation. The full UI trace remains in the DSH Session log.',
  }
}

/**
 * Run one persistent ChatGPT consultation for Codex.
 * @param {unknown} input MCP tool arguments.
 * @returns {Promise<Record<string, unknown>>} Compact answer and audit identifiers.
 */
export async function consultChatGPT(input) {
  const request = normalizeConsultationRequest(input)
  return await consultWeb(request)
}

export function createServer() {
  const server = new McpServer({ name: 'dsh-codex-chatgpt-advisor', version: '0.2.0' }, {
    instructions: 'Use consult_chatgpt when another ChatGPT judgment would materially reduce uncertainty. Reuse one explicit lane per Codex conversation and send only the minimum necessary context.',
  })
  server.registerTool('consult_chatgpt', {
    title: 'Consult ChatGPT',
    description: 'Ask a persistent named ChatGPT conversation and return its answer. Choose one stable lane for this Codex conversation; different lanes remain isolated. App mode uses the independent Web execution surface and syncs the same cloud conversation to the Windows app.',
    inputSchema: z.object({
      question: z.string().min(1).describe('One focused question for ChatGPT.'),
      context: z.string().optional().describe('Only the minimum verified facts and evidence ChatGPT needs.'),
      lane: z.string().min(1).describe('Stable lowercase lane for this Codex conversation, such as code-review-1.'),
      transport: z.enum(['web', 'app', 'auto']).default('auto').describe('ChatGPT presentation route. App keeps the active Codex window untouched and syncs the Web conversation to the Windows app.'),
      workspace: z.string().optional().describe('Absolute workspace path. Defaults to the MCP server working directory.'),
      timeout_minutes: z.number().int().min(1).max(60).default(20),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async args => {
    try {
      const result = await consultChatGPT(args)
      return {
        content: [{ type: 'text', text: result.answer }],
        structuredContent: result,
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }
    }
  })
  return server
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
