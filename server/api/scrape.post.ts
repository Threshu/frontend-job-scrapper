import { runScrape, isRunning, currentRun } from '../lib/orchestrator'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ sources?: string[]; maxPerSource?: number }>(event).catch(() => ({}))

  if (isRunning()) {
    return { status: 'already-running', run: currentRun() }
  }

  const result = await runScrape({
    sources: body?.sources,
    maxResultsPerSource: body?.maxPerSource,
  })
  return { status: 'ok', result }
})
