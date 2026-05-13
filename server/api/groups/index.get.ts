import { useDb } from '../../db'
import type { GroupRow, ListingRow } from '../../db/repository'

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
    postedAt: string | null
    firstSeenAt: string
    lastSeenAt: string
  }>
}

function mapListing(r: ListingRow): GroupDto['listings'][number] {
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
    postedAt: r.posted_at,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
  }
}

export default defineEventHandler((event) => {
  const q = getQuery(event)
  const status = typeof q.status === 'string' ? q.status : undefined
  const hasVue = q.hasVue === '1' || q.hasVue === 'true'
  const sourceFilter = typeof q.source === 'string' ? q.source : undefined
  const search = typeof q.search === 'string' ? q.search.trim() : ''
  const limit = Math.min(Number(q.limit) || 200, 500)

  const db = useDb()

  // Pull groups first (paginated), then their listings. Filtering by
  // listing-level flags (hasVue/source) requires a JOIN with DISTINCT.
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
  const listings = db
    .prepare<unknown[], ListingRow>(
      `SELECT * FROM job_listings WHERE group_id IN (${placeholders}) ORDER BY first_seen_at DESC`,
    )
    .all(...ids)

  const byGroup = new Map<number, ListingRow[]>()
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
      vueInTitle: ls.some((l) => l.vue_in_title),
      bestSalary,
      listings: ls.map(mapListing),
    }
  })

  return { groups: dto }
})
