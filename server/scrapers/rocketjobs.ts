import type {
  JobScraper, RawJob, ScrapeContext, ScrapeResult,
  Experience, ContractType, SalaryPeriod,
} from './types'

// Rocketjobs.pl exposes a JSON API at /api/candidate-api/offers but covers
// all industries. We filter down to IT/frontend by category key, title, or
// skill keywords and build jobs entirely from list data (no detail fetch).
const BASE = 'https://rocketjobs.pl/api/candidate-api'

const IT_CATEGORY_PREFIXES = ['it-', 'tech', 'developer', 'engineer', 'programowanie']
const FRONTEND_SKILL_RE = /\b(vue|react|angular|svelte|nuxt|next|frontend|front-end|front end|javascript|typescript|html|css|node|fullstack|full-stack)\b/i
const FRONTEND_TITLE_RE = /\b(front[- ]?end|frontend|fullstack|full[- ]?stack|web developer|javascript|typescript|vue|react|angular|svelte|node|developer)\b/i

interface RjListOffer {
  guid: string
  slug: string
  title: string
  workplaceType: 'remote' | 'partly_remote' | 'office'
  workingTime: string
  experienceLevel: string
  category: { key: string; parentKey: string | null }
  city: string | null
  companyName: string
  publishedAt: string
  employmentTypes: Array<{ from: number | null; to: number | null; currency: string; type: string; unit: string; gross: boolean }>
  requiredSkills: Array<{ name: string; level: number }>
  niceToHaveSkills: Array<{ name: string; level: number }>
}

interface RjListResponse {
  data: RjListOffer[]
  meta: { from: number; totalItems: number; next?: { cursor: number | null } }
}

const HEADERS: HeadersInit = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  Accept: 'application/json',
  Version: '2',
}

function looksFrontend(o: RjListOffer): boolean {
  const cat = o.category?.key ?? ''
  if (IT_CATEGORY_PREFIXES.some((p) => cat.includes(p))) return true
  if (FRONTEND_TITLE_RE.test(o.title)) return true
  const allSkills = [...o.requiredSkills, ...o.niceToHaveSkills]
  return allSkills.some((s) => FRONTEND_SKILL_RE.test(s.name))
}

function mapExperience(lv: string): Experience | undefined {
  if (lv === 'junior') return 'junior'
  if (lv === 'mid') return 'mid'
  if (lv === 'senior' || lv === 'c_level') return 'senior'
  return undefined
}

function mapContract(t: string): ContractType | undefined {
  if (t === 'b2b') return 'b2b'
  if (t === 'permanent') return 'permanent'
  if (t === 'mandate_contract') return 'mandate'
  return undefined
}

function pickSalary(o: RjListOffer): { min?: number; max?: number; currency?: string; period?: SalaryPeriod; contract?: ContractType } {
  const et = o.employmentTypes.find((e) => e.from != null || e.to != null) ?? o.employmentTypes[0]
  if (!et) return {}
  return {
    min: et.from ?? undefined,
    max: et.to ?? undefined,
    currency: et.currency,
    period: et.unit === 'hour' ? 'hour' : 'month',
    contract: mapContract(et.type),
  }
}

function buildRawJob(o: RjListOffer): RawJob {
  const sal = pickSalary(o)
  return {
    source: 'rocketjobs',
    sourceId: o.slug,
    url: `https://rocketjobs.pl/offers/${o.slug}`,
    title: o.title,
    company: o.companyName,
    location: o.city ?? undefined,
    remote: o.workplaceType === 'remote' || o.workplaceType === 'partly_remote',
    salaryMin: sal.min,
    salaryMax: sal.max,
    currency: sal.currency,
    salaryPeriod: sal.period,
    contractType: sal.contract,
    experience: mapExperience(o.experienceLevel),
    description: '',
    skills: [
      ...o.requiredSkills.map((s) => s.name),
      ...o.niceToHaveSkills.map((s) => s.name),
    ],
    postedAt: o.publishedAt,
  }
}

async function fetchPage(from: number, signal?: AbortSignal): Promise<RjListResponse> {
  const url = from === 0 ? `${BASE}/offers` : `${BASE}/offers?from=${from}`
  const res = await fetch(url, { headers: HEADERS, signal })
  if (!res.ok) throw new Error(`RJ list → HTTP ${res.status}`)
  return res.json() as Promise<RjListResponse>
}

const MAX_PAGES = 100
const PAGE_DELAY_MS = 400

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const rocketjobsScraper: JobScraper = {
  source: 'rocketjobs',
  displayName: 'rocketjobs.pl',
  capabilities: { needsBrowser: false, supportsKeywordFilter: false },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const jobs: RawJob[] = []
    const seen = new Set<string>()

    let from = 0
    let totalItems = Infinity
    let pages = 0

    while (from < totalItems && pages < MAX_PAGES) {
      let page: RjListResponse
      try {
        page = await fetchPage(from, ctx.signal)
      } catch (e) {
        errors.push((e as Error).message)
        break
      }

      if (!page.data.length) break
      if (pages === 0) totalItems = page.meta.totalItems

      for (const offer of page.data) {
        if (seen.has(offer.slug)) continue
        seen.add(offer.slug)
        if (!looksFrontend(offer)) continue
        jobs.push(buildRawJob(offer))
        if (ctx.maxResults && jobs.length >= ctx.maxResults) {
          return { source: this.source, jobs, errors }
        }
      }

      from += page.data.length
      pages++
      await sleep(PAGE_DELAY_MS)
    }

    return { source: this.source, jobs, errors }
  },
}
