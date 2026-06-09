import { chromium, type Browser, type BrowserContext } from 'playwright'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// Shared Chromium instance for scrapers that can't use plain fetch (Cloudflare,
// JS-rendered SPAs). The browser starts lazily on first use and is closed
// from the orchestrator after each scrape run so we don't keep ~100MB of
// process memory pinned between cron ticks.
let _browser: Browser | null = null
let _context: BrowserContext | null = null

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'

// Persisted storage state — once Cloudflare clears the challenge, the resulting
// cookie is valid for hours. Saving it between runs lets the next run skip the
// 30-second JS challenge entirely, which is what was making Pracuj hang on
// "Cierpliwości…" every time.
const STORAGE_STATE_PATH = resolve(process.cwd(), 'data/browser-state.json')

async function ensureContext(): Promise<BrowserContext> {
  if (_context) return _context
  if (!_browser) {
    _browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    })
  }
  const stateDir = dirname(STORAGE_STATE_PATH)
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
  const storageState = existsSync(STORAGE_STATE_PATH) ? STORAGE_STATE_PATH : undefined
  _context = await _browser.newContext({
    userAgent: USER_AGENT,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7' },
    storageState,
  })
  // Anti-bot patches applied to every page in this context.
  // These make headless Chromium look like a normal Chrome install to
  // Cloudflare's JS challenge and similar bot-detection scripts.
  await _context.addInitScript(() => {
    // 1. Remove webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })

    // 2. Fake the chrome runtime object (absent in headless Chromium)
    ;(window as unknown as Record<string, unknown>).chrome = {
      runtime: {},
      app: { isInstalled: false, getDetails: () => null, getIsInstalled: () => false, installState: () => {} },
      loadTimes: () => ({}),
      csi: () => ({}),
    }

    // 3. Fake a non-zero plugins list (headless has 0)
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })

    // 4. Consistent languages
    Object.defineProperty(navigator, 'languages', { get: () => ['pl-PL', 'pl', 'en-US', 'en'] })

    // 5. Permissions API — return 'default' for notifications (headless returns 'denied')
    const origQuery = navigator.permissions.query.bind(navigator.permissions)
    navigator.permissions.query = (desc: PermissionDescriptor) =>
      desc.name === 'notifications'
        ? Promise.resolve({ state: 'default' } as unknown as PermissionStatus)
        : origQuery(desc)

    // 6. Hardware concurrency and device memory (headless often returns low/0 values)
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 })
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 })

    // 7. User-Agent Client Hints — must match the User-Agent string
    Object.defineProperty(navigator, 'userAgentData', {
      get: () => ({
        brands: [
          { brand: 'Chromium', version: '136' },
          { brand: 'Google Chrome', version: '136' },
          { brand: 'Not.A/Brand', version: '99' },
        ],
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: (hints: string[]) =>
          Promise.resolve(
            Object.fromEntries(
              hints.map((h) => {
                if (h === 'platform') return [h, 'Windows']
                if (h === 'platformVersion') return [h, '10.0.0']
                if (h === 'architecture') return [h, 'x86']
                if (h === 'bitness') return [h, '64']
                if (h === 'fullVersionList') return [h, [{ brand: 'Google Chrome', version: '136.0.0.0' }]]
                if (h === 'uaFullVersion') return [h, '136.0.0.0']
                return [h, '']
              }),
            ),
          ),
      }),
    })
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
  opts: { pageDelayMs?: number; maxChallengeWaitMs?: number } = {},
): Promise<NextDataResult[]> {
  const context = await ensureContext()
  const page = await context.newPage()
  const results: NextDataResult[] = []
  const maxChallengeWait = opts.maxChallengeWaitMs ?? 60_000
  try {
    for (let i = 0; i < urls.length; i++) {
      try {
        await page.goto(urls[i], { waitUntil: 'domcontentloaded', timeout: 30_000 })
        // Wait for __NEXT_DATA__. Pracuj's Cloudflare JS challenge can need up
        // to ~45s in the worst case. We try once with the requested timeout; if
        // we're still on a challenge page ("Cierpliwości..." / "Just a moment..."),
        // we wait an extra round before giving up.
        let challengeResolved = await page
          .waitForFunction(() => !!(window as unknown as Record<string, unknown>).__NEXT_DATA__, { timeout: maxChallengeWait })
          .then(() => true)
          .catch(() => false)
        if (!challengeResolved) {
          // One more retry — sometimes the challenge auto-redirects but our
          // wait raced the navigation.
          await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
          challengeResolved = await page
            .waitForFunction(() => !!(window as unknown as Record<string, unknown>).__NEXT_DATA__, { timeout: 15_000 })
            .then(() => true)
            .catch(() => false)
        }
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
  try {
    // Save cookies/localStorage so the next run can skip the Cloudflare challenge.
    if (_context) await _context.storageState({ path: STORAGE_STATE_PATH }).catch(() => {})
  } catch {}
  try { await _context?.close() } catch {}
  try { await _browser?.close() } catch {}
  _context = null
  _browser = null
}

export function isBrowserOpen(): boolean {
  return _browser !== null
}
