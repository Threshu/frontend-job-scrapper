import type {
  JobScraper, RawJob, ScrapeContext, ScrapeResult,
} from './types'

// Remote OK exposes a public JSON feed at /api. The response is an array
// where the first element is the legal/usage notice and the rest are jobs.
// They don't paginate — one fetch returns ~100 jobs total (last week of
// remote-first listings). We let the app-side Vue detector decide what to
// keep; nothing to filter server-side here.
const URL = 'https://remoteok.com/api'

const HEADERS: HeadersInit = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  Accept: 'application/json',
}

interface RoJob {
  slug?: string
  id?: string
  epoch?: number
  date?: string
  company?: string
  position?: string
  tags?: string[]
  description?: string
  location?: string
  apply_url?: string
  salary_min?: number
  salary_max?: number
  url?: string
}

function stripHtml(s: string | undefined): string {
  if (!s) return ''
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

function buildRawJob(j: RoJob): RawJob | null {
  const id = j.slug ?? (j.id ? String(j.id) : undefined)
  if (!id || !j.position || !j.company) return null
  return {
    source: 'remoteok',
    sourceId: id,
    url: j.url ?? `https://remoteok.com/remote-jobs/${id}`,
    title: j.position,
    company: j.company,
    location: j.location ?? 'Remote',
    remote: true,
    salaryMin: j.salary_min,
    salaryMax: j.salary_max,
    currency: j.salary_min || j.salary_max ? 'USD' : undefined,
    salaryPeriod: 'month',
    description: stripHtml(j.description),
    skills: j.tags ?? [],
    postedAt: j.date,
  }
}

export const remoteokScraper: JobScraper = {
  source: 'remoteok',
  displayName: 'Remote OK',
  capabilities: { needsBrowser: false, supportsKeywordFilter: false },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const jobs: RawJob[] = []

    let payload: RoJob[]
    try {
      const res = await fetch(URL, { headers: HEADERS, signal: ctx.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      payload = (await res.json()) as RoJob[]
    } catch (e) {
      errors.push((e as Error).message)
      return { source: this.source, jobs, errors }
    }

    // First element is the legal disclaimer (no `position` field).
    for (const j of payload) {
      const raw = buildRawJob(j)
      if (!raw) continue
      jobs.push(raw)
      if (ctx.maxResults && jobs.length >= ctx.maxResults) break
    }

    return { source: this.source, jobs, errors }
  },
}
