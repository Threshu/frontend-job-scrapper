import { useDb } from '../../db'
import type { GroupRow, ListingRow } from '../../db/repository'
import { vueInTitle as hasVueInTitle } from '../../lib/vueDetector'
import { isNoiseTitle } from '../../lib/noiseFilter'

export interface GroupDto {
  id: number
  canonicalTitle: string
  canonicalCompany: string
  status: string
  notes: string
  appliedAt: string | null
  createdAt: string
  updatedAt: string
  hasVue: boolean
  hasReact: boolean
  hasAngular: boolean
  hasSvelte: boolean
  vueInTitle: boolean
  // Strongest Vue-relevance signal across the group's listings.
  // primary > required > mention > none.
  vueRelevance: 'primary' | 'required' | 'mention' | 'none'
  isStale: boolean                       // true iff EVERY listing is stale
  bestSalary: { min: number | null; max: number | null; currency: string | null } | null
  listings: Array<{
    id: number
    source: string
    sourceId: string
    url: string
    title: string
    company: string
    location: string | null
    remote: boolean
    salaryMin: number | null
    salaryMax: number | null
    currency: string | null
    salaryPeriod: string | null
    contractType: string | null
    experience: string | null
    // description omitted — not rendered anywhere in the UI. Ship a dedicated
    // endpoint if that changes (see server/api/listings/[id]/description.get.ts).
    skills: string[]
    hasVue: boolean
    hasReact: boolean
    vueRelevance: 'primary' | 'required' | 'mention' | 'none'
    postedAt: string | null
    firstSeenAt: string
    lastSeenAt: string
    isStale: boolean
    staleReason: 'unseen' | 'aged' | null
  }>
}

// Everything on ListingRow except description — we deliberately skip fetching
// it from SQLite for the list endpoint since it's the largest column and never
// rendered in the card.
type ListingRowSlim = Omit<ListingRow, 'description'> & {
  is_stale_unseen: number
  is_stale_aged: number
}

function mapListing(r: ListingRowSlim): GroupDto['listings'][number] {
  const stale = r.is_stale_unseen === 1 || r.is_stale_aged === 1
  const reason: 'unseen' | 'aged' | null = r.is_stale_unseen === 1 ? 'unseen' : r.is_stale_aged === 1 ? 'aged' : null
  return {
    id: r.id,
    source: r.source,
    sourceId: r.source_id,
    url: r.url,
    title: r.title,
    company: r.company,
    location: r.location,
    remote: !!r.remote,
    salaryMin: r.salary_min,
    salaryMax: r.salary_max,
    currency: r.currency,
    salaryPeriod: r.salary_period,
    contractType: r.contract_type,
    experience: r.experience,
    skills: JSON.parse(r.skills_json) as string[],
    hasVue: !!r.has_vue,
    hasReact: !!r.has_react,
    vueRelevance: (r.vue_relevance as GroupDto['listings'][number]['vueRelevance']) ?? 'none',
    postedAt: r.posted_at,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    isStale: stale,
    staleReason: reason,
  }
}

