import type { JobScraper } from './types'
import { justjoinScraper } from './justjoin'
import { nofluffjobsScraper } from './nofluffjobs'
import { bulldogjobScraper } from './bulldogjob'
import { linkedinScraper } from './linkedin'
import { rocketjobsScraper } from './rocketjobs'
import { remoteokScraper } from './remoteok'
import { pracujScraper } from './pracuj'
import { theProtocolScraper } from './theprotocol'
import { indeedScraper } from './indeed'
// solid.jobs and 4programmers.net both gate their job-list APIs behind
// session tokens / CSRF and serve only a skeleton on the first paint. The
// scrapers (server/scrapers/solidjobs.ts, fourprogrammers.ts) compile fine
// but currently return 0 jobs. We keep the code so a future iteration can
// reverse-engineer the API tokens; they're disabled in the registry until then.
// import { solidJobsScraper } from './solidjobs'
// import { fourProgrammersScraper } from './fourprogrammers'

// Registry of available scrapers. Add a new portal by importing its scraper
// here. The orchestrator iterates this list and isolates failures per source.
//
// Tier 1 (plain JSON APIs):    justjoin, nofluffjobs, rocketjobs, remoteok
// Tier 2 (HTML w/o browser):   bulldogjob, linkedin (guest search)
// Tier 3 (Playwright):         pracuj, theprotocol, indeed
export const SCRAPERS: JobScraper[] = [
  justjoinScraper,
  nofluffjobsScraper,
  rocketjobsScraper,
  remoteokScraper,
  bulldogjobScraper,
  linkedinScraper,
  pracujScraper,
  theProtocolScraper,
  indeedScraper,
]
