// Diagnostic endpoint — runs a bare fetch from within the Nitro context and
// returns the full error chain so "fetch failed" root causes become visible.
// Hit GET /api/fetch-test to check if outbound HTTPS works from the server.
const TEST_URLS = [
  'https://justjoin.it/api/candidate-api/offers',
  'https://remoteok.com/api',
  'https://nofluffjobs.com/api/search/posting?salaryCurrency=PLN&salaryPeriod=month&pageSize=1',
  'https://bulldogjob.com/companies/jobs/s/skills,Vue.js',
]

interface TestResult {
  url: string
  status?: number
  ok: boolean
  error?: string
  cause?: string
  durationMs: number
}

function causeChain(e: unknown): string {
  const parts: string[] = []
  let cur: unknown = e
  while (cur) {
    const err = cur as Error & { code?: string; cause?: unknown }
    parts.push([err.message, err.code ? `(${err.code})` : ''].filter(Boolean).join(' '))
    cur = err.cause
  }
  return parts.join(' → ')
}

export default defineEventHandler(async (): Promise<TestResult[]> => {
  const results: TestResult[] = []

  for (const url of TEST_URLS) {
    const t0 = Date.now()
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(12_000),
      })
      results.push({ url, status: res.status, ok: res.ok, durationMs: Date.now() - t0 })
    } catch (e) {
      results.push({
        url,
        ok: false,
        error: (e as Error).message,
        cause: causeChain((e as Error & { cause?: unknown }).cause),
        durationMs: Date.now() - t0,
      })
    }
  }

  return results
})
