import * as cheerio from 'cheerio'
import type { JobScraper, RawJob, ScrapeContext, ScrapeResult } from './types'
import { fmtErr } from './types'

// javascript.jobs (formerly jsremotely.com — the domain 301s to here) is a
// plain SSR job board dedicated to JS/TS roles. No API, no anti-bot — cheerio
// against the raw HTML is enough.
//
// Structure per card (as of 2026-07):
//   <a href="/job/<slug>">
//     <h3>Job Title</h3>
//     <span>0D</span>          -- posted N days/weeks/months ago
//     <span>Full Time Remote</span>
//     <span>Salary: $X - $Y</span>
//     <img alt="..." src="...">
//     <span>Company Name</span>
//   </a>
const BASE = 'https://javascript.jobs'
// 3 pages × 20 offers = ~60 jobs. javascript.jobs paginates up to ~77 pages
// but oldest entries are already covered by RemoteOK / Remotive.
const MAX_PAGES = 3

const HEADERS: HeadersInit = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

async function fetchListPage(page: number, signal?: AbortSignal): Promise<string> {
  const url = page === 1 ? `${BASE}/remote` : `${BASE}/remote?page=${page}`
  const res = await fetch(url, { headers: HEADERS, signal })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`)
  return res.text()
}

// "0D" / "2W" / "1M" → ISO date. Approximate — good enough for staleness.
function agoToIso(s: string): string | undefined {
  const m = s.trim().match(/^(\d+)\s*([DWM])$/i)
  if (!m) return undefined
  const n = Number(m[1])
  const unit = m[2].toUpperCase()
  const ms =
    unit === 'D' ? n * 86_400_000 :
    unit === 'W' ? n * 7 * 86_400_000 :
    unit === 'M' ? n * 30 * 86_400_000 : 0
  return new Date(Date.now() - ms).toISOString()
}

const JOB_TYPE_HINTS = ['full time', 'part time', 'contract', 'freelance']

interface Card {
  url: string
  title: string
  company: string
  remote: boolean
  postedAt?: string
}

function parseCards(html: string): Card[] {
  const $ = cheerio.load(html)
  const cards: Card[] = []

  $('a[href*="/job/"]').each((_, el) => {
    const $el = $(el)
    const href = ($el.attr('href') ?? '').trim()
    if (!href) return
    const url = href.startsWith('http') ? href.split('?')[0] : `${BASE}${href}`.split('?')[0]
    const title = $el.find('h3').first().text().trim()
    if (!title) return

    // Collect span texts and classify — company is whatever isn't a badge,
    // date, or salary line. Falls back to img alt if no candidate remains.
    const spans = $el.find('span').toArray().map((s) => $(s).text().trim()).filter(Boolean)
    const isDate = (s: string) => /^\d+\s*[DWM]$/i.test(s)
    const isSalary = (s: string) => /^\$|salary:/i.test(s)
    const isType = (s: string) => {
      const l = s.toLowerCase()
      return JOB_TYPE_HINTS.some((h) => l.includes(h)) || l.includes('remote') || l.includes('hybrid')
    }
    const companyCandidates = spans.filter((s) => !isDate(s) && !isSalary(s) && !isType(s))
    const company = (companyCandidates[companyCandidates.length - 1] ?? $el.find('img').attr('alt') ?? '').trim()
    if (!company) return

    const dateSpan = spans.find(isDate)
    const typeSpan = spans.find(isType) ?? ''
    const remote = /remote/i.test(typeSpan) || true // /remote listing feed, everything is remote

    cards.push({
      url,
      title,
      company,
      remote,
      postedAt: dateSpan ? agoToIso(dateSpan) : undefined,
    })
  })

  // Dedup by URL — same job can appear as "featured" and "latest".
  const seen = new Set<string>()
  return cards.filter((c) => {
    if (seen.has(c.url)) return false
    seen.add(c.url)
    return true
  })
}

function cardToJob(c: Card): RawJob {
  // Extract the slug tail for a stable sourceId — the full URL sometimes has
  // trailing digits ("-4") which change per repost, but we accept it as-is
  // since the whole URL is unique enough.
  const slugMatch = c.url.match(/\/job\/([^/?#]+)/)
  const sourceId = slugMatch ? slugMatch[1] : c.url
  return {
    source: 'jsjobs',
    sourceId,
    url: c.url,
    title: c.title,
    company: c.company,
    location: 'Remote',
    remote: c.remote,
    // No description on the list page and hitting the detail page for every
    // job would add 60+ HTTP calls per run. The Vue detector will run on
    // title alone, which catches "Vue Developer" cleanly — jobs where Vue is
    // only in the body will slip past but that's an acceptable false negative.
    description: '',
    skills: [],
    postedAt: c.postedAt,
  }
}

const LIST_DELAY_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const javascriptJobsScraper: JobScraper = {
  source: 'jsjobs',
  displayName: 'javascript.jobs',
  capabilities: { needsBrowser: false, supportsKeywordFilter: false },
  cronIntervalMinutes: 60,

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const jobs: RawJob[] = []
    const seenIds = new Set<string>()

    for (let page = 1; page <= MAX_PAGES; page++) {
      let html: string
      try {
        html = await fetchListPage(page, ctx.signal)
      } catch (e) {
        errors.push(`list page ${page}: ${fmtErr(e)}`)
        break
      }
      const cards = parseCards(html)
      if (!cards.length) break
      for (const c of cards) {
        const job = cardToJob(c)
        if (seenIds.has(job.sourceId)) continue
        seenIds.add(job.sourceId)
        jobs.push(job)
        if (ctx.maxResults && jobs.length >= ctx.maxResults) {
          return { source: this.source, jobs, errors }
        }
      }
      await sleep(LIST_DELAY_MS)
    }

    return { source: this.source, jobs, errors }
  },
}
