import * as cheerio from 'cheerio'
import type {
  JobScraper, RawJob, ScrapeContext, ScrapeResult,
  ContractType, Experience,
} from './types'
import { fetchPageHtml } from '../lib/browser'

// theprotocol.it is the same publisher as pracuj.pl. The list pages SSR
// the offers in __NEXT_DATA__ but description is NOT in the list — we have
// to fetch the detail page per offer.
const LIST_PAGES = [
  'https://theprotocol.it/filtry/javascript;t',
  'https://theprotocol.it/filtry/frontend;sp',
  'https://theprotocol.it/filtry/vue.js;t',
]
const MAX_PAGES_PER_LIST = 3


interface TProtoListOffer {
  id: string
  groupId: string
  title: string
  employer: string
  offerUrlName: string
  workplace?: Array<{ location?: string; city?: string; region?: string }>
  positionLevels?: Array<{ value: string }>
  typesOfContracts?: Array<{ id: number }>
  technologies?: string[]
  publicationDateUtc?: string
  salary?: { from?: number; to?: number; currency?: string; period?: string; type?: number } | null
  workModes?: string[]
}

function extractNextData(html: string): unknown {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) throw new Error('__NEXT_DATA__ not found')
  return JSON.parse(m[1])
}

function findOffersList(obj: unknown): TProtoListOffer[] | null {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  if (Array.isArray(o.offers) && o.offers.length > 0) {
    const first = o.offers[0] as Partial<TProtoListOffer>
    if (first?.id && first?.title && first?.employer) return o.offers as TProtoListOffer[]
  }
  for (const k of Object.keys(o)) {
    const r = findOffersList(o[k])
    if (r) return r
  }
  return null
}

function mapExperience(lv?: Array<{ value: string }>): Experience | undefined {
  if (!lv?.length) return undefined
  const v = lv[0].value.toLowerCase()
  if (v.includes('junior')) return 'junior'
  if (v.includes('senior') || v.includes('expert')) return 'senior'
  if (v.includes('mid') || v.includes('regular')) return 'mid'
  return undefined
}

// theProtocol uses contract type IDs we don't have a full mapping for; we
// expose the first one as a best-effort guess.
function mapContract(types?: Array<{ id: number }>): ContractType | undefined {
  if (!types?.length) return undefined
  const id = types[0].id
  if (id === 0) return 'permanent'
  if (id === 1) return 'b2b'
  if (id === 2) return 'mandate'
  return undefined
}

function htmlToText(s: string | undefined): string {
  if (!s) return ''
  return cheerio.load(`<div>${s}</div>`)('div').text().replace(/\s+/g, ' ').trim()
}

async function fetchListPage(url: string, page: number): Promise<TProtoListOffer[]> {
  const fullUrl = page > 1 ? `${url}?pageNumber=${page}` : url
  const html = await fetchPageHtml(fullUrl, { waitForSelector: 'script#__NEXT_DATA__' })
  const data = extractNextData(html)
  return findOffersList(data) ?? []
}

async function fetchDetailDescription(offerUrlName: string): Promise<string> {
  // Detail URL: https://theprotocol.it/szczegoly/{offerUrlName}
  const url = `https://theprotocol.it/szczegoly/${offerUrlName}`
  let html: string
  try {
    html = await fetchPageHtml(url, { waitForSelector: 'script#__NEXT_DATA__' })
  } catch {
    return ''
  }
  const data = extractNextData(html) as unknown
  // The detail blob lives under pageProps; we walk and find a field that
  // looks like the description.
  function findDesc(obj: unknown): string | null {
    if (!obj || typeof obj !== 'object') return null
    const o = obj as Record<string, unknown>
    for (const k of ['responsibilities', 'aboutProject', 'description', 'projectDescription', 'aboutProjectShortDescription']) {
      if (typeof o[k] === 'string' && (o[k] as string).length > 30) return o[k] as string
      if (Array.isArray(o[k])) {
        const arr = o[k] as unknown[]
        const text = arr.map((x) => (typeof x === 'string' ? x : (x as Record<string, unknown>)?.value ?? '')).join(' ')
        if (text.length > 30) return text
      }
    }
    for (const v of Object.values(o)) {
      const r = findDesc(v)
      if (r) return r
    }
    return null
  }
  return htmlToText(findDesc(data) ?? '')
}

function buildRawJob(o: TProtoListOffer, description: string): RawJob {
  return {
    source: 'theprotocol',
    sourceId: o.id,
    url: `https://theprotocol.it/szczegoly/${o.offerUrlName}`,
    title: o.title,
    company: o.employer,
    location: o.workplace?.[0]?.city ?? o.workplace?.[0]?.location,
    remote: (o.workModes ?? []).some((w) => /zdaln|remote/i.test(w)),
    salaryMin: o.salary?.from,
    salaryMax: o.salary?.to,
    currency: o.salary?.currency,
    salaryPeriod: o.salary?.period && /h|hour|godz/i.test(o.salary.period) ? 'hour' : 'month',
    contractType: mapContract(o.typesOfContracts),
    experience: mapExperience(o.positionLevels),
    description,
    skills: o.technologies ?? [],
    postedAt: o.publicationDateUtc,
  }
}

const REQUEST_DELAY_MS = 250

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const theProtocolScraper: JobScraper = {
  source: 'theprotocol',
  displayName: 'theProtocol.it',
  capabilities: { needsBrowser: true, supportsKeywordFilter: true },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const jobs: RawJob[] = []
    const seen = new Set<string>()
    const listSeed: TProtoListOffer[] = []

    for (const url of LIST_PAGES) {
      for (let page = 1; page <= MAX_PAGES_PER_LIST; page++) {
        let offers: TProtoListOffer[]
        try {
          offers = await fetchListPage(url, page)
        } catch (e) {
          errors.push(`${url} page ${page}: ${(e as Error).message}`)
          break
        }
        if (!offers.length) break
        for (const o of offers) {
          if (seen.has(o.id)) continue
          seen.add(o.id)
          listSeed.push(o)
        }
        await sleep(REQUEST_DELAY_MS)
      }
    }

    for (const o of listSeed) {
      try {
        const description = await fetchDetailDescription(o.offerUrlName)
        jobs.push(buildRawJob(o, description))
        if (ctx.maxResults && jobs.length >= ctx.maxResults) {
          return { source: this.source, jobs, errors }
        }
      } catch (e) {
        errors.push(`detail ${o.id}: ${(e as Error).message}`)
        jobs.push(buildRawJob(o, ''))
      }
      await sleep(REQUEST_DELAY_MS)
    }

    return { source: this.source, jobs, errors }
  },
}
