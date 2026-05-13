import type {
  JobScraper, RawJob, ScrapeContext, ScrapeResult,
  Experience, ContractType, SalaryPeriod,
} from './types'

// Rocketjobs.pl is owned by the same group as JustJoin.it and exposes the
// same `/api/candidate-api/offers` endpoint shape — but unlike JJIT it lists
// jobs across all industries (healthcare, sales, banking, IT, …). We filter
// down to IT/frontend candidates the same way JJIT does: category key,
// title, or skill keywords.
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

interface RjDetailOffer extends RjListOffer {
  body: string
  applyUrl?: string | null
  isActive: boolean
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

function buildRawJob(d: RjDetailOffer): RawJob {
  const sal = pickSalary(d)
  return {
    source: 'rocketjobs',
    sourceId: d.slug,
    url: `https://rocketjobs.pl/offers/${d.slug}`,
    title: d.title,
    company: d.companyName,
    location: d.city ?? undefined,
    remote: d.workplaceType === 'remote' || d.workplaceType === 'partly_remote',
    salaryMin: sal.min,
    salaryMax: sal.max,
    currency: sal.currency,
    salaryPeriod: sal.period,
    contractType: sal.contract,
    experience: mapExperience(d.experienceLevel),
    description: d.body ?? '',
    skills: [
      ...d.requiredSkills.map((s) => s.name),
      ...d.niceToHaveSkills.map((s) => s.name),
    ],
    postedAt: d.publishedAt,
  }
}

async function fetchPage(cursor: number | null, signal?: AbortSignal): Promise<RjListResponse> {
  const url = cursor == null ? `${BASE}/offers` : `${BASE}/offers?cursor=${cursor}`
  const res = await fetch(url, { headers: HEADERS, signal })
  if (!res.ok) throw new Error(`RJ list → HTTP ${res.status}`)
  return res.json() as Promise<RjListResponse>
}

async function fetchDetail(slug: string, signal?: AbortSignal): Promise<RjDetailOffer> {
  const res = await fetch(`${BASE}/offers/${slug}`, { headers: HEADERS, signal })
  if (!res.ok) throw new Error(`RJ detail ${slug} → HTTP ${res.status}`)
  return res.json() as Promise<RjDetailOffer>
}

const MAX_PAGES = 100
const REQUEST_DELAY_MS = 120

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

    let cursor: number | null = null
    let pages = 0

    while (pages < MAX_PAGES) {
      let page: RjListResponse
      try {
        page = await fetchPage(cursor, ctx.signal)
      } catch (e) {
        errors.push((e as Error).message)
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
          if (ctx.maxResults && jobs.length >= ctx.maxResults) {
            return { source: this.source, jobs, errors }
          }
        } catch (e) {
          errors.push(`detail ${offer.slug}: ${(e as Error).message}`)
        }
        await sleep(REQUEST_DELAY_MS)
      }

      const next = page.meta.next?.cursor ?? null
      if (next == null) break
      cursor = next
      pages++
      await sleep(REQUEST_DELAY_MS)
    }

    return { source: this.source, jobs, errors }
  },
}
