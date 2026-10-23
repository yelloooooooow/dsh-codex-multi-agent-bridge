#!/usr/bin/env node
/** Opt-in CLI for registered Web-owned DSH Sessions; importing this file starts nothing. */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { WorkflowController, readJson } from './workflow-control.mjs'

/** Use the existing local browser credential with the Harness BrowserAuth wire format. */
export function createWebRpc({ baseUrl = 'http://127.0.0.1:3080', credentialPath = join(homedir(), '.dsh', '.credentials.yaml'), timeoutMs = 30000 } = {}) {
  const url = new URL(baseUrl)
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('DSH Web RPC must use a loopback origin')
  return async (endpoint, args) => {
    if (!/^goals\/(get|create|edit|pause|resume)$/.test(endpoint)) throw new Error('Unsupported workflow RPC')
    const store = yaml.load(readFileSync(credentialPath, 'utf8'))
    const credential = store?.records?.['client-connection/browser-session']?.payload
    const secret = Buffer.from(credential?.secret ?? '', 'base64url')
    if (credential?.version !== 1 || secret.length !== 32) throw new Error('Unsupported existing BrowserAuth credential; refresh Harness login')
    const issuedAt = Date.now()
    const body = Buffer.from(JSON.stringify({ version: 1, authority: url.host, issuedAt, expiresAt: issuedAt + 3600000 })).toString('base64url')
    const signature = createHmac('sha256', secret).update(body).digest('base64url')
    const cookieName = `dsh-auth-${createHash('sha256').update(url.host).digest('base64url')}`
    const rpcId = randomUUID()
    const response = await fetch(`${url.origin}/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: `${cookieName}=v1.${body}.${signature}` },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    })
    if (!response.ok) throw new Error(`DSH Web RPC ${endpoint}: HTTP ${response.status}`)
    const value = await response.json()
    if (value.rpcId !== rpcId || !value.result?.ok) throw new Error(`DSH Web RPC ${endpoint} rejected; inspect host diagnostics`)
    return value.result.value ?? null
  }
}

/** Run a trusted configured transport adapter with JSON stdin, no shell or visible window. */
export function runAdapter(adapter, packet) {
  if (!Array.isArray(adapter?.command) || !adapter.command.length || !adapter.command.every(x => typeof x === 'string')) throw new Error('Adapter requires command argv')
  return new Promise((done, fail) => {
    const child = spawn(adapter.command[0], adapter.command.slice(1), { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', settled = false
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? fail(error) : done(value) }
    const timer = setTimeout(() => { child.kill(); finish(new Error('Adapter deadline exceeded; delivery may be uncertain')) }, adapter.timeoutMs ?? 30000)
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8')
      if (Buffer.byteLength(output) > 65536) { child.kill(); finish(new Error('Adapter output exceeded 64KiB')) }
    })
    child.stderr.resume() // Adapter owns private diagnostics; never echo credentials or raw logs.
    child.stdin.on('error', error => finish(error))
    child.once('error', error => finish(error))
    child.once('close', code => {
      if (code !== 0) { finish(new Error('Adapter exited unsuccessfully')); return }
      try { finish(null, JSON.parse(output)) } catch { finish(new Error('Adapter returned invalid JSON')) }
    })
    child.stdin.end(JSON.stringify(packet))
  })
}

function options(argv) {
  const result = { action: argv[0] }
  for (let i = 1; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error('Expected named argument')
    const key = argv[i].slice(2)
    if (['analyzed', 'saved-only', 'full'].includes(key)) result[key] = true
    else { if (++i === argv.length) throw new Error(`Missing --${key} value`); result[key] = argv[i] }
  }
  return result
}

/** Execute one CLI operation; configuration never creates a Session or starts a model by itself. */
export async function main(argv = process.argv.slice(2)) {
  const o = options(argv)
  if (!o.config) throw new Error('Use --config <local workflow JSON>; see examples/workflow.config.json')
  const configPath = resolve(o.config)
  const config = readJson(configPath)
  config.workspace = resolve(dirname(configPath), config.workspace)
  config.stateDir = resolve(dirname(configPath), config.stateDir)
  if (config.analysisNoticeAfterMs !== undefined && (!Number.isSafeInteger(config.analysisNoticeAfterMs) || config.analysisNoticeAfterMs < 1000)) throw new Error('analysisNoticeAfterMs must be >=1000')
  const controller = new WorkflowController(config, createWebRpc(config.web))
  const output = value => console.log(JSON.stringify(value))
  const pending = () => {
    let files
    try { files = readdirSync(controller.path('outbox')).filter(x => x.endsWith('.json')) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    return files.map(file => readJson(controller.path('outbox', file)))
  }
  const tick = async () => {
    const workerResults = await Promise.allSettled(Object.keys(config.workers).map(async worker => ({ worker, ...await controller.tick(worker) })))
    const results = workerResults.map((r, i) => r.status === 'fulfilled' ? r.value : { worker: Object.keys(config.workers)[i], status: 'ERROR', error: r.reason.message })
    if (config.deliveryAdapter) {
      // One sender per tick; a real refusal/unknown health prevents model-facing delivery.
      const all = pending()
      const row = all.find(r => ['QUEUED', 'NOT_SENT'].includes(r.transportStatus))
        ?? (config.analysisNoticeAfterMs ? all.find(r => r.analysisStatus !== 'ANALYZED' && !r.notice && ['ACCEPTED', 'RECEIVED', 'SENDING', 'UNCERTAIN'].includes(r.transportStatus)
          && Date.now() - Date.parse(r.acceptedAt ?? r.sendStartedAt ?? '') >= config.analysisNoticeAfterMs) : null)
      if (row) {
        try {
          const health = await runAdapter(config.deliveryAdapter, { operation: 'probe' })
          if (health.allowed === true) {
            const send = packet => runAdapter(config.deliveryAdapter, { operation: 'send', ...packet })
            const receipt = ['QUEUED', 'NOT_SENT'].includes(row.transportStatus)
              ? await controller.deliver(row.deliveryId, send)
              : await controller.remind(row.deliveryId, send, { graceMs: config.analysisNoticeAfterMs })
            results.push({ deliveryId: row.deliveryId, status: receipt.transportStatus ?? receipt.status, analysisStatus: receipt.analysisStatus })
          } else results.push({ deliveryId: row.deliveryId, status: 'DELIVERY_BLOCKED', reason: health.reason ?? 'Quota, approval, service or bridge availability unconfirmed' })
        } catch (error) { results.push({ status: 'DELIVERY_PROBE_FAILED', error: error.message }) }
      }
    }
    return results
  }
  if (o.action === 'dispatch') output(await controller.dispatch(o.worker, o.id, readFileSync(resolve(o.file), 'utf8'), { resume: !o['saved-only'] }))
  else if (o.action === 'wait') output(await controller.wait(o.worker, o.job, { path: o.file, kind: o.kind ?? 'created', ...(o['run-id'] ? { runId: o['run-id'] } : {}) }))
  else if (o.action === 'compact') output(await controller.compact(o.worker, readJson(resolve(o.file))))
  else if (o.action === 'publish') output(await controller.publish(o.worker, o.job, o.event, o.file))
  else if (o.action === 'ack') output(await controller.acknowledge(o.id, { analyzed: o.analyzed, reviewPath: o.review, nextAction: o.next }))
  else if (o.action === 'inspect') output({ workers: await Promise.all(Object.keys(config.workers).map(async worker => {
    const goal = await controller.goal(worker)
    return { worker, goal: o.full || !goal ? goal : { id: goal.id, revision: goal.revision, phase: goal.phase, activation: goal.activation, roundsStarted: goal.roundsStarted, objectiveChars: goal.objective?.length }, local: readJson(controller.path('workers', `${worker}.json`)) }
  })), pending: pending().filter(r => r.analysisStatus !== 'ANALYZED').map(({ deliveryId, jobId, event, transportStatus, analysisStatus, reportPath }) => ({ deliveryId, jobId, event, transportStatus, analysisStatus, reportPath })) })
  else if (o.action === 'tick') output(await tick())
  else if (o.action === 'watch') {
    const interval = Number(o['interval-ms'] ?? 30000)
    if (!Number.isSafeInteger(interval) || interval < 1000) throw new Error('interval-ms must be >=1000')
    // One persistent watcher per state directory; no model calls during unchanged waits.
    const { withLock } = await import('./workflow-control.mjs')
    await withLock(controller.path('watcher.lock'), async () => {
      let previous = ''
      while (true) {
        let result
        try { result = await tick() } catch (error) { result = [{ status: 'WATCH_ERROR', error: error.message }] }
        const encoded = JSON.stringify(result)
        if (encoded !== previous) { console.log(encoded); previous = encoded }
        await new Promise(done => setTimeout(done, interval))
      }
    })
  } else throw new Error('Use dispatch, wait, compact, publish, ack, inspect, tick or watch')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
