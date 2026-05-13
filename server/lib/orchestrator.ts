import type { Database } from 'better-sqlite3'
import { useDb } from '../db'
import { recordScrapeRun, upsertListing } from '../db/repository'
import { SCRAPERS } from '../scrapers'
import type { JobScraper, ScrapeContext } from '../scrapers/types'
import { closeBrowser, isBrowserOpen } from './browser'

export interface OrchestratorRunResult {
  startedAt: string
  finishedAt: string
  perSource: Array<{
    source: string
    fetched: number
    newListings: number
    newGroups: number
    errors: string[]
  }>
}

interface RunState {
  promise: Promise<OrchestratorRunResult>
  startedAt: string
  abort: AbortController
}

let _running: RunState | null = null

export function isRunning(): boolean {
  return _running !== null
}

export function currentRun(): { startedAt: string } | null {
  return _running ? { startedAt: _running.startedAt } : null
}

async function runOne(
  scraper: JobScraper,
  ctx: ScrapeContext,
  db: Database,
): Promise<OrchestratorRunResult['perSource'][number]> {
  const result = { source: scraper.source, fetched: 0, newListings: 0, newGroups: 0, errors: [] as string[] }
  try {
    const out = await scraper.scrape(ctx)
    result.fetched = out.jobs.length
    result.errors.push(...out.errors)
    const insert = db.transaction((jobs: typeof out.jobs) => {
      for (const j of jobs) {
        const r = upsertListing(j, db)
        if (r.isNewListing) result.newListings++
        if (r.isNewGroup) result.newGroups++
      }
    })
    insert(out.jobs)
    recordScrapeRun(scraper.source, 'ok', result.fetched, result.newListings, result.errors.length ? result.errors.join('\n') : null, db)
  } catch (e) {
    const msg = (e as Error).message
    result.errors.push(msg)
    recordScrapeRun(scraper.source, 'error', 0, 0, msg, db)
  }
  return result
}

export function runScrape(opts: { sources?: string[]; maxResultsPerSource?: number } = {}): Promise<OrchestratorRunResult> {
  if (_running) return _running.promise

  const startedAt = new Date().toISOString()
  const abort = new AbortController()
  const db = useDb()

  const selected = SCRAPERS.filter((s) => !opts.sources || opts.sources.includes(s.source))

  const promise = (async () => {
    const ctx: ScrapeContext = { signal: abort.signal, maxResults: opts.maxResultsPerSource }
    const perSource = await Promise.all(selected.map((s) => runOne(s, ctx, db)))
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      perSource,
    }
  })().finally(async () => {
    _running = null
    // Release Chromium between runs — keeping it alive pins ~100MB.
    if (isBrowserOpen()) await closeBrowser().catch(() => {})
  })

  _running = { promise, startedAt, abort }
  return promise
}

export function abortScrape(): void {
  _running?.abort.abort()
}
