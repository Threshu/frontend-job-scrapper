import { SCRAPERS } from '../scrapers'

export default defineEventHandler(() => {
  return SCRAPERS.map((s) => ({
    source: s.source,
    displayName: s.displayName,
    needsBrowser: s.capabilities.needsBrowser,
  }))
})
