import type {
  JobScraper, RawJob, ScrapeContext, ScrapeResult,
  ContractType, Experience, SalaryPeriod,
} from './types'
import { fmtErr } from './types'
import { pMap } from '../lib/concurrency'

// NoFluffJobs has a documented-ish search API:
//   POST /api/search/posting?salaryCurrency=PLN&salaryPeriod=month
//   body: { criteriaSearch: { requirement: ["vue.js", ...] }, ... }
// Pagination is via `pageSize` (query) + offset on first call returning ~150
// postings at once for the criteria we send.
//
// We submit two queries: one for Vue.js explicitly, one broad frontend bucket
// (React, Angular, JavaScript, TypeScript) so we still discover offers where
// Vue is buried in the description but not in tagged requirements.
const SEARCH_URL = 'https://nofluffjobs.com/api/search/posting?salaryCurrency=PLN&salaryPeriod=month'
const DETAIL_URL = (slug: string) => `https://nofluffjobs.com/api/posting/${slug}`

const HEADERS: HeadersInit = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  Accept: 'application/json',
  'Content-Type': 'application/json',
}

const SEARCH_QUERIES: Array<{ label: string; criteria: { requirement?: string[]; category?: string[] } }> = [
  { label: 'vue',      criteria: { requirement: ['vue.js'] } },
  { label: 'nuxt',     criteria: { requirement: ['nuxt.js'] } },
  { label: 'frontend', criteria: { category: ['frontend'] } },
  { label: 'fullstack', criteria: { category: ['fullstack'] } },
]

interface NfjPosting {
  id: string
  name: string                            // company
  title: string
  url: string
  category: string
  seniority: string[]
  fullyRemote: boolean
  location: { places: Array<{ city?: string; country?: { code: string; name: string } }> }
  salary?: { from?: number; to?: number; type?: string; currency?: string }
  technology?: string
  posted?: number                         // ms epoch
  tiles?: { values: Array<{ value: string; type: string }> }
}

interface NfjSearchResponse {
  totalCount: number
  postings: NfjPosting[]
}

interface NfjMust { value: string; type: string }
interface NfjDetail {
  id: string
  title: string
  postingUrl: string
  apply?: { applyUrl?: string }
  basics?: { category?: string; seniority?: string; technology?: string }
  company?: { name?: string }
  location?: NfjPosting['location']
  details?: { description?: string; position?: string }
  specs?: { dailyTasks?: string[] }
  essentials?: { contract?: string; originalSalary?: { from?: number; to?: number; currency?: string; type?: string; period?: string } }
  requirements?: { musts?: NfjMust[]; nices?: NfjMust[] }
  posted?: number
  defaultUrl?: string
  status?: { active?: boolean }
}

function mapSeniority(arr?: unknown): Experience | undefined {
  const items = Array.isArray(arr) ? arr : arr != null ? [arr] : []
  if (!items.length) return undefined
  const first = items[0]
  if (typeof first !== 'string') return undefined
  const s = first.toLowerCase()
  if (s.includes('junior')) return 'junior'
  if (s.includes('senior')) return 'senior'
  if (s.includes('mid')) return 'mid'
  return undefined
}

function mapContract(s?: unknown): ContractType | undefined {
  if (typeof s !== 'string') return undefined
  const k = s.toLowerCase()
  if (k.includes('b2b')) return 'b2b'
  if (k.includes('permanent') || k.includes('employment')) return 'permanent'
  if (k.includes('mandate')) return 'mandate'
  return undefined
}

function mapPeriod(p?: unknown): SalaryPeriod | undefined {
  if (typeof p !== 'string') return undefined
  if (p.toLowerCase().startsWith('h')) return 'hour'
  return 'month'
}

function placeCity(p: NfjPosting): string | undefined {
  return p.location?.places?.find((x) => x.city)?.city
}

function detailToRaw(d: NfjDetail): RawJob {
  const company = d.company?.name ?? ''
  const description = [
    d.details?.position ?? '',
    d.details?.description ?? '',
    ...(d.specs?.dailyTasks ?? []),
  ].filter(Boolean).join('\n\n')
  const skills = [
    ...(d.requirements?.musts ?? []).map((m) => m.value),
    ...(d.requirements?.nices ?? []).map((m) => m.value),
  ]
  const sal = d.essentials?.originalSalary
  const slug = d.postingUrl || d.defaultUrl || d.id
  return {
    source: 'nofluffjobs',
    sourceId: slug,
    url: `https://nofluffjobs.com/job/${slug}`,
    title: d.title,
    company,
    location: d.location?.places?.find((x) => x.city)?.city,
    remote: !!d.location?.places?.some((x) => /remote|zdaln/i.test(x.city ?? '')),
    salaryMin: sal?.from,
    salaryMax: sal?.to,
    currency: sal?.currency,
    salaryPeriod: mapPeriod(sal?.period),
    contractType: mapContract(sal?.type ?? d.essentials?.contract),
    experience: mapSeniority(d.basics?.seniority),
    description,
    skills,
    postedAt: d.posted ? new Date(d.posted).toISOString() : undefined,
  }
}