export default defineEventHandler((event) => {
  const config = useRuntimeConfig()
  const lastSeenDays = Number(config.staleLastSeenDays ?? 7)
  const postedDays = Number(config.stalePostedDays ?? 60)

  const q = getQuery(event)
  const status = typeof q.status === 'string' ? q.status : undefined
  const hasVue = q.hasVue === '1' || q.hasVue === 'true'
  const sourceFilter = typeof q.source === 'string' ? q.source : undefined
  const search = typeof q.search === 'string' ? q.search.trim() : ''
  // excludeStale defaults to true — pokazujemy tylko żywe oferty chyba że
  // ktoś świadomie przełączy "pokaż archiwum".
  const includeStale = q.includeStale === '1' || q.includeStale === 'true'
  const vueInTitle = q.vueInTitle === '1' || q.vueInTitle === 'true'
  const hideNoise = q.hideNoise === '1' || q.hideNoise === 'true'
  // vueRelevance: 'core' = primary+required (default for active tab),
  // 'all' = include 'mention' too. The accepted set goes to the EXISTS check.
  const vueRelevance = typeof q.vueRelevance === 'string' ? q.vueRelevance : ''
  const relevanceAllowed: string[] | null =
    vueRelevance === 'core' ? ['primary', 'required']
    : vueRelevance === 'primary' ? ['primary']
    : vueRelevance === 'required' ? ['required']
    : vueRelevance === 'mention' ? ['mention']
    : null
  const limit = Math.min(Number(q.limit) || 200, 500)

  const db = useDb()

  const where: string[] = []
  const params: unknown[] = []
  if (status) { where.push('g.status = ?'); params.push(status) }
  if (search) {
    where.push('(g.canonical_title LIKE ? OR g.canonical_company LIKE ?)')
    const s = `%${search}%`
    params.push(s, s)
  }
  if (hasVue || sourceFilter) {
    where.push(`EXISTS (
      SELECT 1 FROM job_listings l
      WHERE l.group_id = g.id
        ${hasVue ? 'AND l.has_vue = 1' : ''}
        ${sourceFilter ? 'AND l.source = ?' : ''}
    )`)
    if (sourceFilter) params.push(sourceFilter)
  }
  if (vueInTitle) {
    // Check the canonical title of the group (what the user sees), not individual
    // listing titles — a listing from another source in the same group could have
    // "Vue" in its title without the displayed role being a Vue role.
    where.push(`LOWER(g.canonical_title) LIKE '%vue%'`)
  }
  if (relevanceAllowed) {
    const placeholders = relevanceAllowed.map(() => '?').join(',')
    where.push(`EXISTS (
      SELECT 1 FROM job_listings l
      WHERE l.group_id = g.id AND l.vue_relevance IN (${placeholders})
    )`)
    params.push(...relevanceAllowed)
  }
  // hideNoise moved to post-fetch JS filter (see below) — SQL LIKE '%pattern%'
  // on 30+ patterns forced full scans on canonical_title on every list load.
  // Stale filter: exclude groups whose ALL listings are stale.
  // "stale" = last_seen_at older than threshold OR posted_at older than threshold.
  // Implemented as: there must EXIST at least one fresh listing.
  if (!includeStale) {
    where.push(`EXISTS (
      SELECT 1 FROM job_listings l
      WHERE l.group_id = g.id
        AND l.last_seen_at >= datetime('now', '-' || ? || ' days')
        AND (l.posted_at IS NULL OR l.posted_at >= datetime('now', '-' || ? || ' days'))
    )`)
    params.push(lastSeenDays, postedDays)
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''

  // Overshoot when noise filtering happens post-fetch so filtering doesn't
  // shrink the visible list below the requested limit.
  const sqlLimit = hideNoise ? Math.min(limit * 2, 1000) : limit

  const rawGroups = db
    .prepare<unknown[], GroupRow>(
      `SELECT g.* FROM job_groups g ${whereSql}
       ORDER BY g.updated_at DESC LIMIT ${sqlLimit}`,
    )
    .all(...params)

  const groups = hideNoise
    ? rawGroups.filter((g) => !isNoiseTitle(g.canonical_title)).slice(0, limit)
    : rawGroups

  if (groups.length === 0) return { groups: [] as GroupDto[] }

  const ids = groups.map((g) => g.id)
  const placeholders = ids.map(() => '?').join(',')

  // Pull listings with computed stale flags. We compute two separate signals
  // so the UI can show "knikło z portalu" vs "wygasło z czasu".
  // Explicit column list (no `l.*`) so we skip the huge `description` column,
  // which is never displayed in the card list — cuts JSON payload by 5-10× on
  // portals like NoFluffJobs and Bulldogjob where descriptions are multi-KB.
  const listings = db
    .prepare<unknown[], ListingRowSlim>(
      `SELECT
         l.id, l.source, l.source_id, l.url, l.title, l.company, l.location, l.remote,
         l.salary_min, l.salary_max, l.currency, l.salary_period, l.contract_type, l.experience,
         l.skills_json,
         l.has_vue, l.has_react, l.has_angular, l.has_svelte, l.vue_in_title, l.vue_relevance,
         l.posted_at, l.first_seen_at, l.last_seen_at, l.group_id,
         CASE WHEN l.last_seen_at < datetime('now', '-' || ? || ' days') THEN 1 ELSE 0 END AS is_stale_unseen,
         CASE WHEN l.posted_at IS NOT NULL AND l.posted_at < datetime('now', '-' || ? || ' days') THEN 1 ELSE 0 END AS is_stale_aged
       FROM job_listings l
       WHERE l.group_id IN (${placeholders})
       ORDER BY l.first_seen_at DESC`,
    )
    .all(lastSeenDays, postedDays, ...ids)

  const byGroup = new Map<number, ListingRowSlim[]>()
  for (const l of listings) {
    if (l.group_id == null) continue
    if (!byGroup.has(l.group_id)) byGroup.set(l.group_id, [])
    byGroup.get(l.group_id)!.push(l)
  }

  const dto: GroupDto[] = groups.map((g) => {
    const ls = byGroup.get(g.id) ?? []
    let bestSalary: GroupDto['bestSalary'] = null
    for (const l of ls) {
      if (l.salary_max != null || l.salary_min != null) {
        if (!bestSalary || (l.salary_max ?? 0) > (bestSalary.max ?? 0)) {
          bestSalary = { min: l.salary_min, max: l.salary_max, currency: l.currency }
        }
      }
    }
    const mappedListings = ls.map(mapListing)
    const groupStale = mappedListings.length > 0 && mappedListings.every((l) => l.isStale)
    // Strongest signal across listings: primary > required > mention > none
    const RELEVANCE_RANK = { primary: 3, required: 2, mention: 1, none: 0 } as const
    type RelKey = keyof typeof RELEVANCE_RANK
    let strongest: RelKey = 'none'
    for (const l of mappedListings) {
      const r = (l.vueRelevance as RelKey) ?? 'none'
      if (RELEVANCE_RANK[r] > RELEVANCE_RANK[strongest]) strongest = r
    }
    return {
      id: g.id,
      canonicalTitle: g.canonical_title,
      canonicalCompany: g.canonical_company,
      status: g.status,
      notes: g.notes,
      appliedAt: g.applied_at,
      createdAt: g.created_at,
      updatedAt: g.updated_at,
      hasVue: ls.some((l) => l.has_vue),
      hasReact: ls.some((l) => l.has_react),
      hasAngular: ls.some((l) => l.has_angular),
      hasSvelte: ls.some((l) => l.has_svelte),
      vueInTitle: hasVueInTitle(g.canonical_title),
      vueRelevance: strongest,
      isStale: groupStale,
      bestSalary,
      listings: mappedListings,
    }
  })

  return { groups: dto }
})
