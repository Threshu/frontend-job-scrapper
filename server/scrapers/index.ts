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
import { remotiveScraper } from './remotive'

// praca.pl keyword search does not distinguish Vue.js from the French word "vue"
// — it returns warehouse workers, CNC operators, and school directors instead of
// IT jobs. Disabled until a reliable IT-category URL is found.
// import { pracaplScraper } from './pracapl'
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
// Tier 1 (plain JSON APIs):    justjoin, nofluffjobs, rocketjobs, remoteok, remotive, pracuj
// Tier 2 (HTML w/o browser):   bulldogjob, linkedin
// Tier 3 (Playwright):         theprotocol, indeed
// Jooble disabled: API returns tracking URLs that redirect to jobleads.com / appcast.io —
// final destination is only visible after a redirect, so URL-based filtering is not feasible.
export const SCRAPERS: JobScraper[] = [
  justjoinScraper,
  nofluffjobsScraper,
  rocketjobsScraper,
  remoteokScraper,
  remotiveScraper,
  bulldogjobScraper,
  linkedinScraper,
  pracujScraper,
  theProtocolScraper,
  indeedScraper,
]
