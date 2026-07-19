import type { Database } from 'better-sqlite3'
import { useDb } from './index'
import type { RawJob } from '../scrapers/types'
import { classifyVueRelevance, detectFrameworks } from '../lib/vueDetector'
import {
  companiesCompatible,
  companyStem,
  fingerprintFor,
  levenshtein,
  normalizeCompany,
  normalizeTitle,
} from '../lib/fingerprint'

export interface ListingRow {
  id: number
  source: string
  source_id: string
  url: string
  title: string
  company: string
  location: string | null
  remote: number
  salary_min: number | null
  salary_max: number | null
  currency: string | null
  salary_period: string | null
  contract_type: string | null
  experience: string | null
  description: string
  skills_json: string
  has_vue: number
  has_react: number
  has_angular: number
  has_svelte: number
  vue_in_title: number
  vue_relevance: string
  posted_at: string | null
  first_seen_at: string
  last_seen_at: string
  group_id: number | null
}

export interface GroupRow {
  id: number
  fingerprint: string
  canonical_stem: string
  canonical_title: string
  canonical_company: string
  status: string
  notes: string
  applied_at: string | null
  manually_merged: number
  manually_split: number
  created_at: string
  updated_at: string
}

export interface UpsertResult {
  listingId: number
  groupId: number
  isNewListing: boolean
  isNewGroup: boolean
}

const FUZZY_TITLE_MAX_DISTANCE = 3
const FUZZY_RECENT_DAYS = 30

function findGroupByFingerprint(db: Database, fingerprint: string): GroupRow | undefined {
  return db
    .prepare<[string], GroupRow>(
      'SELECT * FROM job_groups WHERE fingerprint = ? LIMIT 1',
    )
    .get(fingerprint)
}

function findFuzzyGroup(
  db: Database,
  company: string,
  title: string,
): GroupRow | undefined {
  const normCompany = normalizeCompany(company)
  const normTitle = normalizeTitle(title)
  const stem = companyStem(normCompany)
  if (!stem) return undefined

  // Candidate groups share the same company stem — covers
  // "Luxoft" / "Luxoft Poland" / "Luxoft DXC". We then verify the rest
  // (companiesCompatible + title fuzzy).
  const candidates = db
    .prepare<[string, string], GroupRow>(
      `SELECT * FROM job_groups
       WHERE canonical_stem = ?
         AND created_at >= datetime('now', ?)
         AND manually_split = 0`,
    )
    .all(stem, `-${FUZZY_RECENT_DAYS} days`)

  for (const c of candidates) {
    const [candCompany, candTitle] = c.fingerprint.split('|')
    if (!companiesCompatible(normCompany, candCompany ?? '')) continue
    if (levenshtein(candTitle ?? '', normTitle) <= FUZZY_TITLE_MAX_DISTANCE) {
      return c
    }
  }
  return undefined
}

