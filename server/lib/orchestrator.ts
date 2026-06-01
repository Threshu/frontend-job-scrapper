import type { Database } from 'better-sqlite3'
import { useDb } from '../db'
import { expireListings, recordScrapeRun, upsertListing } from '../db/repository'
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
  completed: OrchestratorRunResult['perSource']
  total: number
}

let _running: RunState | null = null

export function isRunning(): boolean {
  return _running !== null
}

export function currentRun(): { startedAt: string } | null {
  return _running ? { startedAt: _running.startedAt } : null
}

export function scrapeProgress(): {
  running: boolean
  startedAt: string | null
  total: number
  completed: OrchestratorRunResult['perSource']
} {
  if (!_running) return { running: false, startedAt: null, total: 0, completed: [] }
  return {
    running: true,
    startedAt: _running.startedAt,
    total: _running.total,
    completed: [..._running.completed],
  }
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
    if (out.closedIds?.length) expireListings(scraper.source, out.closedIds, db)
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

  const state: RunState = { promise: null as unknown as Promise<OrchestratorRunResult>, startedAt, abort, completed: [], total: selected.length }

  const promise = (async () => {
    const ctx: ScrapeContext = { signal: abort.signal, maxResults: opts.maxResultsPerSource }

    // Plain-fetch scrapers run in parallel; Playwright scrapers run sequentially
    // to avoid sharing the browser context across concurrent page floods.
    const normalScrapers = selected.filter((s) => !s.capabilities.needsBrowser)
    const browserScrapers = selected.filter((s) => s.capabilities.needsBrowser)

    const finish = (r: OrchestratorRunResult['perSource'][number]) => {
      state.completed.push(r)
      return r
    }

    const normalResults = await Promise.all(normalScrapers.map((s) => runOne(s, ctx, db).then(finish)))

    const browserResults: typeof normalResults = []
    for (const s of browserScrapers) {
      browserResults.push(await runOne(s, ctx, db).then(finish))
    }

    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      perSource: [...normalResults, ...browserResults],
    }
  })().finally(async () => {
    _running = null
    // Release Chromium between runs — keeping it alive pins ~100MB.
    if (isBrowserOpen()) await closeBrowser().catch(() => {})
  })

  state.promise = promise
  _running = state
  return promise
}

export function abortScrape(): void {
  _running?.abort.abort()
}
