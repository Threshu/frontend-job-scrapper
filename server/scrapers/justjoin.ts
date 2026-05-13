import type { JobScraper, RawJob, ScrapeContext, ScrapeResult, Experience, ContractType, SalaryPeriod } from './types'

// JJIT shut down their public /api/offers in 2023. The SPA now calls the
// internal /api/candidate-api/* gateway, which is still reachable without
// auth. The list endpoint does NOT respect filter query params on the server
// side — filters happen client-side in the SPA. We replicate that here:
//   1. Paginate the full list (cursor-based, 10 per page).
//   2. From the list payload pick "frontend candidates" — offers whose
//      category, title, or required skills suggest frontend work.
//   3. Fetch /offers/{slug} only for candidates (gives us `body` = description).
//   4. Let the app-side Vue detector make the final call.
const BASE = 'https://justjoin.it/api/candidate-api'
const FRONTEND_CATEGORIES = new Set(['javascript', 'html'])
const FRONTEND_SKILL_RE = /\b(vue|react|angular|svelte|nuxt|next|frontend|front-end|front end|javascript|typescript|html|css)\b/i
const FRONTEND_TITLE_RE = /\b(front[- ]?end|frontend|fullstack|full[- ]?stack|web|javascript|typescript|vue|react|angular|svelte)\b/i

interface JjitListOffer {
  guid: string
  slug: string
  title: string
  workplaceType: 'remote' | 'partly_remote' | 'office'
  workingTime: string
  experienceLevel: 'junior' | 'mid' | 'senior' | 'c_level'
  category: { key: string; parentKey: string | null }
  city: string | null
  companyName: string
  publishedAt: string
  employmentTypes: Array<{
    from: number | null
    to: number | null
    currency: string
    type: string
    unit: string
    gross: boolean
  }>
  requiredSkills: Array<{ name: string; level: number }>
  niceToHaveSkills: Array<{ name: string; level: number }>
}

interface JjitListResponse {
  data: JjitListOffer[]
  meta: {
    from: number
    totalItems: number
    next?: { cursor: number | null; itemsCount: number }
  }
}

interface JjitDetailOffer extends JjitListOffer {
  body: string
  applyUrl?: string | null
  isActive: boolean
}

const HEADERS: HeadersInit = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  Accept: 'application/json',
  Version: '2',
}

function looksFrontend(offer: JjitListOffer): boolean {
  if (FRONTEND_CATEGORIES.has(offer.category.key)) return true
  if (FRONTEND_TITLE_RE.test(offer.title)) return true
  const allSkills = [...offer.requiredSkills, ...offer.niceToHaveSkills]
  return allSkills.some((s) => FRONTEND_SKILL_RE.test(s.name))
}

function mapExperience(level: string): Experience | undefined {
  if (level === 'junior') return 'junior'
  if (level === 'mid') return 'mid'
  if (level === 'senior' || level === 'c_level') return 'senior'
  return undefined
}

function mapContract(type: string): ContractType | undefined {
  if (type === 'b2b') return 'b2b'
  if (type === 'permanent') return 'permanent'
  if (type === 'mandate_contract') return 'mandate'
  return undefined
}

function mapSalary(offer: JjitListOffer): {
  min?: number
  max?: number
  currency?: string
  period?: SalaryPeriod
  contractType?: ContractType
} {
  // Prefer first employmentType with concrete range. JJIT amounts are net or
  // gross monthly for permanent; per-hour for b2b. We capture both unchanged
  // and let the UI label them.
  const et = offer.employmentTypes.find((e) => e.from != null || e.to != null) ?? offer.employmentTypes[0]
  if (!et) return {}
  return {
    min: et.from ?? undefined,
    max: et.to ?? undefined,
    currency: et.currency,
    period: et.unit === 'hour' ? 'hour' : 'month',
    contractType: mapContract(et.type),
  }
}

function buildRawJob(detail: JjitDetailOffer): RawJob {
  const sal = mapSalary(detail)
  return {
    source: 'justjoin',
    sourceId: detail.slug,
    url: `https://justjoin.it/offers/${detail.slug}`,
    title: detail.title,
    company: detail.companyName,
    location: detail.city ?? undefined,
    remote: detail.workplaceType === 'remote' || detail.workplaceType === 'partly_remote',
    salaryMin: sal.min,
    salaryMax: sal.max,
    currency: sal.currency,
    salaryPeriod: sal.period,
    contractType: sal.contractType,
    experience: mapExperience(detail.experienceLevel),
    description: detail.body || '',
    skills: [
      ...detail.requiredSkills.map((s) => s.name),
      ...detail.niceToHaveSkills.map((s) => s.name),
    ],
    postedAt: detail.publishedAt,
  }
}

async function fetchPage(cursor: number | null, signal?: AbortSignal): Promise<JjitListResponse> {
  const url = cursor == null ? `${BASE}/offers` : `${BASE}/offers?cursor=${cursor}`
  const res = await fetch(url, { headers: HEADERS, signal })
  if (!res.ok) throw new Error(`JJIT list ${url} → HTTP ${res.status}`)
  return res.json() as Promise<JjitListResponse>
}

async function fetchDetail(slug: string, signal?: AbortSignal): Promise<JjitDetailOffer> {
  const res = await fetch(`${BASE}/offers/${slug}`, { headers: HEADERS, signal })
  if (!res.ok) throw new Error(`JJIT detail ${slug} → HTTP ${res.status}`)
  return res.json() as Promise<JjitDetailOffer>
}

// Cap on number of pages walked per run. 200 pages × 10 offers/page = 2000
// listings, well past the volume of fresh frontend jobs in Poland on a given day.
const MAX_PAGES = 200
const REQUEST_DELAY_MS = 120

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const justjoinScraper: JobScraper = {
  source: 'justjoin',
  displayName: 'JustJoin.it',
  capabilities: { needsBrowser: false, supportsKeywordFilter: false },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const jobs: RawJob[] = []
    const seen = new Set<string>()

    let cursor: number | null = null
    let pages = 0

    while (pages < MAX_PAGES) {
      let page: JjitListResponse
      try {
        page = await fetchPage(cursor, ctx.signal)
      } catch (e) {
        errors.push(String((e as Error).message))
        break
      }

      for (const offer of page.data) {
        if (seen.has(offer.slug)) continue
        seen.add(offer.slug)
        if (!looksFrontend(offer)) continue
        try {
          const detail = await fetchDetail(offer.slug, ctx.signal)
          if (detail.isActive === false) continue
          jobs.push(buildRawJob(detail))
          if (ctx.maxResults && jobs.length >= ctx.maxResults) return { source: this.source, jobs, errors }
        } catch (e) {
          errors.push(`detail ${offer.slug}: ${(e as Error).message}`)
        }
        await sleep(REQUEST_DELAY_MS)
      }

      const nextCursor = page.meta.next?.cursor ?? null
      if (nextCursor == null) break
      cursor = nextCursor
      pages++
      await sleep(REQUEST_DELAY_MS)
    }

    return { source: this.source, jobs, errors }
  },
}
