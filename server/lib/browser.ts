import { chromium, type Browser, type BrowserContext } from 'playwright'

// Shared Chromium instance for scrapers that can't use plain fetch (Cloudflare,
// JS-rendered SPAs). The browser starts lazily on first use and is closed
// from the orchestrator after each scrape run so we don't keep ~100MB of
// process memory pinned between cron ticks.
let _browser: Browser | null = null
let _context: BrowserContext | null = null

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function ensureContext(): Promise<BrowserContext> {
  if (_context) return _context
  if (!_browser) {
    _browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    })
  }
  _context = await _browser.newContext({
    userAgent: USER_AGENT,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8' },
  })
  // Strip the `navigator.webdriver` flag — basic anti-anti-bot. Cloudflare's
  // default challenge passes once we look like a normal browser.
  await _context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })
  return _context
}

// Fetches a page and returns its HTML after the network has gone idle.
// Used by Cloudflare-protected portals (pracuj, theprotocol) and JS-rendered
// ones (solid.jobs, 4programmers, indeed).
export async function fetchPageHtml(url: string, opts: { waitForSelector?: string; timeoutMs?: number } = {}): Promise<string> {
  const context = await ensureContext()
  const page = await context.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs ?? 30_000 })
    if (opts.waitForSelector) {
      await page.waitForSelector(opts.waitForSelector, { timeout: opts.timeoutMs ?? 15_000 }).catch(() => {})
    } else {
      await page.waitForLoadState('networkidle', { timeout: opts.timeoutMs ?? 15_000 }).catch(() => {})
    }
    return page.content()
  } finally {
    await page.close()
  }
}

// Navigate a sequence of URLs in a single browser page so the session, cookies,
// and Referer headers persist between requests — important for sites (Pracuj.pl)
// that fingerprint navigation flow. Returns HTML per URL; null on nav failure.
export async function fetchPagesHtmlSequential(
  urls: string[],
  opts: { waitForSelector?: string; pageDelayMs?: number } = {},
): Promise<(string | null)[]> {
  const context = await ensureContext()
  const page = await context.newPage()
  const results: (string | null)[] = []
  try {
    for (let i = 0; i < urls.length; i++) {
      try {
        await page.goto(urls[i], { waitUntil: 'domcontentloaded', timeout: 30_000 })
        if (opts.waitForSelector) {
          await page.waitForSelector(opts.waitForSelector, { timeout: 15_000 }).catch(() => {})
        } else {
          await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
        }
        results.push(await page.content())
      } catch {
        results.push(null)
      }
      if (opts.pageDelayMs && i < urls.length - 1) {
        await page.waitForTimeout(opts.pageDelayMs)
      }
    }
  } finally {
    await page.close()
  }
  return results
}

export interface NextDataResult {
  data: unknown | null
  pageTitle?: string
}

// Navigate a sequence of URLs in a single browser page and return window.__NEXT_DATA__
// for each URL via page.evaluate(). Returns { data: null, pageTitle } when not found
// so callers can log what the page actually showed (challenge page vs real content).
export async function fetchPagesNextDataSequential(
  urls: string[],
  opts: { pageDelayMs?: number } = {},
): Promise<NextDataResult[]> {
  const context = await ensureContext()
  const page = await context.newPage()
  const results: NextDataResult[] = []
  try {
    for (let i = 0; i < urls.length; i++) {
      try {
        await page.goto(urls[i], { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page
          .waitForFunction(() => !!(window as unknown as Record<string, unknown>).__NEXT_DATA__, { timeout: 15_000 })
          .catch(() => {})
        const { nextData, title } = await page.evaluate(() => ({
          nextData: (window as unknown as Record<string, unknown>).__NEXT_DATA__ ?? null,
          title: document.title,
        }))
        results.push({ data: nextData, pageTitle: title })
      } catch {
        results.push({ data: null })
      }
      if (opts.pageDelayMs && i < urls.length - 1) {
        await page.waitForTimeout(opts.pageDelayMs)
      }
    }
  } finally {
    await page.close()
  }
  return results
}

export async function closeBrowser(): Promise<void> {
  try { await _context?.close() } catch {}
  try { await _browser?.close() } catch {}
  _context = null
  _browser = null
}

export function isBrowserOpen(): boolean {
  return _browser !== null
}
