-- One row per scraped listing from a specific source.
-- A logical job posting (the same role appearing on JJIT + NFJ + LinkedIn)
-- is represented by N rows here, all sharing the same group_id.
CREATE TABLE IF NOT EXISTS job_listings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT    NOT NULL,           -- 'justjoin' | 'nofluffjobs' | 'theprotocol' | 'bulldogjob' | ...
  source_id       TEXT    NOT NULL,           -- portal-specific identifier (slug, id)
  url             TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  company         TEXT    NOT NULL,
  location        TEXT,
  remote          INTEGER NOT NULL DEFAULT 0, -- bool
  salary_min      INTEGER,
  salary_max      INTEGER,
  currency        TEXT,
  salary_period   TEXT,                       -- 'month' | 'hour' | NULL
  contract_type   TEXT,                       -- 'b2b' | 'permanent' | 'mandate' | NULL
  experience      TEXT,                       -- 'junior' | 'mid' | 'senior' | NULL
  description     TEXT NOT NULL DEFAULT '',
  skills_json     TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  has_vue         INTEGER NOT NULL DEFAULT 0,
  has_react       INTEGER NOT NULL DEFAULT 0,
  has_angular     INTEGER NOT NULL DEFAULT 0,
  has_svelte      INTEGER NOT NULL DEFAULT 0,
  vue_in_title    INTEGER NOT NULL DEFAULT 0,
  posted_at       TEXT,                       -- ISO timestamp from source
  first_seen_at   TEXT NOT NULL,              -- ISO timestamp when we first saw it
  last_seen_at    TEXT NOT NULL,              -- ISO timestamp of latest scrape that confirmed it
  group_id        INTEGER REFERENCES job_groups(id) ON DELETE SET NULL,
  UNIQUE(source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_listings_group     ON job_listings(group_id);
CREATE INDEX IF NOT EXISTS idx_listings_source    ON job_listings(source);
CREATE INDEX IF NOT EXISTS idx_listings_has_vue   ON job_listings(has_vue);
CREATE INDEX IF NOT EXISTS idx_listings_first_seen ON job_listings(first_seen_at DESC);

-- Logical group: a single role aggregated across sources.
-- User-facing decisions (status, notes, applied) live here, not on individual listings.
CREATE TABLE IF NOT EXISTS job_groups (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint         TEXT NOT NULL,            -- normalize(company)|normalize(title)
  canonical_title     TEXT NOT NULL,
  canonical_company   TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'new', -- new|interested|applied|replied|rejected|hidden
  notes               TEXT NOT NULL DEFAULT '',
  applied_at          TEXT,
  manually_merged     INTEGER NOT NULL DEFAULT 0, -- user merged it; do not auto-split
  manually_split      INTEGER NOT NULL DEFAULT 0, -- user split it; do not auto-merge into other groups
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_groups_fingerprint ON job_groups(fingerprint);
CREATE INDEX IF NOT EXISTS idx_groups_status      ON job_groups(status);
CREATE INDEX IF NOT EXISTS idx_groups_created     ON job_groups(created_at DESC);

-- Tracks each scrape run for monitoring & "new since last visit" counters.
CREATE TABLE IF NOT EXISTS scrape_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL,              -- 'running' | 'ok' | 'error'
  fetched_count INTEGER NOT NULL DEFAULT 0,
  new_count     INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON scrape_runs(started_at DESC);

-- Simple key/value store for app state (e.g. last visit timestamp for "new" badges).
CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
