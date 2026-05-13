import * as cheerio from 'cheerio'
import type { JobScraper, RawJob, ScrapeContext, ScrapeResult } from './types'
import { fetchPageHtml } from '../lib/browser'

// 4programmers.net is a community board. Listings are client-rendered (the
// initial HTML shows skeleton placeholders) so we render with Chromium and
// then parse the populated DOM.
const LIST_PAGES = [
  'https://4programmers.net/Praca?tags%5B%5D=javascript',
  'https://4programmers.net/Praca?tags%5B%5D=vue.js',
  'https://4programmers.net/Praca?tags%5B%5D=typescript',
]

interface Card { href: string; title: string; company: string; location?: string; tags: string[] }

function parseCards(html: string): Card[] {
  const $ = cheerio.load(html)
  const cards: Card[] = []
  $('.card-job').each((_, el) => {
    const $card = $(el)
    const $link = $card.find('a[href*="/Praca/"]').first()
    const href = $link.attr('href') ?? ''
    if (!href) return
    const title = $link.text().trim() || $card.find('h3, h4, .media-heading').first().text().trim()
    const company = $card.find('.firm-name, [class*="firm"], [class*="company"]').first().text().trim()
    const location = $card.find('[class*="location"], [class*="city"]').first().text().trim()
    const tags: string[] = []
    $card.find('.tag, .badge, [class*="tag"]').each((__, t) => {
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
  const url = href.startsWith('http') ? href : `https://4programmers.net${href}`
  try {
    const html = await fetchPageHtml(url, { waitForSelector: 'main, article, .job-description' })
    const $ = cheerio.load(html)
    const text = $('.job-description, main, article').first().text()
    return text.replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

function buildRawJob(c: Card, description: string): RawJob {
  return {
    source: '4programmers',
    sourceId: c.href.split('/').filter(Boolean).join('-'),
    url: c.href.startsWith('http') ? c.href : `https://4programmers.net${c.href}`,
    title: c.title,
    company: c.company,
    location: c.location,
    remote: /remote|zdaln/i.test(c.location ?? ''),
    description,
    skills: c.tags,
  }
}

const REQUEST_DELAY_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const fourProgrammersScraper: JobScraper = {
  source: '4programmers',
  displayName: '4programmers.net',
  capabilities: { needsBrowser: true, supportsKeywordFilter: true },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const jobs: RawJob[] = []
    const seen = new Set<string>()
    const cards: Card[] = []

    for (const url of LIST_PAGES) {
      try {
        const html = await fetchPageHtml(url, { waitForSelector: '.card-job:not(:has(.skeleton))', timeoutMs: 30_000 })
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
