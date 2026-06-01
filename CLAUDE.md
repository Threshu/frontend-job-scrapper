# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server (localhost:3000, hot-reload)
npm run build        # Production SSR build
npm run preview      # Preview production build
npm run db:init      # Initialize SQLite schema (runs automatically on first server start)
```

No test runner is configured. Type-checking is via `nuxt typecheck` (uses Nuxt's auto-generated tsconfig).

## Architecture Overview

**Vue Job Hunter** is a Nuxt 3 app that scrapes Polish IT job portals for Vue/frontend roles, deduplicates them, and presents them in a filterable list.

```
Nitro server (SSR + API routes)
  └── server/api/            — REST endpoints consumed by the Vue frontend
  └── server/scrapers/       — One file per portal; all registered in index.ts
  └── server/lib/
        orchestrator.ts      — Coordinates scraper runs (single-flight, tiered parallelism)
        browser.ts           — Shared Playwright Chromium context (lazy, closed after each run)
        fingerprint.ts       — Company/title normalization + Levenshtein fuzzy match
        vueDetector.ts       — Regex-based framework detection on title/description/skills
  └── server/db/
        index.ts             — better-sqlite3 singleton (WAL mode, opened via useDb())
        repository.ts        — All DB reads/writes; upsertListing() is the core dedup pipeline
        schema.ts            — 4 tables: job_listings, job_groups, scrape_runs, app_state
  └── server/plugins/cron.ts — node-cron that auto-triggers runScrape() on Nitro startup
pages/index.vue              — Single-page UI with filters, progress panel, status tracking
```

## Scraper Tiers

The orchestrator runs scrapers in two tiers to avoid browser context conflicts:

- **Tier 1 — plain fetch** (`needsBrowser: false`): JustJoin.it, NoFluffJobs, rocketjobs.pl, Remote OK, Bulldogjob, LinkedIn. Run in `Promise.all()`.
- **Tier 2 — Playwright** (`needsBrowser: true`): Pracuj.pl, theProtocol.it, Indeed.pl. Run sequentially in a shared Chromium context with anti-bot patches.

## Adding a New Scraper

1. Create `server/scrapers/<portal>.ts` implementing the `JobScraper` interface from `server/scrapers/types.ts`.
2. Return `ScrapeResult` with `jobs: RawJob[]`, `errors: string[]`, optional `closedIds: string[]` (source IDs confirmed gone, used to expire listings).
3. Register in `server/scrapers/index.ts` by adding to the `SCRAPERS` array.

`RawJob.description` must be populated — the Vue detector runs regex on it. `sourceId` must be stable per listing (used as the upsert key).

## Dedup Pipeline (`upsertListing`)

Each `RawJob` goes through this pipeline inside a single DB transaction:

1. **Framework detection** — `vueDetector.ts` sets `has_vue`, `has_react`, `has_angular`, `has_svelte`, `vue_in_title` integer flags on the listing row.
2. **Group lookup** — tries in order:
   - Exact: `fingerprint` match (normalized company + normalized title, see `fingerprint.ts`)
   - Fuzzy: same normalized company + Levenshtein title distance ≤ 3 + group created within 30 days
   - New: create a new `job_groups` row
3. **Upsert listing** — `INSERT OR IGNORE` then `UPDATE last_seen_at`. Returns `{ isNewListing, isNewGroup }`.

**Status and notes live on `job_groups`**, not `job_listings`. A group can aggregate listings from multiple portals for the same role.

## Key DB Tables

| Table | Purpose |
|---|---|
| `job_listings` | One row per portal listing; has framework flags, salary, FK to group |
| `job_groups` | Deduped entity; holds user-facing status (`new`/`interesting`/`applied`/`rejected`/`hidden`) and notes |
| `scrape_runs` | Audit log per source per run; `error_message` stores concatenated scraper errors |
| `app_state` | Simple key-value; currently stores `lastVisitAt` for the "new since visit" badge |

## Runtime Config

Set via environment variables (see `.env.example`); read server-side via `useRuntimeConfig()`:

| Key | Default | Notes |
|---|---|---|
| `DB_PATH` | `./data/jobs.sqlite` | Relative to `process.cwd()` |
| `SCRAPE_INTERVAL_MINUTES` | `30` | Cron interval |
| `STALE_LAST_SEEN_DAYS` | `7` | Listings not seen in N days get expired |
| `STALE_POSTED_DAYS` | `60` | Listings older than N days get expired |

## Playwright / Anti-Bot Notes

`server/lib/browser.ts` maintains a single lazy `BrowserContext` reused across all Playwright scrapers in one run, then closed via `closeBrowser()` in the orchestrator's `.finally()`. The context patches: `navigator.webdriver`, `chrome` runtime, plugins list, languages, `hardwareConcurrency`, `deviceMemory`, and full `userAgentData` Client Hints (must stay in sync with the `USER_AGENT` string). Cloudflare challenge pages return title `"Cierpliwości..."` — if that appears in `scrape_runs.error_message`, the challenge timed out unsolved.
