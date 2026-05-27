import * as cheerio from 'cheerio'
import type {
  JobScraper, RawJob, ScrapeContext, ScrapeResult,
} from './types'

// praca.pl — Poland's #2 general job board (~4M monthly users).
// IT listings are reachable via keyword-based URL slugs. The HTML is SSR —
// no JavaScript rendering or Cloudflare protection needed (Cheerio is enough).
//
// URL pattern: /s-{keyword}.html → page 2: /s-{keyword}_2.html
// Each page returns ~20 job listings in <li> elements.
//
// Structure of each <li>:
//   <h3><a href="/[slug]_[id].html">Title</a></h3>
//   <a href="[id],[company-slug],[city],firma.html">Company</a>
//   location text node
//   optional salary text node ("X XXX zł brutto/mies.")
const BASE = 'https://www.praca.pl'

const SEARCH_SLUGS = [
  's-vue',
  's-javascript',
  's-frontend-developer',
]
const MAX_PAGES_PER_SLUG = 3

const HEADERS: HeadersInit = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pl,en;q=0.8',
}

function parseSalary(text: string): { min?: number; max?: number } {
  // "2 500 - 3 500 zł brutto/mies." | "5 000 zł brutto/mies."
  const cleaned = text.replace(/\s/g, '')
  const range = cleaned.match(/(\d+)-(\d+)/)
  if (range) return { min: Number(range[1]), max: Number(range[2]) }
  const single = cleaned.match(/(\d{4,})/)
  if (single) return { min: Number(single[1]) }
  return {}
}

function extractJobs(html: string, seen: Set<string>): RawJob[] {
  const $ = cheerio.load(html)
  const results: RawJob[] = []

  $('li').each((_, li) => {
    const $li = $(li)

    // Title + URL
    const $titleLink = $li.find('h3 a').first()
    const title = $titleLink.text().trim()
    if (!title) return

    const relHref = $titleLink.attr('href') ?? ''
    if (!relHref) return

    // sourceId: extract the numeric ID from /slug_12345678.html
    const idMatch = relHref.match(/_(\d+)\.html$/)
    const sourceId = idMatch ? idMatch[1] : relHref
    if (seen.has(sourceId)) return
    seen.add(sourceId)

    const url = relHref.startsWith('http') ? relHref : `${BASE}${relHref}`

    // Company: the <a> whose href matches the "firma.html" pattern
    const $companyLink = $li.find('a[href*="firma.html"]').first()
    const company = $companyLink.text().trim()

    // Location: plain text node after company link — grab all text, strip
    // known non-location fragments (title, company, salary)
    const allText = $li.text()
    const locationCandidate = allText
      .replace(title, '')
      .replace(company, '')
      .replace(/pokaż opis/gi, '')
      .replace(/\d[\d\s]*[-–]\d[\d\s]*\s*zł.*/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    // Take first short segment as location (city name is usually ≤ 30 chars)
    const location = locationCandidate.split(/[,\n]/)[0].trim() || undefined

    // Salary: look for "zł" text node
    const salaryText = $li.text().match(/[\d\s]+([-–][\d\s]+)?\s*zł[^.]*/)
    const sal = salaryText ? parseSalary(salaryText[0]) : {}

    results.push({
      source: 'pracapl',
      sourceId,
      url,
      title,
      company,
      location,
      remote: /zdaln|remote/i.test(allText),
      salaryMin: sal.min,
      salaryMax: sal.max,
      currency: sal.min || sal.max ? 'PLN' : undefined,
      salaryPeriod: 'month',
      description: '',
      skills: [],
    })
  })

  return results
}

async function fetchPage(slug: string, page: number, signal?: AbortSignal): Promise<string> {
  const suffix = page > 1 ? `_${page}` : ''
  const url = `${BASE}/${slug}${suffix}.html`
  const res = await fetch(url, { headers: HEADERS, signal })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`)
  return res.text()
}

const REQUEST_DELAY_MS = 300

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const pracaplScraper: JobScraper = {
  source: 'pracapl',
  displayName: 'praca.pl',
  capabilities: { needsBrowser: false, supportsKeywordFilter: true },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const jobs: RawJob[] = []
    const seen = new Set<string>()

    for (const slug of SEARCH_SLUGS) {
      for (let page = 1; page <= MAX_PAGES_PER_SLUG; page++) {
        let html: string
        try {
          html = await fetchPage(slug, page, ctx.signal)
        } catch (e) {
          errors.push(`${slug} page ${page}: ${(e as Error).message}`)
          break
        }

        const pageJobs = extractJobs(html, seen)
        if (!pageJobs.length) break

        for (const job of pageJobs) {
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
