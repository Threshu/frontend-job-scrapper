import { useDb } from '../db'

// Returns the number of new groups created since the user's last visit and
// bumps the "last visit" timestamp. Used to drive the "X new offers" badge.
//
// Bump semantics: calling this endpoint marks the user as having seen the
// current set, so a second call right after returns 0. If the UI wants to
// PEEK without bumping, it can do so via the query param ?peek=1.
export default defineEventHandler((event) => {
  const q = getQuery(event)
  const peek = q.peek === '1' || q.peek === 'true'
  const db = useDb()

  const row = db.prepare<[], { value: string }>(
    "SELECT value FROM app_state WHERE key = 'last_visit_at'",
  ).get()
  const lastVisit = row?.value ?? new Date(0).toISOString()

  const count = (db.prepare<[string], { c: number }>(
    'SELECT COUNT(*) as c FROM job_groups WHERE created_at > ?',
  ).get(lastVisit)?.c) ?? 0

  if (!peek) {
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO app_state (key, value) VALUES ('last_visit_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(now)
  }

  return { count, since: lastVisit }
})
