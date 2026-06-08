import type {
  JobScraper, RawJob, ScrapeContext, ScrapeResult,
  ContractType, Experience, SalaryPeriod,
} from './types'

// Jooble official REST API: POST https://jooble.org/api/{key}
// Register for a free key at https://jooble.org/api/about
// Set JOOBLE_API_KEY in your .env to enable this scraper.
// Without a key the scraper returns 0 jobs and logs a warning.
const API_BASE = 'https://pl.jooble.org/api'
const RESULTS_PER_PAGE = 20
const MAX_PAGES = 5

const SEARCH_KEYWORDS = ['vue.js', 'frontend javascript']

interface JoobleJob {
  title: string
  location: string
  snippet: string
  salary: string
  source: string
  type: string
  link: string
  company: string
  updated: string
  id: string
}

interface JoobleResponse {
  totalCount: number
  jobs: JoobleJob[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function parseSalary(text: string): {
  min?: number; max?: number; currency?: string
  period?: SalaryPeriod; contractType?: ContractType
} {
  if (!text || /uzgodnienia|negotiable/i.test(text)) return {}

  const currency =
    /pln|zł|zl/i.test(text) ? 'PLN' :
    /usd|\$/i.test(text) ? 'USD' :
    /eur|€/i.test(text) ? 'EUR' : undefined

  const period: SalaryPeriod = /godz|hour|\/h/i.test(text) ? 'hour' : 'month'

  const contractType: ContractType | undefined =
    /\bb2b\b/i.test(text) ? 'b2b' :
    /uop|umowa o prac|employment/i.test(text) ? 'permanent' : undefined

  const cleaned = text.replace(/\s/g, '')
  const range = cleaned.match(/([\d,.]+k?)\s*[–\-]\s*([\d,.]+k?)/i)
  const parse = (s: string) => {
    const hasK = /k$/i.test(s)
    return Math.round(Number(s.replace(/k$/i, '').replace(',', '.')) * (hasK ? 1000 : 1))
  }
  if (range) return { min: parse(range[1]), max: parse(range[2]), currency, period, contractType }
  const single = cleaned.match(/([\d\s]{4,})/)
  if (single) return { min: parse(single[1].replace(/\s/g, '')), currency, period, contractType }
  return { currency, period, contractType }
}

function mapExperience(title: string, snippet: string): Experience | undefined {
  const text = `${title} ${snippet}`.toLowerCase()
  if (/\bjunior\b/.test(text)) return 'junior'
  if (/\bsenior\b|\blead\b|\bexpert\b|\bprincipal\b/.test(text)) return 'senior'
  if (/\bmid\b|\bregular\b|\bmedior\b/.test(text)) return 'mid'
  return undefined
}

async function fetchPage(
  apiKey: string,
  keywords: string,
  page: number,
  signal?: AbortSignal,
): Promise<JoobleResponse> {
  const res = await fetch(`${API_BASE}/${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      keywords,
      location: 'Polska',
      page: String(page),
      resultsOnPage: RESULTS_PER_PAGE,
    }),
    signal,
  })
  if (!res.ok) throw new Error(`Jooble API → HTTP ${res.status}`)
  return res.json() as Promise<JoobleResponse>
}

export const joobleScraper: JobScraper = {
  source: 'jooble',
  displayName: 'Jooble',
  capabilities: { needsBrowser: false, supportsKeywordFilter: true },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: string[] = []
    const jobs: RawJob[] = []
    const seen = new Set<string>()

    const apiKey = process.env.JOOBLE_API_KEY
    if (!apiKey) {
      errors.push('JOOBLE_API_KEY not set — skipping Jooble scraper')
      return { source: this.source, jobs, errors }
    }

    for (const keywords of SEARCH_KEYWORDS) {
      let totalPages = 1

      for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page++) {
        try {
          const data = await fetchPage(apiKey, keywords, page, ctx.signal)

          if (page === 1) {
            totalPages = Math.ceil(data.totalCount / RESULTS_PER_PAGE)
          }

          for (const j of data.jobs ?? []) {
            if (!j.id || seen.has(j.id)) continue
            if (/jobleads\.com|click\.appcast\.io/i.test(j.link ?? '')) continue
            seen.add(j.id)

            const sal = parseSalary(j.salary ?? '')
            const description = stripHtml(j.snippet ?? '')

            jobs.push({
              source: 'jooble',
              sourceId: j.id,
              url: j.link,
              title: j.title,
              company: j.company ?? '',
              location: j.location || undefined,
              remote: /zdaln|remote/i.test(j.location ?? '') || /zdaln|remote/i.test(j.type ?? ''),
              salaryMin: sal.min,
              salaryMax: sal.max,
              currency: sal.currency,
              salaryPeriod: sal.period,
              contractType: sal.contractType,
              experience: mapExperience(j.title, description),
              description,
              skills: [],
              postedAt: j.updated ? new Date(j.updated).toISOString() : undefined,
            })

            if (ctx.maxResults && jobs.length >= ctx.maxResults) {
              return { source: this.source, jobs, errors }
            }
          }
        } catch (e) {
          errors.push(`[${keywords}] page ${page}: ${(e as Error).message}`)
          break
        }

        if (page < Math.min(totalPages, MAX_PAGES)) await sleep(500)
      }

      await sleep(500)
    }

    return { source: this.source, jobs, errors }
  },
}
