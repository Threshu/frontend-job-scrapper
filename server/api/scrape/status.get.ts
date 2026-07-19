import { scrapeProgress } from '../../lib/orchestrator'

export default defineEventHandler((event) => {
  // Polled every 2s while scraping — must not be cached by browser / any
  // intermediate cache, otherwise the panel gets stuck on an old snapshot.
  setResponseHeader(event, 'Cache-Control', 'no-store, no-cache, must-revalidate')
  setResponseHeader(event, 'Pragma', 'no-cache')
  return scrapeProgress()
})