function createGroup(db: Database, company: string, title: string): GroupRow {
  const now = new Date().toISOString()
  const fingerprint = fingerprintFor(company, title)
  const stem = companyStem(normalizeCompany(company))
  const info = db
    .prepare(
      `INSERT INTO job_groups
        (fingerprint, canonical_stem, canonical_title, canonical_company, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(fingerprint, stem, title, company, now, now)
  return {
    id: Number(info.lastInsertRowid),
    fingerprint,
    canonical_stem: stem,
    canonical_title: title,
    canonical_company: company,
    status: 'new',
    notes: '',
    applied_at: null,
    manually_merged: 0,
    manually_split: 0,
    created_at: now,
    updated_at: now,
  }
}

// Inserts the listing if new, updates last_seen_at if we already have it.
// Resolves (or creates) the group for cross-source deduplication.
export function upsertListing(job: RawJob, db: Database = useDb()): UpsertResult {
  const now = new Date().toISOString()

  // Cheap existence check first — ~80% of scraped listings on a repeat run are
  // duplicates, and detectFrameworks / classifyVueRelevance run heavy regex on
  // the full description. Skipping them here saves noticeable time per scrape.
  const existing = db
    .prepare<[string, string], Pick<ListingRow, 'id' | 'group_id'>>(
      'SELECT id, group_id FROM job_listings WHERE source = ? AND source_id = ? LIMIT 1',
    )
    .get(job.source, job.sourceId)

  if (existing) {
    db.prepare('UPDATE job_listings SET last_seen_at = ? WHERE id = ?').run(now, existing.id)
    return {
      listingId: existing.id,
      groupId: existing.group_id ?? 0,
      isNewListing: false,
      isNewGroup: false,
    }
  }

  const flags = detectFrameworks({
    title: job.title,
    description: job.description,
    skills: job.skills,
  })
  const relevance = flags.hasVue
    ? classifyVueRelevance(job.title, job.description, job.skills)
    : 'none'

  // Resolve group: exact fingerprint → fuzzy → new.
  const fingerprint = fingerprintFor(job.company, job.title)
  let group = findGroupByFingerprint(db, fingerprint)
  let isNewGroup = false
  if (!group) {
    group = findFuzzyGroup(db, job.company, job.title)
  }
  if (!group) {
    group = createGroup(db, job.company, job.title)
    isNewGroup = true
  }

  // description is intentionally NOT persisted — it's only used above to feed
  // the framework detector / relevance classifier, whose outputs land in the
  // `has_*` and `vue_relevance` columns. Storing raw descriptions was ~40MB of
  // dead weight in a 79MB DB. If a future feature needs to re-classify from
  // raw text, put description back here AND in the SELECT list of the list API.
  const info = db
    .prepare(
      `INSERT INTO job_listings (
        source, source_id, url, title, company, location, remote,
        salary_min, salary_max, currency, salary_period, contract_type, experience,
        description, skills_json,
        has_vue, has_react, has_angular, has_svelte, vue_in_title, vue_relevance,
        posted_at, first_seen_at, last_seen_at, group_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      job.source,
      job.sourceId,
      job.url,
      job.title,
      job.company,
      job.location ?? null,
      job.remote ? 1 : 0,
      job.salaryMin ?? null,
      job.salaryMax ?? null,
      job.currency ?? null,
      job.salaryPeriod ?? null,
      job.contractType ?? null,
      job.experience ?? null,
      '',
      JSON.stringify(job.skills),
      flags.hasVue ? 1 : 0,
      flags.hasReact ? 1 : 0,
      flags.hasAngular ? 1 : 0,
      flags.hasSvelte ? 1 : 0,
      flags.vueInTitle ? 1 : 0,
      relevance,
      job.postedAt ?? null,
      now,
      now,
      group.id,
    )

  return {
    listingId: Number(info.lastInsertRowid),
    groupId: group.id,
    isNewListing: true,
    isNewGroup,
  }
}

export function expireListings(source: string, sourceIds: string[], db: Database = useDb()): void {
  if (!sourceIds.length) return
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const placeholders = sourceIds.map(() => '?').join(',')
  db.prepare(
    `UPDATE job_listings SET last_seen_at = ? WHERE source = ? AND source_id IN (${placeholders})`,
  ).run(old, source, ...sourceIds)
}

export function recordScrapeRun(
  source: string,
  status: 'running' | 'ok' | 'error',
  fetched: number,
  newCount: number,
  errorMessage: string | null,
  db: Database = useDb(),
): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO scrape_runs (source, started_at, finished_at, status, fetched_count, new_count, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(source, now, status === 'running' ? null : now, status, fetched, newCount, errorMessage)
}

// scrape_runs grows ~480 rows/day (10 sources × 48 cron ticks). Called from
// the orchestrator at the end of each run to keep the table bounded.
export function pruneScrapeRuns(retainDays = 30, db: Database = useDb()): number {
  const info = db
    .prepare(`DELETE FROM scrape_runs WHERE started_at < datetime('now', '-' || ? || ' days')`)
    .run(retainDays)
  return info.changes
}
