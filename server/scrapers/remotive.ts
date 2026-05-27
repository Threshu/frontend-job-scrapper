import type {
  JobScraper, RawJob, ScrapeContext, ScrapeResult,
} from './types'

// Remotive exposes a documented public JSON API — no auth required.
// Endpoint: GET /api/remote-jobs?category=software-dev&search=<term>
// Rate limit: ~2 req/min (hard block), 4/day recommended by docs.
// We fire 2 queries per run (vue + frontend) with a 1.5s gap between them.
const BASE_URL = 'https://remotive.com/api/remote-jobs'

const HEADERS: HeadersInit = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  Accept: 'application/json',
}

const SEARCH_TERMS = ['vue', 'frontend']

interface RemotiveJob {
  id: number
  url: string
  title: string
  company_name: string
  category: string
  tags: string[]
  job_type: string
  publication_date: string
  candidate_required_location: string
  salary: string
  description: string
}

interface RemotiveResponse {
  'job-count': number
  jobs: RemotiveJob[]
}

function parseSalary(text: string): { min?: number; max?: number; currency?: string } {
  if (!text) return {}
  // "$80k - $100k" or "$50,000 - $80,000" or "€60k"
  const cleaned = text.replace(/,/g, '')
  const cur = /€|eur/i.test(cleaned) ? 'EUR' : /£|gbp/i.test(cleaned) ? 'GBP' : 'USD'
  const range = cleaned.match(/[\$€£]?([\d.]+)(k?)\s*[–\-]\s*[\$€£]?([\d.]+)(k?)/i)
  if (range) {
    const parse = (n: string, k: string) => Math.round(Number(n) * (k ? 1000 : 1))
    return { min: parse(range[1], range[2]), max: parse(range[3], range[4]), currency: cur }
  }
  const single = cleaned.match(/[\$€£]?([\d.]+)(k?)/i)
  if (single) {
    return { min: Math.round(Number(single[1]) * (single[2] ? 1000 : 1)), currency: cur }
  }
  return {}
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildRawJob(j: RemotiveJob): RawJob {
  const sal = parseSalary(j.salary)
  return {
    source: 'remotive',
    sourceId: String(j.id),
    url: j.url,
    title: j.title,
    company: j.company_name,
    location: j.candidate_required_location || 'Remote',
    remote: true,
    salaryMin: sal.min,
    salaryMax: sal.max,
    currency: sal.currency,
    salaryPeriod: 'month',
    description: stripHtml(j.description),
    skills: j.tags,
    postedAt: j.publication_date,
  }
}

const REQUEST_DELAY_MS = 1500

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const remotiveScraper: JobScraper = {
  source: 'remotive',
  displayName: 'Remotive',
  capabilities: { needsBrowser: false, supportsKeywordFilter: true },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const jobs: RawJob[] = []
    const seen = new Set<string>()

    for (const term of SEARCH_TERMS) {
      let data: RemotiveResponse
      try {
        const url = `${BASE_URL}?category=software-dev&search=${encodeURIComponent(term)}`
        const res = await fetch(url, { headers: HEADERS, signal: ctx.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        data = await res.json() as RemotiveResponse
      } catch (e) {
        errors.push(`search[${term}]: ${(e as Error).message}`)
        await sleep(REQUEST_DELAY_MS)
        continue
      }

      for (const j of data.jobs ?? []) {
        const id = String(j.id)
        if (seen.has(id)) continue
        seen.add(id)
        jobs.push(buildRawJob(j))
        if (ctx.maxResults && jobs.length >= ctx.maxResults) {
          return { source: this.source, jobs, errors }
        }
      }

      await sleep(REQUEST_DELAY_MS)
    }

    return { source: this.source, jobs, errors }
  },
}
