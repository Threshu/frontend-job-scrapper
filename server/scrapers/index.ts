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

// Registry of available scrapers. Add a new portal by importing its scraper
// here. The orchestrator iterates this list and isolates failures per source.
//
// Tier 1 (plain JSON APIs):    justjoin, nofluffjobs, rocketjobs, remoteok, remotive, pracuj
// Tier 2 (HTML w/o browser):   bulldogjob, linkedin
// Tier 3 (Playwright):         theprotocol, indeed
//
// Portals that were tried and abandoned (removed from repo — check git log
// if you want to revive):
//   crossweb, jooble, praca.pl, solid.jobs, 4programmers.net
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
