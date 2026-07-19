export type SalaryPeriod = 'month' | 'hour'
export type ContractType = 'b2b' | 'permanent' | 'mandate'
export type Experience = 'junior' | 'mid' | 'senior'

export interface RawJob {
  source: string
  sourceId: string
  url: string
  title: string
  company: string
  location?: string
  remote: boolean
  salaryMin?: number
  salaryMax?: number
  currency?: string
  salaryPeriod?: SalaryPeriod
  contractType?: ContractType
  experience?: Experience
  description: string
  skills: string[]
  postedAt?: string
}

export interface ScrapeContext {
  // Keyword the scraper should bias its search toward, when supported by the portal.
  // Scrapers that filter server-side use this; others fetch broadly and let the
  // app-side Vue detector decide what to keep.
  keyword?: string
  // Soft cap on listings per source per run (portal-dependent).
  maxResults?: number
  // AbortSignal for cancellation by the caller.
  signal?: AbortSignal
}

export interface ScrapeResult {
  source: string
  jobs: RawJob[]
  errors: string[]
  // Source IDs of postings detected as closed during this scrape run.
  // The orchestrator will expire these so they immediately become stale.
  closedIds?: string[]
}

export interface JobScraper {
  source: string
  displayName: string
  capabilities: {
    needsBrowser: boolean
    supportsKeywordFilter: boolean
  }
  // Minimum minutes between cron-driven runs of this scraper. Undefined = use
  // the global SCRAPE_INTERVAL_MINUTES. Slow / rate-limited portals set this
  // higher so the cron tick skips them until enough time has passed. Manual
  // "Scrape now" from the UI always runs everything regardless.
  cronIntervalMinutes?: number
  scrape(ctx: ScrapeContext): Promise<ScrapeResult>
}

// Formats a caught error including the cause chain so "fetch failed" entries
// in scrape_runs.error_message contain the real underlying error code/message.
export function fmtErr(e: unknown): string {
  const parts: string[] = []
  let cur: unknown = e
  while (cur) {
    const err = cur as Error & { code?: string; cause?: unknown }
    const part = [err.message, err.code ? `(${err.code})` : ''].filter(Boolean).join(' ')
    if (part) parts.push(part)
    cur = err.cause
    if (parts.length > 5) break // guard against circular causes
  }
  return parts.join(' → ') || String(e)
}
