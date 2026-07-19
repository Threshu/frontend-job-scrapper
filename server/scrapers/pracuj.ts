import * as cheerio from 'cheerio'
import type {
  JobScraper, RawJob, ScrapeContext, ScrapeResult,
  ContractType, Experience,
} from './types'
import { fmtErr } from './types'

// Pracuj.pl exposes a JSON API at massachusetts.pracuj.pl that powers their
// SPA — no Playwright needed. The endpoint returns the same groupedOffers
// structure as __NEXT_DATA__, so all parsing helpers are unchanged.
//
// Endpoint: GET /jobOffers/listing/grouped
// Pagination: offset + limit params; metadata.total gives the cap.
const API_BASE = 'https://massachusetts.pracuj.pl/jobOffers/listing/grouped'
const KEYWORDS = ['vue.js', 'nuxt.js', 'react.js', 'typescript', 'frontend developer', 'javascript']
const PAGE_SIZE = 100

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
  aiSummary?: string
  technologies?: string[]
  salaryDisplayText?: string | null
  lastPublicated?: string
  workModes?: string[]
  positionLevels?: string[]
  typesOfContract?: string[]
  offers?: PracujOffer[]
}

interface PracujApiResponse {
  groupedOffers: PracujGroup[]
  metadata: {
    offset: number
    limit: number
    size: number
    total: number
  }
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
  const firstOffer = g.offers?.[0]
  const url = firstOffer?.offerAbsoluteUri?.split('?')[0] ?? `https://www.pracuj.pl/praca/${g.groupId}`
  // API listing includes a truncated jobDescription + an AI summary in HTML.
  // Combine both so the Vue detector has the best chance of matching keywords.
  const description = [
    htmlToText(g.jobDescription),
    htmlToText(g.aiSummary),
  ].filter(Boolean).join('\n\n')
  const sal = parseSalary(g.salaryDisplayText ?? undefined)
  const isRemote = (g.workModes ?? []).some((w) => /zdalna|remote/i.test(w))
  return {
    source: 'pracuj',
    sourceId: g.groupId,
    url,
    title: g.jobTitle,
    company: g.companyName,
    location: firstOffer?.displayWorkplace,
    remote: isRemote,
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

function apiHeaders(keyword: string): HeadersInit {
  return {
    'Accept': 'application/json',
    'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
    'Referer': `https://it.pracuj.pl/praca/${encodeURIComponent(keyword)};kw`,
    'Origin': 'https://it.pracuj.pl',
  }
}

export const pracujScraper: JobScraper = {
  source: 'pracuj',
  displayName: 'Pracuj.pl',
  capabilities: { needsBrowser: false, supportsKeywordFilter: true },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const jobs: RawJob[] = []
    const seen = new Set<string>()

    for (const keyword of KEYWORDS) {
      let offset = 0
      let total = Infinity

      while (offset < total) {
        const url = new URL(API_BASE)
        url.searchParams.set('keyword', keyword)
        url.searchParams.set('languageCode', 'pl')
        url.searchParams.set('offset', String(offset))
        url.searchParams.set('limit', String(PAGE_SIZE))
        url.searchParams.set('sc', '0')
        url.searchParams.set('source', 'pracujpl')
        url.searchParams.set('context', 'list')

        let data: PracujApiResponse
        try {
          const res = await fetch(url.toString(), {
            headers: apiHeaders(keyword),
            signal: ctx.signal,
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          data = await res.json() as PracujApiResponse
        } catch (e) {
          errors.push(`keyword "${keyword}" offset=${offset}: ${fmtErr(e)}`)
          break
        }

        const groups = data.groupedOffers ?? []
        if (data.metadata?.total !== undefined) total = data.metadata.total

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

        offset += groups.length
        if (groups.length < PAGE_SIZE) break
      }
    }

    return { source: this.source, jobs, errors }
  },
}
