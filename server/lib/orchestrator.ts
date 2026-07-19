import type { Database } from 'better-sqlite3'
import { useDb } from '../db'
import { expireListings, pruneScrapeRuns, recordScrapeRun, upsertListing } from '../db/repository'
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
    durationMs: number
  }>
}

interface RunState {
  promise: Promise<OrchestratorRunResult>
  startedAt: string
  abort: AbortController
  completed: OrchestratorRunResult['perSource']
  total: number
}

interface LastRun {
  startedAt: string
  finishedAt: string
  total: number
  completed: OrchestratorRunResult['perSource']
}

let _running: RunState | null = null
// Snapshot of the most recently completed run, kept so clients that were not
// polling during the run (fresh tab / reload after finish) can still see the
// summary panel. Cleared when a new run starts.
let _last: LastRun | null = null

export function isRunning(): boolean {
  return _running !== null
}

export function currentRun(): { startedAt: string } | null {
  return _running ? { startedAt: _running.startedAt } : null
}

export function scrapeProgress(): {
  running: boolean
  startedAt: string | null
  finishedAt: string | null
  total: number
  completed: OrchestratorRunResult['perSource']
} {
  if (_running) {
    return {
      running: true,
      startedAt: _running.startedAt,
      finishedAt: null,
      total: _running.total,
      completed: [..._running.completed],
    }
  }
  if (_last) {
    return {
      running: false,
      startedAt: _last.startedAt,
      finishedAt: _last.finishedAt,
      total: _last.total,
      completed: _last.completed,
    }
  }
  return { running: false, startedAt: null, finishedAt: null, total: 0, completed: [] }
}

async function runOne(
  scraper: JobScraper,
  ctx: ScrapeContext,
  db: Database,
): Promise<OrchestratorRunResult['perSource'][number]> {
  const t0 = Date.now()
  const result = { source: scraper.source, fetched: 0, newListings: 0, newGroups: 0, errors: [] as string[], durationMs: 0 }
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
  result.durationMs = Date.now() - t0
  return result
}

export function runScrape(opts: { sources?: string[]; maxResultsPerSource?: number } = {}): Promise<OrchestratorRunResult> {
  if (_running) return _running.promise

  const startedAt = new Date().toISOString()
  const abort = new AbortController()
  const db = useDb()

  const selected = SCRAPERS.filter((s) => !opts.sources || opts.sources.includes(s.source))

  // A new run overrides the last-run snapshot immediately so clients don't
  // briefly see the previous panel while this run is spinning up.
  _last = null

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
    _last = {
      startedAt: state.startedAt,
      finishedAt: new Date().toISOString(),
      total: state.total,
      completed: state.completed,
    }
    _running = null
    // Bounded scrape_runs history — cheap DELETE, only runs once per full scrape.
    try { pruneScrapeRuns(30, db) } catch {}
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
