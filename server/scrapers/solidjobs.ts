import * as cheerio from 'cheerio'
import type { JobScraper, RawJob, ScrapeContext, ScrapeResult } from './types'
import { fetchPageHtml } from '../lib/browser'

// solid.jobs renders its listings client-side; cheerio against the raw
// document yields nothing. We let Chromium hydrate the page first.
const LIST_PAGES = [
  'https://solid.jobs/offers/programming',
  'https://solid.jobs/offers/programming?keyword=vue',
  'https://solid.jobs/offers/programming?keyword=javascript',
]

interface Card { href: string; title: string; company: string; location?: string; tags: string[] }

function parseCards(html: string): Card[] {
  const $ = cheerio.load(html)
  const cards: Card[] = []
  // The offer card is anchored on a link to /offers/{slug}. We pull
  // surrounding metadata from the card container regardless of exact class.
  $('a[href^="/offers/"]').each((_, a) => {
    const $a = $(a)
    const href = $a.attr('href') ?? ''
    if (!/\/offers\/[a-z0-9-]+/i.test(href)) return
    const text = $a.text().replace(/\s+/g, ' ').trim()
    if (!text) return
    const $card = $a.closest('article, li, div')
    const title = $card.find('h2, h3, h4, .sj-offers-head-title').first().text().trim() || text.split(/\s{2,}/)[0]
    const company = $card.find('.sj-company, [class*="company"]').first().text().trim()
    const location = $card.find('[class*="location"], [class*="city"]').first().text().trim()
    const tags: string[] = []
    $card.find('[class*="tag"], [class*="tech"], [class*="skill"]').each((__, t) => {
      const tx = $(t).text().trim()
      if (tx && tx.length < 40) tags.push(tx)
    })
    if (title && company) {
      cards.push({ href, title, company, location: location || undefined, tags })
    }
  })
  return cards
}

async function fetchDetail(href: string): Promise<string> {
  const url = `https://solid.jobs${href}`
  try {
    const html = await fetchPageHtml(url, { waitForSelector: 'main, article, .sj-offers-main' })
    const $ = cheerio.load(html)
    const main = $('.sj-offer-description, .sj-offers-main, main, article').first().text()
    return main.replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

function buildRawJob(c: Card, description: string): RawJob {
  const slug = c.href.replace(/^\//, '').replace(/\/$/, '')
  return {
    source: 'solidjobs',
    sourceId: slug,
    url: `https://solid.jobs${c.href}`,
    title: c.title,
    company: c.company,
    location: c.location,
    remote: /remote|zdaln/i.test(c.location ?? ''),
    description,
    skills: c.tags,
  }
}

const REQUEST_DELAY_MS = 400

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const solidJobsScraper: JobScraper = {
  source: 'solidjobs',
  displayName: 'solid.jobs',
  capabilities: { needsBrowser: true, supportsKeywordFilter: true },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const jobs: RawJob[] = []
    const seen = new Set<string>()
    const cards: Card[] = []

    for (const url of LIST_PAGES) {
      try {
        const html = await fetchPageHtml(url, { waitForSelector: 'a[href^="/offers/"]', timeoutMs: 30_000 })
        for (const c of parseCards(html)) {
          if (seen.has(c.href)) continue
          seen.add(c.href)
          cards.push(c)
        }
      } catch (e) {
        errors.push(`list ${url}: ${(e as Error).message}`)
      }
      await sleep(REQUEST_DELAY_MS)
    }

    for (const c of cards) {
      try {
        const desc = await fetchDetail(c.href)
        jobs.push(buildRawJob(c, desc))
        if (ctx.maxResults && jobs.length >= ctx.maxResults) {
          return { source: this.source, jobs, errors }
        }
      } catch (e) {
        errors.push(`detail ${c.href}: ${(e as Error).message}`)
        jobs.push(buildRawJob(c, ''))
      }
      await sleep(REQUEST_DELAY_MS)
    }

    return { source: this.source, jobs, errors }
  },
}