// Quick mapper if we cannot fetch detail — keeps the listing with the
// limited metadata we already have. Description is empty so the Vue
// detector falls back to title + skills (still useful).
function listingToRaw(p: NfjPosting): RawJob {
  const skills = [
    ...(p.tiles?.values ?? []).filter((v) => v.type === 'requirement').map((v) => v.value),
    p.technology,
  ].filter(Boolean) as string[]
  return {
    source: 'nofluffjobs',
    sourceId: p.url,
    url: `https://nofluffjobs.com/job/${p.url}`,
    title: p.title,
    company: p.name,
    location: placeCity(p),
    remote: !!p.fullyRemote,
    salaryMin: p.salary?.from,
    salaryMax: p.salary?.to,
    currency: p.salary?.currency,
    salaryPeriod: 'month',
    contractType: mapContract(p.salary?.type),
    experience: mapSeniority(p.seniority),
    description: '',
    skills,
    postedAt: p.posted ? new Date(p.posted).toISOString() : undefined,
  }
}

// Per-worker delay after each request. With DETAIL_CONCURRENCY workers running
// in parallel we get roughly DETAIL_CONCURRENCY / (DELAY/1000) req/sec — a few
// times faster than the previous serial 1 req / ~500ms without triggering
// NFJ's rate limiter (retry logic below still catches the occasional 502).
const REQUEST_DELAY_MS = 350
const REQUEST_JITTER_MS = 200
const DETAIL_CONCURRENCY = 3
// NFJ's detail endpoint 502s under fast sequential load; brief backoff clears it.
const DETAIL_RETRY_DELAYS_MS = [800, 2000, 4500]

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function nextDelay(): number {
  return REQUEST_DELAY_MS + Math.floor(Math.random() * REQUEST_JITTER_MS)
}

async function search(criteria: { requirement?: string[]; category?: string[] }, pageSize = 200, signal?: AbortSignal): Promise<NfjPosting[]> {
  const res = await fetch(`${SEARCH_URL}&pageSize=${pageSize}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ criteriaSearch: criteria }),
    signal,
  })
  if (!res.ok) throw new Error(`NFJ search → HTTP ${res.status}`)
  const j = (await res.json()) as NfjSearchResponse
  return j.postings ?? []
}

async function fetchDetail(slug: string, signal?: AbortSignal): Promise<NfjDetail> {
  let lastStatus = 0
  for (let attempt = 0; attempt <= DETAIL_RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch(DETAIL_URL(slug), { headers: HEADERS, signal })
    if (res.ok) return res.json() as Promise<NfjDetail>
    lastStatus = res.status
    // Only retry on transient upstream errors; 4xx means the slug is gone/blocked.
    if (res.status < 500 || res.status === 501) break
    const delay = DETAIL_RETRY_DELAYS_MS[attempt]
    if (delay === undefined) break
    await sleep(delay)
  }
  throw new Error(`NFJ detail ${slug} → HTTP ${lastStatus}`)
}

export const nofluffjobsScraper: JobScraper = {
  source: 'nofluffjobs',
  displayName: 'NoFluffJobs',
  capabilities: { needsBrowser: false, supportsKeywordFilter: true },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const seen = new Set<string>()
    const queue: NfjPosting[] = []

    // Phase 1: run each search query serially and collect a deduped queue of
    // postings to fetch details for.
    for (const q of SEARCH_QUERIES) {
      let postings: NfjPosting[]
      try {
        postings = await search(q.criteria, 200, ctx.signal)
      } catch (e) {
        errors.push(`search[${q.label}]: ${fmtErr(e)}`)
        continue
      }
      for (const p of postings) {
        if (seen.has(p.url)) continue
        seen.add(p.url)
        queue.push(p)
        if (ctx.maxResults && queue.length >= ctx.maxResults) break
      }
      if (ctx.maxResults && queue.length >= ctx.maxResults) break
    }

    // Phase 2: fetch details concurrently. Falls back to the search-result
    // payload if the detail call fails so we still ingest something.
    const results = await pMap(queue, DETAIL_CONCURRENCY, async (p) => {
      try {
        const detail = await fetchDetail(p.url, ctx.signal)
        if (detail.status?.active === false) return null
        return detailToRaw(detail)
      } catch (e) {
        errors.push(`detail ${p.url}: ${fmtErr(e)}`)
        return listingToRaw(p)
      } finally {
        await sleep(nextDelay())
      }
    })

    const jobs = results.filter((j): j is RawJob => j !== null)
    return { source: this.source, jobs, errors }
  },
}
