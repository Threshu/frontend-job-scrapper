import { useDb } from '../../../db'

const VALID = new Set(['new', 'interested', 'applied', 'replied', 'rejected', 'hidden'])

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isFinite(id)) throw createError({ statusCode: 400, statusMessage: 'invalid id' })

  const body = await readBody<{ status: string }>(event)
  if (!body?.status || !VALID.has(body.status)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid status' })
  }

  const now = new Date().toISOString()
  const appliedAt = body.status === 'applied' ? now : null
  const db = useDb()
  const r = db
    .prepare(
      `UPDATE job_groups
       SET status = ?, updated_at = ?, applied_at = CASE WHEN ? IS NOT NULL THEN ? ELSE applied_at END
       WHERE id = ?`,
    )
    .run(body.status, now, appliedAt, appliedAt, id)

  if (r.changes === 0) throw createError({ statusCode: 404, statusMessage: 'group not found' })
  return { ok: true }
})
