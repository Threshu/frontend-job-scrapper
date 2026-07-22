import * as cheerio from 'cheerio'
import type {
  JobScraper, RawJob, ScrapeContext, ScrapeResult,
} from './types'
import { fmtErr } from './types'

// LinkedIn's guest job feed is served by an unauthenticated endpoint used by
// their public job search page:
//   /jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=&location=&start=N
// It returns an HTML fragment of <li> cards, 25 per page. The card carries
// the job ID, title, company, location and URL — but not the description.
// Detail comes from /jobs-guest/jobs/api/jobPosting/{id}, also HTML.
//
// We submit a few queries to widen the net (Vue explicit + frontend/JS broad).
const KEYWORDS = ['vue', 'nuxt', 'frontend developer', 'vue.js developer']
const LOCATION = 'Poland'
const MAX_CARDS_PER_KEYWORD = 300    // LinkedIn caps search results at ~300–750 per query

// A small UA pool — LinkedIn silently returns empty pages when one User-Agent
// gets soft-throttled. Rotating per keyword keeps each "session" looking fresh.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
]

function headersFor(uaIdx: number): HeadersInit {
  return {
    'User-Agent': USER_AGENTS[uaIdx % USER_AGENTS.length],
    Accept: 'text/html,*/*',
    'Accept-Language': 'en-US,en;q=0.9,pl;q=0.8',
  }
}

interface CardRaw {
  id: string
  title: string
  company: string
  location: string
  url: string
  postedAt?: string
}

async function fetchSearchPage(keyword: string, start: number, uaIdx: number, signal?: AbortSignal): Promise<string> {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(keyword)}&location=${encodeURIComponent(LOCATION)}&start=${start}`
  const res = await fetch(url, { headers: headersFor(uaIdx), signal: withTimeout(REQUEST_TIMEOUT_MS, signal) })
  if (res.status === 429) throw Object.assign(new Error(`LI search ${keyword} start=${start} → HTTP 429`), { is429: true })
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

// Returns null when the posting is closed or gone (404 / "no longer accepting applications").
async function fetchDetailDescription(jobId: string, uaIdx: number, signal?: AbortSignal): Promise<string | null> {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`
  const res = await fetch(url, { headers: headersFor(uaIdx), signal: withTimeout(REQUEST_TIMEOUT_MS, signal) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`LI detail ${jobId} → HTTP ${res.status}`)
  const html = await res.text()
  const $ = cheerio.load(html)
  if (
    $('.closed-job').length > 0 ||
    $('[class*="closed-job"]').length > 0 ||
    /no longer accepting|closed-job/i.test(html)
  ) return null
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

const LIST_DELAY_MS = 700     // between search-page fetches
const KEYWORD_DELAY_MS = 10_000  // between keyword switches — avoids 429 burst at keyword boundary
const SEARCH_429_BACKOFF_MS = 22_000  // back-off before one retry when search page returns 429
const DETAIL_DELAY_MS = 800   // between detail fetches (429 happens here)
const REQUEST_TIMEOUT_MS = 20_000
// When this many consecutive detail fetches fail with a connection error
// (ECONNRESET / ECONNREFUSED / timeout), LinkedIn is blocking us for this run;
// stop fetching details and save the remaining cards without descriptions.
const MAX_CONSECUTIVE_CONN_ERRORS = 5

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Returns a signal that aborts after `ms` milliseconds, respecting the parent
// signal too. Works on Node 18+ (AbortSignal.timeout is Node 17.3+).
function withTimeout(ms: number, parent?: AbortSignal): AbortSignal {
  const ctrl = new AbortController()
  const id = setTimeout(() => ctrl.abort(new Error(`timeout after ${ms}ms`)), ms)
  parent?.addEventListener('abort', () => { clearTimeout(id); ctrl.abort(parent.reason) }, { once: true })
  return ctrl.signal
}

export const linkedinScraper: JobScraper = {
  source: 'linkedin',
  displayName: 'LinkedIn',
  capabilities: { needsBrowser: false, supportsKeywordFilter: true },
  // Rate-limit-sensitive and slow (5+ min per full run). Running every hour is
  // plenty for a job board — LinkedIn doesn't publish faster than that.
  cronIntervalMinutes: 60,

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const jobs: RawJob[] = []
    const closedIds: string[] = []
    const seen = new Set<string>()
    const cards: CardRaw[] = []

    for (let kwIdx = 0; kwIdx < KEYWORDS.length; kwIdx++) {
      const kw = KEYWORDS[kwIdx]
      if (kwIdx > 0) await sleep(KEYWORD_DELAY_MS)   // cool down between keywords
      let start = 0
      let consecutiveEmpty = 0
      while (start < MAX_CARDS_PER_KEYWORD) {
        let page: CardRaw[] | null = null
        try {
          page = parseSearchCards(await fetchSearchPage(kw, start, kwIdx, ctx.signal))
        } catch (e) {
          const err = e as Error & { is429?: boolean }
          if (err.is429) {
            // Back off and retry once with a fresh UA before giving up on this keyword
            await sleep(SEARCH_429_BACKOFF_MS)
            try {
              page = parseSearchCards(await fetchSearchPage(kw, start, kwIdx + 1, ctx.signal))
            } catch (e2) {
              errors.push(`search "${kw}" start=${start}: ${fmtErr(e2)}`)
              break
            }
          } else {
            errors.push(`search "${kw}" start=${start}: ${fmtErr(e)}`)
            break
          }
        }
        if (!page || !page.length) {
          consecutiveEmpty++
          // First page empty often means LinkedIn returned a soft-throttle. Retry
          // once with a different UA after a longer sleep before giving up.
          if (start === 0 && consecutiveEmpty === 1) {
            await sleep(LIST_DELAY_MS * 6)
            try {
              page = parseSearchCards(await fetchSearchPage(kw, start, kwIdx + 1, ctx.signal))
            } catch {}
          }
          if (!page || !page.length) break
          consecutiveEmpty = 0
        }
        for (const c of page) {
          if (seen.has(c.id)) continue
          seen.add(c.id)
          cards.push(c)
        }
        start += page.length   // advance by actual count returned, not a fixed stride
        await sleep(LIST_DELAY_MS)
      }
    }

    let consecutiveConnErrors = 0
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i]
      try {
        const desc = await fetchDetailDescription(c.id, i, ctx.signal)
        consecutiveConnErrors = 0
        if (desc === null) { closedIds.push(c.id); continue }
        jobs.push(buildRawJob(c, desc))
      } catch (e) {
        const msg = (e as Error).message
        const isConnError = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|timeout/i.test(msg)
        if (isConnError) {
          consecutiveConnErrors++
          if (consecutiveConnErrors >= MAX_CONSECUTIVE_CONN_ERRORS) {
            errors.push(`detail fetches blocked after ${consecutiveConnErrors} consecutive connection errors — saving remaining ${cards.length - i} cards without descriptions`)
            for (let j = i; j < cards.length; j++) jobs.push(buildRawJob(cards[j], ''))
            break
          }
        } else {
          consecutiveConnErrors = 0
        }
        // 429 rate-limit on detail — save card without description rather than discarding it
        if (!msg.includes('429')) errors.push(`detail ${c.id}: ${fmtErr(e)}`)
        jobs.push(buildRawJob(c, ''))
      }
      if (ctx.maxResults && jobs.length >= ctx.maxResults) {
        return { source: this.source, jobs, errors }
      }
      await sleep(DETAIL_DELAY_MS)
    }

    return { source: this.source, jobs, errors, closedIds }
  },
}
