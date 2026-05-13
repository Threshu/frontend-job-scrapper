import * as cheerio from 'cheerio'
import type {
  JobScraper, RawJob, ScrapeContext, ScrapeResult,
  ContractType, Experience,
} from './types'
import { fetchPageHtml } from '../lib/browser'

// Pracuj.pl serves SSR pages with everything we need embedded in
// __NEXT_DATA__. No detail fetch required — `jobDescription` is already on
// the list payload.
//
// We pull a few frontend-flavoured search URLs and paginate via ?pn=N. The
// pages return 50 grouped offers each (each "group" may have multiple
// per-city listings under `offers[]`).
const SEARCH_PATHS = [
  '/praca/vue.js;kw',
  '/praca/vue;kw',
  '/praca/javascript;kw',
  '/praca/front%20end%20developer;kw',
]
const MAX_PAGES_PER_SEARCH = 5


interface PracujOffer {
  offerAbsoluteUri?: string
  displayWorkplace?: string
  partitionId?: number | string
}

interface PracujGroup {
  groupId: string
  jobTitle: string
  companyName: string
  jobDescription?: string
  aboutProjectShortDescription?: string
  technologies?: string[]
  salaryDisplayText?: string | null
  lastPublicated?: string
  isRemoteWorkAllowed?: boolean
  workModes?: string[]
  positionLevels?: string[]
  typesOfContract?: string[]
  offers?: PracujOffer[]
}

function extractNextData(html: string): unknown {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) throw new Error('__NEXT_DATA__ not found')
  return JSON.parse(m[1])
}

function findGroupedOffers(obj: unknown): PracujGroup[] | null {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  if (Array.isArray(o.groupedOffers) && o.groupedOffers.length && (o.groupedOffers[0] as PracujGroup).jobTitle) {
    return o.groupedOffers as PracujGroup[]
  }
  for (const k of Object.keys(o)) {
    const r = findGroupedOffers(o[k])
    if (r) return r
  }
  return null
}

function mapExperience(levels?: string[]): Experience | undefined {
  if (!levels?.length) return undefined
  const joined = levels.join(' ').toLowerCase()
  if (joined.includes('junior') || joined.includes('asystent')) return 'junior'
  if (joined.includes('senior') || joined.includes('expert') || joined.includes('manager')) return 'senior'
  if (joined.includes('mid') || joined.includes('regular') || joined.includes('specjalista')) return 'mid'
  return undefined
}

function mapContract(contracts?: string[]): ContractType | undefined {
  if (!contracts?.length) return undefined
  const j = contracts.join(' ').toLowerCase()
  if (j.includes('b2b')) return 'b2b'
  if (j.includes('umowa o prac') || j.includes('umowa o pracę') || j.includes('permanent') || j.includes('employment')) return 'permanent'
  if (j.includes('zlecenie') || j.includes('mandate')) return 'mandate'
  return undefined
}

// Pracuj salary fields are free-text like "115–130 zł netto (+ VAT) / godz." or
// "10 000–14 000 zł brutto / mc". We try to extract a numeric range; on failure
// we leave it null and the UI shows nothing.
function parseSalary(text?: string | null): { min?: number; max?: number; currency?: string; period?: 'month' | 'hour' } {
  if (!text) return {}
  const cleaned = text.replace(/\s+/g, ' ')
  const range = cleaned.match(/(\d[\d\s]*)\s*[–\-]\s*(\d[\d\s]*)/)
  const single = !range ? cleaned.match(/(\d[\d\s]*)/) : null
  const num = (s: string) => Number(s.replace(/\s+/g, ''))
  let min: number | undefined
  let max: number | undefined
  if (range) { min = num(range[1]); max = num(range[2]) }
  else if (single) { min = num(single[1]); max = undefined }
  const currency = /usd|\$/i.test(cleaned) ? 'USD' : /eur|€/i.test(cleaned) ? 'EUR' : /pln|zł|zl/i.test(cleaned) ? 'PLN' : undefined
  const period: 'month' | 'hour' = /godz|hour|\/h/i.test(cleaned) ? 'hour' : 'month'
  return { min, max, currency, period }
}

function htmlToText(s: string | undefined): string {
  if (!s) return ''
  return cheerio.load(`<div>${s}</div>`)('div').text().replace(/\s+/g, ' ').trim()
}

function buildRawJob(g: PracujGroup): RawJob | null {
  if (!g.jobTitle || !g.companyName) return null
  // Prefer the first offer URL as canonical; if a group spans multiple cities,
  // we still treat it as one logical job for dedup purposes.
  const firstOffer = g.offers?.[0]
  const url = firstOffer?.offerAbsoluteUri ?? `https://www.pracuj.pl/praca/${g.groupId}`
  const description = [
    htmlToText(g.aboutProjectShortDescription),
    htmlToText(g.jobDescription),
  ].filter(Boolean).join('\n\n')
  const sal = parseSalary(g.salaryDisplayText ?? undefined)
  return {
    source: 'pracuj',
    sourceId: g.groupId,
    url,
    title: g.jobTitle,
    company: g.companyName,
    location: firstOffer?.displayWorkplace,
    remote: !!g.isRemoteWorkAllowed || (g.workModes ?? []).some((w) => /zdalna|remote/i.test(w)),
    salaryMin: sal.min,
    salaryMax: sal.max,
    currency: sal.currency,
    salaryPeriod: sal.period,
    contractType: mapContract(g.typesOfContract),
    experience: mapExperience(g.positionLevels),
    description,
    skills: g.technologies ?? [],
    postedAt: g.lastPublicated,
  }
}

async function fetchPage(path: string, page: number): Promise<PracujGroup[]> {
  const url = `https://it.pracuj.pl${path}${page > 1 ? `?pn=${page}` : ''}`
  const html = await fetchPageHtml(url, { waitForSelector: 'script#__NEXT_DATA__' })
  const data = extractNextData(html)
  return findGroupedOffers(data) ?? []
}

const REQUEST_DELAY_MS = 250

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const pracujScraper: JobScraper = {
  source: 'pracuj',
  displayName: 'Pracuj.pl',
  capabilities: { needsBrowser: true, supportsKeywordFilter: true },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const jobs: RawJob[] = []
    const seen = new Set<string>()

    for (const path of SEARCH_PATHS) {
      for (let page = 1; page <= MAX_PAGES_PER_SEARCH; page++) {
        let groups: PracujGroup[]
        try {
          groups = await fetchPage(path, page)
        } catch (e) {
          errors.push(`${path} page ${page}: ${(e as Error).message}`)
          break // stop paginating this search on error
        }
        if (!groups.length) break

        for (const g of groups) {
          if (seen.has(g.groupId)) continue
          seen.add(g.groupId)
          const job = buildRawJob(g)
          if (!job) continue
          jobs.push(job)
          if (ctx.maxResults && jobs.length >= ctx.maxResults) {
            return { source: this.source, jobs, errors }
          }
        }
        await sleep(REQUEST_DELAY_MS)
      }
    }

    return { source: this.source, jobs, errors }
  },
}
