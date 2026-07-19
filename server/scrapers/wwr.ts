import * as cheerio from 'cheerio'
import type { JobScraper, RawJob, ScrapeContext, ScrapeResult } from './types'
import { fmtErr } from './types'

// We Work Remotely exposes public RSS feeds per category. No auth, no anti-bot,
// no rate limiting we've seen — cheapest scraper in the fleet.
// The general programming feed already includes front-end and full-stack items,
// but hitting the sub-category feeds too widens the net a bit and de-dup drops
// duplicates by <guid>.
const FEEDS = [
  'https://weworkremotely.com/categories/remote-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss',
]

const HEADERS: HeadersInit = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
}

// WWR titles are formatted "Company Name: Job Title". First colon separates
// them; job titles themselves may contain further colons which we preserve.
function splitTitle(raw: string): { company: string; title: string } {
  const idx = raw.indexOf(':')
  if (idx < 0) return { company: '', title: raw.trim() }
  return {
    company: raw.slice(0, idx).trim(),
    title: raw.slice(idx + 1).trim(),
  }
}

function htmlToText(html: string): string {
  return cheerio
    .load(`<div>${html}</div>`)('div')
    .text()
    .replace(/\s+/g, ' ')
    .trim()
}

export const wwrScraper: JobScraper = {
  source: 'wwr',
  displayName: 'We Work Remotely',
  capabilities: { needsBrowser: false, supportsKeywordFilter: false },
  // Global remote board, publishes throughout the day but our niche (Vue
  // frontend) is a small slice — hourly is enough.
  cronIntervalMinutes: 60,

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const jobs: RawJob[] = []
    const seen = new Set<string>()

    for (const feed of FEEDS) {
      try {
        const res = await fetch(feed, { headers: HEADERS, signal: ctx.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const xml = await res.text()
        const $ = cheerio.load(xml, { xmlMode: true })
        $('item').each((_, el) => {
          const $el = $(el)
          const url = ($el.find('guid').text() || $el.find('link').text()).trim()
          if (!url || seen.has(url)) return
          seen.add(url)
          const rawTitle = $el.find('title').first().text().trim()
          const { company, title } = splitTitle(rawTitle)
          if (!title || !company) return
          const description = htmlToText($el.find('description').text())
          const region = $el.find('region').text().trim()
          const category = $el.find('category').text().trim()
          const pubDate = $el.find('pubDate').text().trim()
          let postedAt: string | undefined
          if (pubDate) {
            const d = new Date(pubDate)
            if (!Number.isNaN(d.getTime())) postedAt = d.toISOString()
          }
          jobs.push({
            source: 'wwr',
            sourceId: url,
            url,
            title,
            company,
            location: region || 'Remote',
            remote: true,
            // WWR salaries are usually annual USD and inconsistently formatted
            // ("$100k+", "$70,000 - $90,000", "80-120K USD"). Skipped for v1;
            // if this scraper gains traffic we can add a parser.
            description,
            // Category (e.g. "Front-End Programming") feeds our detector as a
            // pseudo-skill so full-stack roles that use Vue still classify well.
            skills: category ? [category] : [],
            postedAt,
          })
        })
      } catch (e) {
        errors.push(`feed ${feed}: ${fmtErr(e)}`)
      }
    }

    return { source: this.source, jobs, errors }
  },
}
