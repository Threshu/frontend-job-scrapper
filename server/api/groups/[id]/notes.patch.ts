import { useDb } from '../../../db'

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isFinite(id)) throw createError({ statusCode: 400, statusMessage: 'invalid id' })

  const body = await readBody<{ notes: string }>(event)
  if (typeof body?.notes !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'notes must be a string' })
  }

  const now = new Date().toISOString()
  const db = useDb()
  const r = db
    .prepare('UPDATE job_groups SET notes = ?, updated_at = ? WHERE id = ?')
    .run(body.notes, now, id)

  if (r.changes === 0) throw createError({ statusCode: 404, statusMessage: 'group not found' })
  return { ok: true }
})
