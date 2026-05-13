import cron from 'node-cron'
import { runScrape, isRunning } from '../lib/orchestrator'

// Registers the recurring scrape job on Nitro startup. The interval is
// configured via SCRAPE_INTERVAL_MINUTES; 0 disables cron entirely so the
// user can run scrapes only from the "Scrapuj teraz" button.
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

  console.log(`[cron] scheduled scrape every ${minutes} minute(s)`)
  cron.schedule(expr, async () => {
    if (isRunning()) {
      console.log('[cron] previous run still active, skipping tick')
      return
    }
    try {
      const result = await runScrape()
      const totalNew = result.perSource.reduce((a, s) => a + s.newGroups, 0)
      const totalErr = result.perSource.reduce((a, s) => a + s.errors.length, 0)
      console.log(`[cron] scrape done — new groups: ${totalNew}, errors: ${totalErr}`)
    } catch (e) {
      console.error('[cron] scrape failed:', e)
    }
  })
})
