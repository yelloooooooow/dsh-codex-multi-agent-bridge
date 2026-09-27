/** Cross-process leases for multi-call ChatGPT UI consultations. */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'bridge-advisor-ui-lease'
export const inject = ['tools', 'session']

const CHANNELS = new Set(['web', 'app'])
const ROOT = join(homedir(), '.codex-dsh-bridge', 'ui-leases')
const HOLDER = process.env.DSH_BRIDGE_LEASE_ID || `bridge-${process.pid}`

function lockPath(channel) {
  if (!CHANNELS.has(channel)) throw new Error('channel must be web or app')
  return join(ROOT, `${channel}.lock`)
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

function currentLock(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    const value = JSON.parse(raw)
    return { raw, value }
  } catch {
    return undefined
  }
}

function removeDeadLock(path) {
  const observed = currentLock(path)
  if (observed?.value?.pid && processIsAlive(observed.value.pid)) return false
  try {
    if (observed && readFileSync(path, 'utf8') !== observed.raw) return false
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

function wait(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(signal.reason)
      return
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', aborted, { once: true })
    function done() {
      signal.removeEventListener('abort', aborted)
      resolvePromise()
    }
    function aborted() {
      clearTimeout(timer)
      rejectPromise(signal.reason)
    }
  })
}

export function apply(ctx) {
  mkdirSync(ROOT, { recursive: true })
  const held = new Map()

  async function acquire(channel, timeoutSeconds, signal) {
    if (held.has(channel)) return { channel, acquired: true, holder: HOLDER, reused: true }
    const path = lockPath(channel)
    const deadline = Date.now() + timeoutSeconds * 1000
    while (true) {
      signal.throwIfAborted()
      try {
        const descriptor = openSync(path, 'wx')
        try {
          writeFileSync(descriptor, `${JSON.stringify({ holder: HOLDER, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`)
        } finally {
          closeSync(descriptor)
        }
        held.set(channel, path)
        return { channel, acquired: true, holder: HOLDER, reused: false }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        removeDeadLock(path)
        if (Date.now() >= deadline) throw new Error(`timed out waiting for the shared ChatGPT ${channel} UI lease`)
        await wait(500, signal)
      }
    }
  }

  function release(channel) {
    const path = held.get(channel)
    if (!path) return { channel, released: false }
    const lock = currentLock(path)
    if (lock?.value?.holder === HOLDER && existsSync(path)) unlinkSync(path)
    held.delete(channel)
    return { channel, released: true }
  }

  const channelSchema = {
    type: 'object',
    properties: { channel: { type: 'string', enum: ['web', 'app'] } },
    required: ['channel'],
    additionalProperties: false,
  }
  const resultSchema = {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      acquired: { type: 'boolean' },
      released: { type: 'boolean' },
      holder: { type: 'string' },
      reused: { type: 'boolean' },
    },
    required: ['channel'],
    additionalProperties: true,
  }
  const output = {
    schema: resultSchema,
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
  ctx.tools.register({
    name: 'bridge_advisor_acquire',
    description: 'Acquire the cross-process lease before a complete multi-call ChatGPT Web or Windows app consultation.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['web', 'app'] },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 1800 },
      },
      required: ['channel'],
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      const channel = String(args.channel)
      if (!CHANNELS.has(channel)) throw new Error('channel must be web or app')
      const timeoutSeconds = Number.isSafeInteger(args.timeoutSeconds) ? args.timeoutSeconds : 300
      return acquire(channel, timeoutSeconds, exec.signal)
    },
  })
  ctx.tools.register({
    name: 'bridge_advisor_release',
    description: 'Release a ChatGPT UI lease after the complete consultation response has been read.',
    parameters: channelSchema,
    output,
    async execute(args) {
      return release(String(args.channel))
    },
  })
  ctx.on('tools/execute', async (exec, next) => {
    const channel = exec.name.startsWith('mcp__playwright-mcp__')
      ? 'web'
      : exec.name.startsWith('cua_driver_native__') ? 'app' : undefined
    if (channel && !held.has(channel)) {
      throw new Error(`acquire the ${channel} adviser lease before using ${exec.name}`)
    }
    return next()
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'turn/end') return
    for (const channel of [...held.keys()]) release(channel)
  }, { global: true })
  ctx.on('session/disposed', () => {
    for (const channel of [...held.keys()]) release(channel)
  }, { global: true })
  ctx.effect(() => () => {
    for (const channel of [...held.keys()]) release(channel)
  }, 'bridge-advisor-ui-lease.cleanup')
}
