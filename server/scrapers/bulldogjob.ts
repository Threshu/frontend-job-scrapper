import * as cheerio from 'cheerio'
import type {
  JobScraper, RawJob, ScrapeContext, ScrapeResult,
  ContractType, Experience,
} from './types'

// Bulldogjob is a Next.js app. Both the list pages and detail pages embed
// their data as JSON in `<script id="__NEXT_DATA__">`. We don't need a DOM
// crawler — just pull and parse the JSON.
const SLUG_PAGES = [
  'https://bulldogjob.com/companies/jobs/s/skills,Vue.js',
  'https://bulldogjob.com/companies/jobs/s/category,frontend',
  'https://bulldogjob.com/companies/jobs/s/skills,React',
  'https://bulldogjob.com/companies/jobs/s/skills,JavaScript',
]

const HEADERS: HeadersInit = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pl,en;q=0.8',
}

interface BdListJob {
  id: string
  position: string
  company: { name: string; logo?: { url: string } }
  city?: string
  remote?: boolean
  experienceLevel?: string
  technologyTags?: string[]
  denominatedSalaryLong?: { money?: string; currency?: string; hidden?: boolean }
  contractB2b?: { minValue?: number; maxValue?: number } | null
  contractEmployment?: boolean | { minValue?: number; maxValue?: number } | null
}

interface BdJobDetail {
  id: string
  position: string
  details?: string
  offer?: string
  requirements?: string
  technologyTags?: string[]
  experienceLevel?: string
  publishedAt?: string
  remote?: boolean
  workFrom?: string[]
  state?: string
  contractB2b?: unknown
  contractEmployment?: unknown
  contractOther?: unknown
  employmentSalary?: { minValue?: number | null; maxValue?: number | null; currency?: string; money?: string; timeframe?: string }
  b2bSalary?: { minValue?: number | null; maxValue?: number | null; currency?: string; money?: string; timeframe?: string }
  otherSalary?: { minValue?: number | null; maxValue?: number | null; currency?: string; money?: string; timeframe?: string }
  company?: { __ref: string }
  locations?: Array<{ city?: string; country?: string }>
}

interface ApolloState { [key: string]: Record<string, unknown> }

function extractNextData(html: string): unknown {
  // The id="__NEXT_DATA__" script can have other attributes between id and tag end.
  // Match non-greedy to the next </script>.
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) throw new Error('__NEXT_DATA__ not found')
  return JSON.parse(m[1])
}

function stripHtml(html: string | undefined): string {
  if (!html) return ''
  return cheerio.load(`<div>${html}</div>`)('div').text().replace(/\s+/g, ' ').trim()
}

function mapExperience(level?: string): Experience | undefined {
  if (!level) return undefined
  const k = level.toLowerCase()
  if (k.includes('junior')) return 'junior'
  if (k.includes('senior') || k.includes('expert') || k.includes('lead')) return 'senior'
  if (k.includes('mid') || k.includes('regular')) return 'mid'
  return undefined
}

function pickSalary(d: BdJobDetail): { min?: number; max?: number; currency?: string; contractType?: ContractType } {
  const cands: Array<[ContractType, BdJobDetail['b2bSalary']]> = [
    ['b2b', d.b2bSalary],
    ['permanent', d.employmentSalary],
    ['mandate', d.otherSalary],
  ]
  for (const [type, sal] of cands) {
    if (!sal) continue
    if (sal.minValue || sal.maxValue) {
      return {
        min: sal.minValue ?? undefined,
        max: sal.maxValue ?? undefined,
        currency: sal.currency,
        contractType: type,
      }
    }
  }
  return {}
}

async function fetchHtml(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { headers: HEADERS, signal })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`)
  return res.text()
}

interface NextDataShape {
  props: {
    pageProps: {
      jobs?: BdListJob[]
      __APOLLO_STATE__?: ApolloState
    }
  }
}

async function fetchListPage(url: string, signal?: AbortSignal): Promise<BdListJob[]> {
  const html = await fetchHtml(url, signal)
  const data = extractNextData(html) as NextDataShape
  return data.props?.pageProps?.jobs ?? []
}

async function fetchJobDetail(jobId: string, signal?: AbortSignal): Promise<{ job: BdJobDetail; companyName?: string }> {
  const url = `https://bulldogjob.com/companies/jobs/${jobId}`
  const html = await fetchHtml(url, signal)
  const data = extractNextData(html) as NextDataShape
  const apollo = data.props?.pageProps?.__APOLLO_STATE__ ?? {}
  const jobKey = `Job:${jobId}`
  const job = apollo[jobKey] as unknown as BdJobDetail | undefined
  if (!job) throw new Error(`Job:${jobId} not in apollo state`)
  let companyName: string | undefined
  if (job.company?.__ref) {
    const c = apollo[job.company.__ref] as Record<string, unknown> | undefined
    if (c && typeof c.name === 'string') companyName = c.name
  }
  return { job, companyName }
}

const REQUEST_DELAY_MS = 200

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const bulldogjobScraper: JobScraper = {
  source: 'bulldogjob',
  displayName: 'Bulldogjob',
  capabilities: { needsBrowser: false, supportsKeywordFilter: true },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const jobs: RawJob[] = []
    const seenIds = new Set<string>()
    const listSeed: BdListJob[] = []

    for (const url of SLUG_PAGES) {
      try {
        const page = await fetchListPage(url, ctx.signal)
        for (const j of page) {
          if (seenIds.has(j.id)) continue
          seenIds.add(j.id)
          listSeed.push(j)
        }
      } catch (e) {
        errors.push(`list ${url}: ${(e as Error).message}`)
      }
      await sleep(REQUEST_DELAY_MS)
    }

    for (const j of listSeed) {
      try {
        const { job, companyName } = await fetchJobDetail(j.id, ctx.signal)
        if (job.state && job.state !== 'published') continue
        const description = [
          stripHtml(job.details),
          stripHtml(job.requirements),
          stripHtml(job.offer),
        ].filter(Boolean).join('\n\n')
        const sal = pickSalary(job)
        const skills = job.technologyTags ?? j.technologyTags ?? []
        jobs.push({
          source: 'bulldogjob',
          sourceId: j.id,
          url: `https://bulldogjob.com/companies/jobs/${j.id}`,
          title: job.position || j.position,
          company: companyName ?? j.company?.name ?? '',
          location: j.city || job.locations?.[0]?.city,
          remote: !!(job.remote ?? j.remote),
          salaryMin: sal.min,
          salaryMax: sal.max,
          currency: sal.currency,
          salaryPeriod: 'month',
          contractType: sal.contractType,
          experience: mapExperience(job.experienceLevel ?? j.experienceLevel),
          description,
          skills,
          postedAt: job.publishedAt,
        })

        if (ctx.maxResults && jobs.length >= ctx.maxResults) {
          return { source: this.source, jobs, errors }
        }
      } catch (e) {
        errors.push(`detail ${j.id}: ${(e as Error).message}`)
      }
      await sleep(REQUEST_DELAY_MS)
    }

    return { source: this.source, jobs, errors }
  },
}
