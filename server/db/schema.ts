// Schema as a string so it bundles with the Nitro server output.
// Mirrors schema.sql; keep in sync if you edit either.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS job_listings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT    NOT NULL,
  source_id       TEXT    NOT NULL,
  url             TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  company         TEXT    NOT NULL,
  location        TEXT,
  remote          INTEGER NOT NULL DEFAULT 0,
  salary_min      INTEGER,
  salary_max      INTEGER,
  currency        TEXT,
  salary_period   TEXT,
  contract_type   TEXT,
  experience      TEXT,
  description     TEXT NOT NULL DEFAULT '',
  skills_json     TEXT NOT NULL DEFAULT '[]',
  has_vue         INTEGER NOT NULL DEFAULT 0,
  has_react       INTEGER NOT NULL DEFAULT 0,
  has_angular     INTEGER NOT NULL DEFAULT 0,
  has_svelte      INTEGER NOT NULL DEFAULT 0,
  vue_in_title    INTEGER NOT NULL DEFAULT 0,
  -- Vue's role in the posting: 'primary' (Vue in title), 'required' (must-have stack),
  -- 'mention' (nice-to-have only) or 'none'. Used to filter out Senior-Python-with-Vue-bonus noise.
  vue_relevance   TEXT NOT NULL DEFAULT 'none',
  posted_at       TEXT,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  group_id        INTEGER REFERENCES job_groups(id) ON DELETE SET NULL,
  UNIQUE(source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_listings_group       ON job_listings(group_id);
CREATE INDEX IF NOT EXISTS idx_listings_source      ON job_listings(source);
CREATE INDEX IF NOT EXISTS idx_listings_has_vue     ON job_listings(has_vue);
CREATE INDEX IF NOT EXISTS idx_listings_first_seen  ON job_listings(first_seen_at DESC);
-- Stale filter uses last_seen_at / posted_at in datetime() comparisons on nearly
-- every list query — without these indexes the query full-scans job_listings.
CREATE INDEX IF NOT EXISTS idx_listings_last_seen   ON job_listings(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_posted      ON job_listings(posted_at);
-- Composite for the EXISTS subquery that joins group_id with last_seen_at
-- (most selective when the group filter narrows first).
CREATE INDEX IF NOT EXISTS idx_listings_group_seen  ON job_listings(group_id, last_seen_at);
-- idx_listings_vue_releva and idx_groups_stem are created in migrations.ts after
-- the ALTER TABLE that adds those columns on pre-existing databases.

CREATE TABLE IF NOT EXISTS job_groups (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint         TEXT NOT NULL,
  -- Single distinctive token derived from the normalized company name.
  -- Drives fuzzy company matching ("Luxoft" / "Luxoft Poland" / "Luxoft DXC"
  -- all share canonical_stem = "luxoft").
  canonical_stem      TEXT NOT NULL DEFAULT '',
  canonical_title     TEXT NOT NULL,
  canonical_company   TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'new',
  notes               TEXT NOT NULL DEFAULT '',
  applied_at          TEXT,
  manually_merged     INTEGER NOT NULL DEFAULT 0,
  manually_split      INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_groups_fingerprint ON job_groups(fingerprint);
CREATE INDEX IF NOT EXISTS idx_groups_status      ON job_groups(status);
CREATE INDEX IF NOT EXISTS idx_groups_created     ON job_groups(created_at DESC);
-- Main list ordering is ORDER BY g.updated_at DESC LIMIT ... — the sort was
-- previously a filesort over the whole table.
CREATE INDEX IF NOT EXISTS idx_groups_updated     ON job_groups(updated_at DESC);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  new_count     INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON scrape_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`
