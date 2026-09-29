import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import {
  buildBridgeArgs,
  consultationResult,
  consultationTask,
  createServer,
  normalizeConsultationRequest,
} from './codex-chatgpt-mcp.mjs'

test('a Codex consultation requires an explicit stable lane', () => {
  assert.throws(() => normalizeConsultationRequest({ question: 'Review this.' }), /lane/)
  assert.throws(() => normalizeConsultationRequest({ question: 'Review this.', lane: 'Mixed Case' }), /lane/)
})

test('auto mode gives the Web attempt one isolated Codex lane', () => {
  const request = normalizeConsultationRequest({
    question: 'Check the proposed fix.',
    context: 'The failing test is deterministic.',
    lane: 'review-1',
    transport: 'auto',
    workspace: process.cwd(),
  })
  const args = buildBridgeArgs(request)
  assert.equal(args[args.indexOf('--lane') + 1], 'codex-review-1')
  assert.equal(args[args.indexOf('--advisors') + 1], 'chatgpt-web')
  assert.match(consultationTask(request), /Do not modify workspace files/)
  assert.match(consultationTask(request), /only the ChatGPT Web transport/)
})

test('Codex app presentation uses the isolated Web execution surface', () => {
  const request = normalizeConsultationRequest({
    question: 'Check the proposed fix.',
    lane: 'app-visible-1',
    transport: 'app',
    workspace: process.cwd(),
  })
  const args = buildBridgeArgs(request)
  assert.equal(args[args.indexOf('--advisors') + 1], 'chatgpt-web')
  assert.match(consultationTask(request), /isolated execution surface/)
})

test('the latest ChatGPT consultation is returned with its persistent identity', () => {
  assert.deepEqual(consultationResult({
    status: 'completed',
    dshSessionId: 'session-1',
    chatgptConversationName: '桥接对话 · repo · codex-review-1',
    lastWorkerReport: {
      summary: 'Fallback summary',
      consultations: [
        { advisor: 'chatgpt-web', conversation: 'first', answer: 'First answer' },
        { advisor: 'chatgpt-app', conversation: 'second', answer: 'Final answer' },
      ],
    },
  }), {
    answer: 'Final answer',
    advisor: 'chatgpt-app',
    conversation: 'second',
    status: 'completed',
    dshSessionId: 'session-1',
  })
})

test('a bridge response without an answer fails loudly', () => {
  assert.throws(() => consultationResult({ status: 'completed' }), /without a ChatGPT answer/)
})

test('the MCP server advertises one bounded consultation tool', async () => {
  const server = createServer()
  const client = new Client({ name: 'bridge-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const result = await client.listTools()
    assert.deepEqual(result.tools.map(tool => tool.name), ['consult_chatgpt'])
    assert.equal(result.tools[0].annotations.openWorldHint, true)
    assert.equal(result.tools[0].annotations.idempotentHint, false)
  } finally {
    await client.close()
    await server.close()
  }
})

test('the configured stdio entry point completes an MCP handshake', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(dirname(fileURLToPath(import.meta.url)), 'codex-chatgpt-mcp.mjs')],
    stderr: 'pipe',
  })
  const client = new Client({ name: 'stdio-bridge-test', version: '1.0.0' })
  await client.connect(transport)
  try {
    const result = await client.listTools()
    assert.deepEqual(result.tools.map(tool => tool.name), ['consult_chatgpt'])
  } finally {
    await client.close()
  }
})
