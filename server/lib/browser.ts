import { chromium } from 'playwright-core'
import type { Browser, BrowserContext } from 'playwright-core'
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

  // Manual anti-bot evasions — playwright-extra + stealth plugin used CJS
  // dynamic require() which breaks in Nitro's ESM environment. We replicate
  // the most important evasions inline instead.
  await _context.addInitScript(() => {
    // Remove webdriver flag (Chromium's --disable-blink-features=AutomationControlled
    // handles the property itself, but some frameworks also check the proto chain)
    Object.defineProperty(navigator, 'webdriver', { get: () => false })

    // vendor / platform
    Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' })
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' })

    // Consistent languages
    Object.defineProperty(navigator, 'languages', { get: () => ['pl-PL', 'pl', 'en-US', 'en'] })

    // Hardware concurrency and device memory
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 })
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 })

    // window dimensions — headless default is 0×0 which is a strong signal
    Object.defineProperty(window, 'outerWidth', { get: () => 1280 })
    Object.defineProperty(window, 'outerHeight', { get: () => 800 })
    Object.defineProperty(window, 'innerWidth', { get: () => 1280 })
    Object.defineProperty(window, 'innerHeight', { get: () => 800 })

    // Fake plugins list — real Chrome reports ~5 plugins; empty list is a bot signal
    const pluginData = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ]
    const makePlugin = (d: typeof pluginData[0]) => {
      const plugin = Object.create(Plugin.prototype)
      Object.defineProperty(plugin, 'name', { get: () => d.name })
      Object.defineProperty(plugin, 'filename', { get: () => d.filename })
      Object.defineProperty(plugin, 'description', { get: () => d.description })
      Object.defineProperty(plugin, 'length', { get: () => 0 })
      return plugin
    }
    const plugins = pluginData.map(makePlugin)
    const pluginArray = Object.create(PluginArray.prototype)
    Object.defineProperty(pluginArray, 'length', { get: () => plugins.length })
    plugins.forEach((p, i) => Object.defineProperty(pluginArray, i, { get: () => p }))
    pluginArray.item = (i: number) => plugins[i] ?? null
    pluginArray.namedItem = (name: string) => plugins.find((p) => p.name === name) ?? null
    pluginArray[Symbol.iterator] = function* () { yield* plugins }
    Object.defineProperty(navigator, 'plugins', { get: () => pluginArray })
    Object.defineProperty(navigator, 'mimeTypes', { get: () => Object.create(MimeTypeArray.prototype) })

    // chrome global — bots are caught by the absence of window.chrome
    if (!(window as unknown as Record<string, unknown>).chrome) {
      const chrome = {
        app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
        runtime: { OnInstalledReason: {}, OnRestartRequiredReason: {}, PlatformArch: {}, PlatformNaclArch: {}, PlatformOs: {}, RequestUpdateCheckStatus: {} },
        loadTimes: () => ({}),
        csi: () => ({}),
      }
      Object.defineProperty(window, 'chrome', { get: () => chrome, configurable: true })
    }

    // permissions.query — real Chrome returns "granted"/"denied"/"prompt" for
    // automation-detectable permissions. Override to always return "prompt".
    const originalQuery = window.navigator.permissions?.query?.bind(navigator.permissions)
    if (originalQuery) {
      Object.defineProperty(navigator.permissions, 'query', {
        value: (params: PermissionDescriptor) =>
          params.name === 'notifications'
            ? Promise.resolve({ state: 'prompt', onchange: null } as PermissionStatus)
            : originalQuery(params),
      })
    }

    // User-Agent Client Hints — must match the User-Agent string
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
