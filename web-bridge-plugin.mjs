/** Loopback-only control route that assigns bridge Sessions to Web Workspaces. */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'codex-dsh-web-bridge'
export const inject = ['webServer', 'workspaceRegistry']

const ROUTE = '/api/codex-dsh-bridge'
const TOKEN_PATH = join(homedir(), '.codex-dsh-bridge', 'web-control-token')
const MAX_BODY_BYTES = 64 * 1024

function controlToken() {
  mkdirSync(dirname(TOKEN_PATH), { recursive: true })
  if (!existsSync(TOKEN_PATH)) {
    try {
      writeFileSync(TOKEN_PATH, `${randomBytes(32).toString('base64url')}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (!existsSync(TOKEN_PATH)) throw error
    }
  }
  const token = readFileSync(TOKEN_PATH, 'utf8').trim()
  if (!token) throw new Error(`bridge control token is empty: ${TOKEN_PATH}`)
  return token
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function tokenMatches(actual, expected) {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function sendJson(response, status, value) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(value))
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      request.resume()
      return undefined
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

function parseBody(text) {
  try {
    const value = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return undefined
    const { workspace, sessionId } = value
    if (typeof workspace !== 'string' || workspace.length === 0) return undefined
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    return { workspace, sessionId }
  } catch {
    return undefined
  }
}

export function apply(ctx) {
  const expectedToken = controlToken()
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    async handler(request, response) {
      if (!isLoopback(request.socket.remoteAddress)) {
        sendJson(response, 403, { error: 'loopback access required' })
        return
      }
      const authorization = String(request.headers.authorization ?? '')
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      if (!tokenMatches(token, expectedToken)) {
        sendJson(response, 401, { error: 'invalid bridge token' })
        return
      }
      if (request.method === 'GET') {
        sendJson(response, 200, { ready: true })
        return
      }
      if (request.method !== 'POST') {
        response.statusCode = 405
        response.setHeader('allow', 'GET, POST')
        response.end()
        return
      }
      const body = await readBody(request)
      const parsed = body === undefined ? undefined : parseBody(body)
      if (parsed === undefined) {
        sendJson(response, body === undefined ? 413 : 400, { error: 'expected workspace and sessionId strings' })
        return
      }
      try {
        const workspace = await ctx.workspaceRegistry.resolveByPath(parsed.workspace)
          ?? await ctx.workspaceRegistry.create(parsed.workspace)
        await workspace.attachSession(parsed.sessionId)
        sendJson(response, 200, { workspaceId: String(workspace.id), title: workspace.title })
      } catch (error) {
        sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `codex-dsh-bridge: ${ROUTE}`)
}
