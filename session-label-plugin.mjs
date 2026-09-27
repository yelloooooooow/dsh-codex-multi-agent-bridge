/** Give the dedicated bridge Session one durable, user-owned title. */

export const name = 'codex-dsh-bridge-session-label'
export const inject = ['sessionTitle']

export function apply(ctx) {
  const target = process.env.DSH_BRIDGE_SESSION_ID
  const title = process.env.DSH_BRIDGE_SESSION_TITLE || '桥接对话'
  if (!target) throw new Error('DSH_BRIDGE_SESSION_ID is required')
  ctx.on('session/created', (session) => {
    if (String(session.id) !== target) return
    if (ctx.sessionTitle.get(session)?.title === title) return
    ctx.sessionTitle.rename(session, title)
  })
}
