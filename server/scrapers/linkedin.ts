import * as cheerio from 'cheerio'
import type {
  JobScraper, RawJob, ScrapeContext, ScrapeResult,
} from './types'

// LinkedIn's guest job feed is served by an unauthenticated endpoint used by
// their public job search page:
//   /jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=&location=&start=N
// It returns an HTML fragment of <li> cards, 25 per page. The card carries
// the job ID, title, company, location and URL — but not the description.
// Detail comes from /jobs-guest/jobs/api/jobPosting/{id}, also HTML.
//
// We submit a few queries to widen the net (Vue explicit + frontend/JS broad).
const KEYWORDS = ['vue', 'frontend developer', 'javascript']
const LOCATION = 'Poland'
const PAGES_PER_KEYWORD = 4         // 4 × 25 = 100 jobs per keyword max
const PAGE_SIZE = 25

const HEADERS: HeadersInit = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,*/*',
  'Accept-Language': 'en-US,en;q=0.9,pl;q=0.8',
}

interface CardRaw {
  id: string
  title: string
  company: string
  location: string
  url: string
  postedAt?: string
}

async function fetchSearchPage(keyword: string, start: number, signal?: AbortSignal): Promise<string> {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(keyword)}&location=${encodeURIComponent(LOCATION)}&start=${start}`
  const res = await fetch(url, { headers: HEADERS, signal })
  if (!res.ok) throw new Error(`LI search ${keyword} start=${start} → HTTP ${res.status}`)
  return res.text()
}

function parseSearchCards(html: string): CardRaw[] {
  const $ = cheerio.load(html)
  const cards: CardRaw[] = []
  $('li').each((_, el) => {
    const $el = $(el)
    const urn = $el.find('[data-entity-urn]').attr('data-entity-urn') || $el.attr('data-entity-urn')
    const id = urn?.split(':').pop()
    if (!id) return
    const link = $el.find('a.base-card__full-link').attr('href') ?? $el.find('a').first().attr('href') ?? ''
    const title = $el.find('.base-search-card__title').text().trim() || $el.find('h3').first().text().trim()
    const company = $el.find('.base-search-card__subtitle a').text().trim() || $el.find('h4 a').first().text().trim()
    const location = $el.find('.job-search-card__location').text().trim()
    const postedAt = $el.find('time').attr('datetime')
    if (!title || !company) return
    cards.push({
      id,
      title,
      company,
      location,
      url: link.split('?')[0],
      postedAt,
    })
  })
  return cards
}

async function fetchDetailDescription(jobId: string, signal?: AbortSignal): Promise<string> {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`
  const res = await fetch(url, { headers: HEADERS, signal })
  if (!res.ok) throw new Error(`LI detail ${jobId} → HTTP ${res.status}`)
  const html = await res.text()
  const $ = cheerio.load(html)
  // The description sits under div.show-more-less-html__markup or
  // .description__text — both contain the rich-text job description.
  const main = $('.show-more-less-html__markup').text() || $('.description__text').text() || $('section.description').text()
  return main.replace(/\s+/g, ' ').trim()
}

function buildRawJob(card: CardRaw, description: string): RawJob {
  return {
    source: 'linkedin',
    sourceId: card.id,
    url: card.url,
    title: card.title,
    company: card.company,
    location: card.location || undefined,
    remote: /remote|zdaln/i.test(card.location),
    description,
    skills: [],          // LinkedIn doesn't expose a structured skill list publicly
    postedAt: card.postedAt,
  }
}

const REQUEST_DELAY_MS = 400

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const linkedinScraper: JobScraper = {
  source: 'linkedin',
  displayName: 'LinkedIn',
  capabilities: { needsBrowser: false, supportsKeywordFilter: true },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const jobs: RawJob[] = []
    const seen = new Set<string>()
    const cards: CardRaw[] = []

    for (const kw of KEYWORDS) {
      for (let p = 0; p < PAGES_PER_KEYWORD; p++) {
        try {
          const html = await fetchSearchPage(kw, p * PAGE_SIZE, ctx.signal)
          const page = parseSearchCards(html)
          if (!page.length) break
          for (const c of page) {
            if (seen.has(c.id)) continue
            seen.add(c.id)
            cards.push(c)
          }
        } catch (e) {
          errors.push(`search "${kw}" start=${p * PAGE_SIZE}: ${(e as Error).message}`)
          break
        }
        await sleep(REQUEST_DELAY_MS)
      }
    }

    for (const c of cards) {
      try {
        const desc = await fetchDetailDescription(c.id, ctx.signal)
        jobs.push(buildRawJob(c, desc))
        if (ctx.maxResults && jobs.length >= ctx.maxResults) {
          return { source: this.source, jobs, errors }
        }
      } catch (e) {
        errors.push(`detail ${c.id}: ${(e as Error).message}`)
        jobs.push(buildRawJob(c, ''))
      }
      await sleep(REQUEST_DELAY_MS)
    }

    return { source: this.source, jobs, errors }
  },
}
