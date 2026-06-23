import { useDb } from '../../db'
import type { GroupRow, ListingRow } from '../../db/repository'
import { vueInTitle as hasVueInTitle } from '../../lib/vueDetector'

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
    description: string
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

interface ListingRowWithStale extends ListingRow {
  is_stale_unseen: number
  is_stale_aged: number
}

function mapListing(r: ListingRowWithStale): GroupDto['listings'][number] {
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
    description: r.description,
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
  if (hideNoise) {
    // Oferta jest OK jeśli Vue jest w tytule ALBO tytuł nie pasuje do szablonów szumu.
    // Szablony pokrywają: języki backendowe jako główny tech, role niedev, React/Angular-primary.
    const noisePatterns = [
      // Python jako główny język — każdy tytuł z "python" bez Vue w tytule
      '%python%',
      // Java (ostrożnie — nie "javascript")
      '%java developer%', '%java engineer%', '%fullstack java%',
      // .NET/C# jako główny
      '%.net developer%', '%.net engineer%', '%.net core%', '%.net full%', '%(.net%', '% .net%',
      // React jako główny frontend (bez Vue w tytule)
      '%react developer%', '%react engineer%', '%react native%',
      // Inne języki backendowe
      '%golang%', '%kotlin developer%', '%kotlin engineer%', '%c++%', '%ruby%',
      // Role niedev
      '%qa engineer%', '%quality engineer%', '%quality assurance%',
      '%tester manualny%', '%engineer in test%',
      '%vice president%', '%vp,%', '%vp %',
      '%head of %', '%chief %',
      '%director%', '%directeur%', '%ingénierie%',
      '%telco%', '%telecom%',
      '% manager%', '% analyst%', '% designer%',
      '%support specialist%', '%support engineer%',
      '%product owner%', '%cloud consultant%', '%devops%',
      // Lead/architect role titles (vue_in_title=1 chroni "Lead Vue Developer" itp.)
      '%lead software engineer%', '%lead full%', '%tech lead%', '%team lead%',
      '%solution architect%', '%software architect%', '%architecte%',
      // PHP jako główny (PHP+Vue z Vue w tytule jest chronione przez warunek vue_in_title)
      '%php developer%', '%php engineer%',
      // Platformy e-commerce (Shopify/Magento/WP) — nie Vue-frontend
      '%shopify%', '%magento%', '%wordpress developer%', '%wordpress engineer%',
      // Ogólne role e-commerce (Technical Lead, Architect itp.)
      '%ecommerce%',
    ]
    const likeClauses = noisePatterns.map(() => `LOWER(g.canonical_title) LIKE ?`).join(' OR ')
    where.push(`(
      LOWER(g.canonical_title) LIKE '%vue%'
      OR NOT (${likeClauses})
    )`)
    params.push(...noisePatterns)
  }
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

  const groups = db
    .prepare<unknown[], GroupRow>(
      `SELECT g.* FROM job_groups g ${whereSql}
       ORDER BY g.updated_at DESC LIMIT ${limit}`,
    )
    .all(...params)

  if (groups.length === 0) return { groups: [] as GroupDto[] }

  const ids = groups.map((g) => g.id)
  const placeholders = ids.map(() => '?').join(',')

  // Pull listings with computed stale flags. We compute two separate signals
  // so the UI can show "knikło z portalu" vs "wygasło z czasu".
  const listings = db
    .prepare<unknown[], ListingRowWithStale>(
      `SELECT
         l.*,
         CASE WHEN l.last_seen_at < datetime('now', '-' || ? || ' days') THEN 1 ELSE 0 END AS is_stale_unseen,
         CASE WHEN l.posted_at IS NOT NULL AND l.posted_at < datetime('now', '-' || ? || ' days') THEN 1 ELSE 0 END AS is_stale_aged
       FROM job_listings l
       WHERE l.group_id IN (${placeholders})
       ORDER BY l.first_seen_at DESC`,
    )
    .all(lastSeenDays, postedDays, ...ids)

  const byGroup = new Map<number, ListingRowWithStale[]>()
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
