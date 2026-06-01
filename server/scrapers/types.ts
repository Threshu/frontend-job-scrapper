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
  scrape(ctx: ScrapeContext): Promise<ScrapeResult>
}
