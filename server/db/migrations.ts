import type { Database } from 'better-sqlite3'
import {
  companiesCompatible,
  companyStem,
  levenshtein,
  normalizeCompany,
} from '../lib/fingerprint'
import { classifyVueRelevance } from '../lib/vueDetector'

// Applied once on db init. Each migration is idempotent — safe to re-run.
// We don't track applied migrations; each check inspects schema/data and skips
// if already done.

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((r) => r.name === column)
}

function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  definition: string,
): boolean {
  if (hasColumn(db, table, column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  return true
}

interface GroupRow {
  id: number
  fingerprint: string
  canonical_stem: string
  canonical_company: string
}

interface ListingRow {
  id: number
  title: string
  description: string
  skills_json: string
  vue_relevance: string
  has_vue: number
}

export function runMigrations(db: Database): void {
  // 1. Schema: ensure new columns exist on databases created before these features.
  const addedStem = addColumnIfMissing(db, 'job_groups', 'canonical_stem', "TEXT NOT NULL DEFAULT ''")
  const addedRelevance = addColumnIfMissing(
    db,
    'job_listings',
    'vue_relevance',
    "TEXT NOT NULL DEFAULT 'none'",
  )

  db.exec(`CREATE INDEX IF NOT EXISTS idx_groups_stem ON job_groups(canonical_stem)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_listings_vue_releva ON job_listings(vue_relevance)`)

  // 2. Backfill canonical_stem on groups that are missing it.
  if (addedStem || db.prepare(`SELECT 1 FROM job_groups WHERE canonical_stem = '' LIMIT 1`).get()) {
    const groups = db
      .prepare<[], GroupRow>(
        `SELECT id, fingerprint, canonical_stem, canonical_company
         FROM job_groups WHERE canonical_stem = ''`,
      )
      .all()
    const upd = db.prepare(`UPDATE job_groups SET canonical_stem = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      for (const g of groups) {
        const company =
          g.fingerprint.split('|')[0] ?? normalizeCompany(g.canonical_company)
        upd.run(companyStem(company), g.id)
      }
    })
    tx()
  }

  // 3. Backfill vue_relevance for listings that don't have it computed yet.
  // We only need to look at rows where has_vue=1 — others stay 'none' (the default).
  const needsRelevance = db
    .prepare(`SELECT 1 FROM job_listings WHERE has_vue = 1 AND vue_relevance = 'none' LIMIT 1`)
    .get()
  if (addedRelevance || needsRelevance) {
    const rows = db
      .prepare<[], ListingRow>(
        `SELECT id, title, description, skills_json, vue_relevance, has_vue
         FROM job_listings WHERE has_vue = 1 AND vue_relevance = 'none'`,
      )
      .all()
    const upd = db.prepare(`UPDATE job_listings SET vue_relevance = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      for (const r of rows) {
        let skills: string[] = []
        try { skills = JSON.parse(r.skills_json) as string[] } catch {}
        const rel = classifyVueRelevance(r.title, r.description, skills)
        upd.run(rel, r.id)
      }
    })
    tx()
  }

  // 4. One-time re-merge of duplicate groups that the old narrow fingerprint split.
  //    Guarded by app_state key so it runs exactly once per database.
  const guard = db
    .prepare(`SELECT value FROM app_state WHERE key = 'dedup_remerged_v1'`)
    .get() as { value: string } | undefined
  if (!guard) {
    remergeDuplicateGroups(db)
    db.prepare(
      `INSERT OR REPLACE INTO app_state (key, value) VALUES ('dedup_remerged_v1', datetime('now'))`,
    ).run()
  }
}

// Status priority: a user-progressed status beats 'new'. When we collapse multiple
// groups into one, we pick the most-progressed status so we never lose track of an
// "applied" decision the user already made.
const STATUS_PRIORITY: Record<string, number> = {
  applied: 100,
  replied: 90,
  interested: 80,
  rejected: 60,
  hidden: 50,
  new: 10,
}

interface GroupForMerge {
  id: number
  fingerprint: string
  canonical_stem: string
  canonical_title: string
  canonical_company: string
  status: string
  notes: string
  applied_at: string | null
  created_at: string
  manually_split: number
}

// Re-runs the new fuzzy rule across all existing groups and merges any pairs
// that should be one logical job. Idempotent and conservative — only merges
// when both stem and title-distance check pass.
function remergeDuplicateGroups(db: Database): void {
  const FUZZY_TITLE_MAX_DISTANCE = 3
  const all = db
    .prepare<[], GroupForMerge>(
      `SELECT id, fingerprint, canonical_stem, canonical_title, canonical_company,
              status, notes, applied_at, created_at, manually_split
       FROM job_groups
       WHERE manually_split = 0
       ORDER BY id ASC`,
    )
    .all()

  // Index groups by stem for O(n) bucketing.
  const buckets = new Map<string, GroupForMerge[]>()
  for (const g of all) {
    const stem =
      g.canonical_stem || companyStem(normalizeCompany(g.fingerprint.split('|')[0] ?? ''))
    if (!stem) continue
    if (!buckets.has(stem)) buckets.set(stem, [])
    buckets.get(stem)!.push(g)
  }

  const reassignListings = db.prepare(
    `UPDATE job_listings SET group_id = ? WHERE group_id = ?`,
  )
  const deleteGroup = db.prepare(`DELETE FROM job_groups WHERE id = ?`)
  const updateGroup = db.prepare(
    `UPDATE job_groups
     SET status = ?, notes = ?, applied_at = ?, updated_at = datetime('now')
     WHERE id = ?`,
  )

  let mergeCount = 0
  const tx = db.transaction(() => {
    for (const groups of buckets.values()) {
      if (groups.length < 2) continue

      // Union-find on group indices, edges = (companies compatible AND title fuzzy match).
      const parent: number[] = groups.map((_, i) => i)
      const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])))
      const union = (a: number, b: number) => {
        const ra = find(a), rb = find(b)
        if (ra !== rb) parent[ra] = rb
      }

      for (let i = 0; i < groups.length; i++) {
        const aParts = groups[i].fingerprint.split('|')
        if (aParts.length !== 2) continue   // legacy malformed fingerprint — skip
        const [aCompany, aTitle] = aParts
        for (let j = i + 1; j < groups.length; j++) {
          const bParts = groups[j].fingerprint.split('|')
          if (bParts.length !== 2) continue
          const [bCompany, bTitle] = bParts
          if (!companiesCompatible(aCompany ?? '', bCompany ?? '')) continue
          if (levenshtein(aTitle ?? '', bTitle ?? '') <= FUZZY_TITLE_MAX_DISTANCE) {
            union(i, j)
          }
        }
      }

      // Collapse each connected component to the earliest-created group (oldest wins).
      const components = new Map<number, GroupForMerge[]>()
      for (let i = 0; i < groups.length; i++) {
        const root = find(i)
        if (!components.has(root)) components.set(root, [])
        components.get(root)!.push(groups[i])
      }

      for (const comp of components.values()) {
        if (comp.length < 2) continue
        comp.sort((a, b) => a.created_at.localeCompare(b.created_at))
        const survivor = comp[0]
        // Pick the most-progressed status from the whole component.
        let bestStatus = survivor.status
        let bestApplied = survivor.applied_at
        const noteParts: string[] = survivor.notes ? [survivor.notes] : []
        for (let k = 1; k < comp.length; k++) {
          const g = comp[k]
          if ((STATUS_PRIORITY[g.status] ?? 0) > (STATUS_PRIORITY[bestStatus] ?? 0)) {
            bestStatus = g.status
            bestApplied = g.applied_at ?? bestApplied
          } else if (g.applied_at && !bestApplied) {
            bestApplied = g.applied_at
          }
          if (g.notes && !noteParts.includes(g.notes)) noteParts.push(g.notes)
          reassignListings.run(survivor.id, g.id)
          deleteGroup.run(g.id)
          mergeCount++
        }
        updateGroup.run(bestStatus, noteParts.join('\n---\n'), bestApplied, survivor.id)
      }
    }
  })
  tx()

  if (mergeCount > 0) {
    console.log(`[migrations] re-merged ${mergeCount} duplicate group(s) into survivors`)
  }
}

