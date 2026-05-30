import * as cheerio from 'cheerio'
import type {
  JobScraper, RawJob, ScrapeContext, ScrapeResult,
  ContractType, Experience,
} from './types'

// crossweb.pl is a Polish IT community portal with a curated job board.
// The list page loads job cards via JavaScript (bob.js.php), so we can't
// scrape them from the initial HTML. Instead:
//   1. Extract all job detail URLs from hrefs in the list page HTML.
//   2. Fetch each detail page individually — they ARE server-side rendered.
//
// Detail page data sits in <div class="param-element"> blocks.
const LIST_URL = 'https://crossweb.pl/en/job/job-offers/'

const HEADERS: HeadersInit = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en,pl;q=0.8',
}

function parseSalary(text: string): { min?: number; max?: number; currency?: string; contractType?: ContractType } {
  if (!text) return {}
  const contractType: ContractType | undefined =
    /\bb2b\b/i.test(text) ? 'b2b' :
    /\buop\b|employment|umowa o prac/i.test(text) ? 'permanent' :
    undefined
  const currency =
    /pln|zł|zl/i.test(text) ? 'PLN' :
    /usd|\$/i.test(text) ? 'USD' :
    /eur|€/i.test(text) ? 'EUR' : undefined

  const cleaned = text.replace(/\s/g, '')
  const range = cleaned.match(/([\d,.]+k?)\s*[–\-]\s*([\d,.]+k?)/i)
  const parseNum = (s: string): number => {
    const hasK = /k$/i.test(s)
    return Math.round(Number(s.replace(/k$/i, '').replace(',', '.')) * (hasK ? 1000 : 1))
  }
  if (range) return { min: parseNum(range[1]), max: parseNum(range[2]), currency, contractType }
  const single = cleaned.match(/([\d,]{4,})/i)
  if (single) return { min: parseNum(single[1]), currency, contractType }
  return { currency, contractType }
}

function mapLevel(text: string): Experience | undefined {
  const t = text.toLowerCase()
  if (t.includes('junior')) return 'junior'
  if (t.includes('senior') || t.includes('expert') || t.includes('lead')) return 'senior'
  if (t.includes('mid') || t.includes('regular') || t.includes('medior')) return 'mid'
  return undefined
}

async function fetchHtml(url: string, signal?: AbortSignal): Promise<string> {
  let res = await fetch(url, { headers: HEADERS, signal })
  if (res.status >= 500) {
    await sleep(2000)
    res = await fetch(url, { headers: HEADERS, signal })
  }
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`)
  return res.text()
}

function extractSlugs(html: string): string[] {
  const $ = cheerio.load(html)
  const slugs: string[] = []
  const seen = new Set<string>()
  $('a[href*="/job/job-offers/"]').each((_, el) => {
    const href = $(el).attr('href') ?? ''
    // Only actual job detail hrefs (slug after /job-offers/)
    if (!href.match(/\/job\/job-offers\/[a-z0-9\-]+\/$/)) return
    if (seen.has(href)) return
    seen.add(href)
    slugs.push(href)
  })
  return slugs
}

function parseDetail(html: string, slug: string): RawJob | null {
  const $ = cheerio.load(html)

  // Title from <h1> or <title>
  const title = $('h1').first().text().trim()
    || ($('title').text().split(' - ')[0] ?? '').trim()
  if (!title) return null

  // Company from breadcrumb link pattern: /en/job/[company]/?jobs=1
  let company = ''
  $('a[href*="?jobs=1"]').each((_, el) => {
    const text = $(el).text().trim()
    if (text) { company = text; return false }
  })
  if (!company) {
    // Fallback: extract from <title> "Title - Company - Crossweb"
    const parts = $('title').text().split(' - ')
    company = parts.length >= 2 ? parts[parts.length - 2].trim() : ''
  }

  // Parse all param-element blocks
  const params: Record<string, string> = {}
  const skillParts: string[] = []
  $('div.param-element').each((_, el) => {
    const raw = $(el).text().replace(/\s+/g, ' ').trim()
    // Format: "Key: Label Value" or "Label: Value"
    const m = raw.match(/^([^:]+):\s*(.+)/)
    if (!m) return
    const key = m[1].trim().toLowerCase()
    const val = m[2].trim()
    params[key] = val
    if (key === 'key' || key === 'auxiliary') {
      skillParts.push(val)
    }
  })

  const skills = skillParts
    .join(',')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const sal = parseSalary(params['salary range'] ?? '')
  const experience = mapLevel(params['level'] ?? '')

  const contractFromParam: ContractType | undefined =
    /b2b/i.test(params['contract type'] ?? '') ? 'b2b' :
    /employment|umowa/i.test(params['contract type'] ?? '') ? 'permanent' :
    sal.contractType

  // Location: element with class containing "location"
  const locationEl = $('[class*="location"]').first().text().trim()

  const remote = /remote|zdaln/i.test(locationEl) || /remote/i.test(params['working method'] ?? '')

  // sourceId: slug portion of href
  const sourceId = slug.replace(/^\/|\/$/g, '').split('/').pop() ?? slug

  return {
    source: 'crossweb',
    sourceId,
    url: `https://crossweb.pl${slug}`,
    title,
    company,
    location: locationEl && !remote ? locationEl : undefined,
    remote,
    salaryMin: sal.min,
    salaryMax: sal.max,
    currency: sal.currency,
    salaryPeriod: 'month',
    contractType: contractFromParam,
    experience,
    description: '',
    skills,
  }
}

const REQUEST_DELAY_MS = 300

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const crosswebScraper: JobScraper = {
  source: 'crossweb',
  displayName: 'Crossweb',
  capabilities: { needsBrowser: false, supportsKeywordFilter: false },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const jobs: RawJob[] = []

    let listHtml: string
    try {
      listHtml = await fetchHtml(LIST_URL, ctx.signal)
    } catch (e) {
      errors.push(`list page: ${(e as Error).message}`)
      return { source: this.source, jobs, errors }
    }

    const slugs = extractSlugs(listHtml)

    for (const slug of slugs) {
      try {
        const html = await fetchHtml(`https://crossweb.pl${slug}`, ctx.signal)
        const job = parseDetail(html, slug)
        if (job) jobs.push(job)
      } catch (e) {
        errors.push(`detail ${slug}: ${(e as Error).message}`)
      }

      if (ctx.maxResults && jobs.length >= ctx.maxResults) break
      await sleep(REQUEST_DELAY_MS)
    }

    return { source: this.source, jobs, errors }
  },
}
