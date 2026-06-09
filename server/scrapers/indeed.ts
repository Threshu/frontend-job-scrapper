import * as cheerio from 'cheerio'
import type { JobScraper, RawJob, ScrapeContext, ScrapeResult } from './types'
import { fetchPageHtml } from '../lib/browser'

// Indeed.pl 403s plain fetch requests. With Chromium we can pull the
// rendered HTML, but their bot defense still surfaces a CAPTCHA sometimes —
// the scraper degrades gracefully: failures land in `errors`, partial
// listings still flow through.
const KEYWORDS = ['vue', 'nuxt', 'frontend developer', 'javascript']
const PAGES_PER_KW = 3 // pages of 10 results each

interface Card { jobKey: string; title: string; company: string; location?: string; salary?: string; postedDays?: string }

function parseCards(html: string): Card[] {
  const $ = cheerio.load(html)
  const cards: Card[] = []
  $('a.tapItem, a[data-jk], div.job_seen_beacon').each((_, el) => {
    const $el = $(el)
    const jk = $el.attr('data-jk') ?? $el.find('[data-jk]').attr('data-jk') ?? ''
    if (!jk) return
    const title = $el.find('h2 span[title], h2 a span, [class*="jobTitle"]').first().text().trim()
    const company = $el.find('[data-testid="company-name"], [class*="companyName"]').first().text().trim()
    const location = $el.find('[data-testid="text-location"], [class*="companyLocation"]').first().text().trim()
    const salary = $el.find('[class*="salary-snippet"], [data-testid="attribute_snippet_testid"]').first().text().trim()
    if (title && company) {
      cards.push({ jobKey: jk, title, company, location: location || undefined, salary: salary || undefined })
    }
  })
  return cards
}

async function fetchDetail(jobKey: string): Promise<string> {
  const url = `https://pl.indeed.com/viewjob?jk=${jobKey}`
  try {
    const html = await fetchPageHtml(url, { waitForSelector: '#jobDescriptionText, [id*="jobDescription"]', timeoutMs: 25_000 })
    const $ = cheerio.load(html)
    const text = $('#jobDescriptionText, [id*="jobDescription"]').first().text()
    return text.replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

function parseSalary(text?: string): { min?: number; max?: number; currency?: string } {
  if (!text) return {}
  const range = text.match(/(\d[\d\s]*)\s*[–\-]\s*(\d[\d\s]*)/)
  const single = !range ? text.match(/(\d[\d\s]*)/) : null
  const num = (s: string) => Number(s.replace(/\s+/g, ''))
  if (range) return { min: num(range[1]), max: num(range[2]), currency: 'PLN' }
  if (single) return { min: num(single[1]), currency: 'PLN' }
  return {}
}

function buildRawJob(c: Card, description: string): RawJob {
  const sal = parseSalary(c.salary)
  return {
    source: 'indeed',
    sourceId: c.jobKey,
    url: `https://pl.indeed.com/viewjob?jk=${c.jobKey}`,
    title: c.title,
    company: c.company,
    location: c.location,
    remote: /remote|zdaln/i.test(c.location ?? ''),
    salaryMin: sal.min,
    salaryMax: sal.max,
    currency: sal.currency,
    salaryPeriod: 'month',
    description,
    skills: [],
  }
}

const REQUEST_DELAY_MS = 600

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const indeedScraper: JobScraper = {
  source: 'indeed',
  displayName: 'Indeed.pl',
  capabilities: { needsBrowser: true, supportsKeywordFilter: true },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const jobs: RawJob[] = []
    const seen = new Set<string>()
    const cards: Card[] = []

    for (const kw of KEYWORDS) {
      for (let p = 0; p < PAGES_PER_KW; p++) {
        const url = `https://pl.indeed.com/jobs?q=${encodeURIComponent(kw)}&l=Polska&start=${p * 10}`
        try {
          const html = await fetchPageHtml(url, { waitForSelector: 'a.tapItem, a[data-jk], div.job_seen_beacon', timeoutMs: 30_000 })
          const page = parseCards(html)
          if (!page.length) break
          for (const c of page) {
            if (seen.has(c.jobKey)) continue
            seen.add(c.jobKey)
            cards.push(c)
          }
        } catch (e) {
          errors.push(`search "${kw}" p=${p}: ${(e as Error).message}`)
          break
        }
        await sleep(REQUEST_DELAY_MS)
      }
    }

    for (const c of cards) {
      try {
        const desc = await fetchDetail(c.jobKey)
        jobs.push(buildRawJob(c, desc))
        if (ctx.maxResults && jobs.length >= ctx.maxResults) {
          return { source: this.source, jobs, errors }
        }
      } catch (e) {
        errors.push(`detail ${c.jobKey}: ${(e as Error).message}`)
        jobs.push(buildRawJob(c, ''))
      }
      await sleep(REQUEST_DELAY_MS)
    }

    return { source: this.source, jobs, errors }
  },
}
