import cron from 'node-cron'
import { runScrape, isRunning } from '../lib/orchestrator'
import { SCRAPERS } from '../scrapers'
import { useDb } from '../db'

// Registers the recurring scrape job on Nitro startup. The tick interval is
// configured via SCRAPE_INTERVAL_MINUTES; 0 disables cron entirely so the
// user can run scrapes only from the "Scrapuj teraz" button.
// Per-scraper `cronIntervalMinutes` acts as a minimum cadence: on every tick
// we run only scrapers whose last successful run is older than their interval.
export default defineNitroPlugin(() => {
  const config = useRuntimeConfig()
  const minutes = Number(config.scrapeIntervalMinutes ?? 30)
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.log('[cron] disabled (SCRAPE_INTERVAL_MINUTES <= 0)')
    return
  }

  const expr = `*/${minutes} * * * *`
  if (!cron.validate(expr)) {
    console.warn(`[cron] invalid expression "${expr}", cron disabled`)
    return
  }

  function getDueSources(defaultMinutes: number): string[] {
    const db = useDb()
    const rows = db
      .prepare(`SELECT source, MAX(started_at) AS last_at FROM scrape_runs GROUP BY source`)
      .all() as Array<{ source: string; last_at: string | null }>
    const lastMap = new Map<string, number>()
    for (const r of rows) if (r.last_at) lastMap.set(r.source, new Date(r.last_at).getTime())

    const now = Date.now()
    // Small slack so a "60 min" scraper that ran 59:59 ago still fires on this
    // tick instead of waiting a full extra interval.
    const SCHEDULING_SLACK_MS = 15_000
    return SCRAPERS.filter((s) => {
      const interval = (s.cronIntervalMinutes ?? defaultMinutes) * 60_000
      const last = lastMap.get(s.source)
      if (last === undefined) return true
      return now - last >= interval - SCHEDULING_SLACK_MS
    }).map((s) => s.source)
  }

  console.log(`[cron] tick every ${minutes} minute(s); per-scraper intervals honored`)
  cron.schedule(expr, async () => {
    if (isRunning()) {
      console.log('[cron] previous run still active, skipping tick')
      return
    }
    const due = getDueSources(minutes)
    if (due.length === 0) {
      console.log('[cron] no sources due on this tick')
      return
    }
    try {
      const result = await runScrape({ sources: due })
      const totalNew = result.perSource.reduce((a, s) => a + s.newGroups, 0)
      const totalErr = result.perSource.reduce((a, s) => a + s.errors.length, 0)
      console.log(`[cron] scraped ${due.join(', ')} — new groups: ${totalNew}, errors: ${totalErr}`)
    } catch (e) {
      console.error('[cron] scrape failed:', e)
    }
  })
})
