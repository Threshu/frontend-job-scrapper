import { useDb } from '../../db'
import { isRunning, currentRun } from '../../lib/orchestrator'

interface RunRow {
  id: number
  source: string
  started_at: string
  finished_at: string | null
  status: string
  fetched_count: number
  new_count: number
  error_message: string | null
}

export default defineEventHandler(() => {
  const db = useDb()
  const recent = db
    .prepare<[], RunRow>('SELECT * FROM scrape_runs ORDER BY started_at DESC LIMIT 20')
    .all()
  return {
    running: isRunning(),
    current: currentRun(),
    recent,
  }
})
