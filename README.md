# Vue Job Hunter

Aplikacja do automatycznego scrapowania ofert pracy dla Vue developera z polskich
portali IT. Wykrywa Vue również w opisach ofert (nie tylko w tytułach), grupuje
duplikaty z różnych źródeł i pozwala śledzić status aplikacji.

## Funkcje

- **Scraping** z 9 portali:
  - Tier 1 (JSON API): JustJoin.it, NoFluffJobs, rocketjobs.pl, Remote OK
  - Tier 2 (HTML/cheerio): Bulldogjob, LinkedIn (guest search)
  - Tier 3 (Playwright/Cloudflare): Pracuj.pl, theProtocol.it, Indeed.pl
  - **W kodzie, ale wyłączone**: solid.jobs, 4programmers.net — ich API są
    za tokenem sesji, wymagają dłuższego reverse-engineeringu; pliki
    `server/scrapers/solidjobs.ts` i `fourprogrammers.ts` zostają na
    przyszłe iteracje
- **Wykrywanie Vue** w tytule + opisie + skillach (regex z word-boundary)
- **Cross-source deduplikacja**: te same oferty na różnych portalach są scalane
  w jedną "grupę" — status i notatki trzymamy na grupie, nie na pojedynczych
  ogłoszeniach
- **Status aplikacji**: nowa / ciekawa / zaaplikowano / odpowiedź / odrzucona / ukryta
- **Notatki** do każdej grupy
- **Powiadomienia desktop** (Web Notifications API) gdy cron znajdzie nowe oferty
- **Cron** scrapuje w tle co X minut + przycisk "Scrapuj teraz" w UI
- **Filtry**: status, źródło, "tylko z Vue", search po firmie/tytule, "pokaż archiwum"
- **Kalkulator stawki** (panel boczny): przelicza stawkę godzinową/miesięczną/roczną
  w trybach B2B netto, UoP brutto i UoP netto; wyświetla równowartość w PLN/USD/EUR
  z kursami pobieranymi live z API NBP
- **Wykrywanie nieaktualnych** ofert: listing jest stale gdy nie był widziany
  przez >7 dni LUB jego `posted_at` jest starszy niż 60 dni (progi konfigurowalne).
  Grupa stale = wszystkie listingi stale. Stale ukrywane domyślnie

## Stack

Nuxt 3 (Vue 3 + Nitro server routes) · SQLite (better-sqlite3) ·
node-cron · cheerio

## Uruchomienie

Wymagania: Node 18+ (testowane na 24), npm.

```bash
npm install
cp .env.example .env       # opcjonalnie — domyślne wartości też zadziałają
npm run dev
```

Aplikacja wstaje pod `http://localhost:3000` (albo 3001/3002 jeśli 3000 zajęte —
patrz output `npm run dev`).

### Konfiguracja (`.env`)

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `DB_PATH` | `./data/jobs.sqlite` | Plik bazy SQLite (tworzony automatycznie) |
| `SCRAPE_INTERVAL_MINUTES` | `30` | Co ile minut cron robi scrape. `0` wyłącza cron (tylko manualnie) |
| `STALE_LAST_SEEN_DAYS` | `7` | Po ilu dniach nieaktualizowanego `last_seen_at` listing jest "stale" |
| `STALE_POSTED_DAYS` | `60` | Po ilu dniach od `posted_at` listing jest "stale" |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `NOTIFY_EMAIL` | puste | (zarezerwowane na powiadomienia email — nie wpięte w MVP) |

### Pierwszy scrape

Po starcie kliknij **"Scrapuj teraz"** w UI. Pierwszy scrape może trwać ~1–3 min
(JJIT paginuje strony po 10 i robi N+1 detail fetchów dla kandydatów frontendowych;
NFJ i Bulldogjob są szybsze). Kolejne scrape'y są szybsze, bo tylko aktualizują
`last_seen_at` dla już znanych ofert.

W trakcie scrape'a możesz wyłączyć filtr "Tylko z Vue" w nagłówku, żeby zobaczyć
też pozostałe oferty frontendowe (React-only, Angular itd.).

## Architektura

```
server/
├── api/                # Nitro REST endpoints (auto-routed)
│   ├── groups/         # GET lista, PATCH status/notes
│   ├── scrape.post.ts  # manualny trigger
│   ├── scrape/status   # historia uruchomień
│   └── new-since-visit # licznik nowych ofert dla badge
├── scrapers/
│   ├── types.ts             # wspólny interfejs JobScraper
│   ├── index.ts             # rejestr scraperów (TUTAJ dodajesz nowy portal)
│   ├── justjoin.ts          # JJIT (JSON candidate-api)
│   ├── nofluffjobs.ts       # NFJ (POST /api/search/posting)
│   ├── rocketjobs.ts        # rocketjobs.pl (siostra JJIT — ta sama API)
│   ├── remoteok.ts          # Remote OK (JSON feed)
│   ├── bulldogjob.ts        # BD (__NEXT_DATA__ JSON)
│   ├── linkedin.ts          # LinkedIn guest search (HTML + cheerio)
│   ├── pracuj.ts            # Pracuj.pl (Playwright + Cloudflare)
│   ├── theprotocol.ts       # theProtocol.it (Playwright + Cloudflare)
│   ├── indeed.ts            # Indeed.pl (Playwright + bot-defense)
│   ├── solidjobs.ts         # gotowy ale wyłączony (sesja/CSRF)
│   └── fourprogrammers.ts   # gotowy ale wyłączony (sesja/CSRF)
├── db/
│   ├── schema.ts       # SQL schema jako string (bundlowany przez Nitro)
│   ├── index.ts        # useDb()
│   └── repository.ts   # upsertListing + dedup engine
├── lib/
│   ├── vueDetector.ts  # regex Vue/React/Angular/Svelte
│   ├── fingerprint.ts  # normalizacja + Levenshtein dla cross-source dedup
│   └── orchestrator.ts # koordynacja scraperów (single-flight, transakcyjny insert)
├── plugins/
│   └── cron.ts              # interwał scrapowania
└── lib/
    └── browser.ts           # singleton headless Chromium dla Tier 3 scraperów
```

### Dedup engine (krótko)

Każda oferta z portalu (np. JJIT) to **listing** — jedna pozycja w
`job_listings`. Listingi z różnych portali, ale opisujące tę samą rolę
(JJIT + NFJ + LinkedIn) są scalane w **grupę** (`job_groups`).

Pipeline:
1. **Exact match**: `fingerprint = normalize(firma) + '|' + normalize(tytuł)`.
   Normalizacja usuwa `sp. z o.o.`, `S.A.`, sufiksy `(remote)`, `[m/f]`, `senior/junior`.
2. **Fuzzy match**: jeśli exact nie znalazł, szukamy grupy z tą samą firmą +
   Levenshtein tytułu ≤ 3 + grupa założona w ciągu 30 dni.
3. **Brak match** → nowa grupa.

Status, notatki, applied żyją na grupie. Bezpiecznik na błędy AI:
ręczne merge/split grup planowane w kolejnej iteracji (na razie regex pokrywa
~99% przypadków zgodności firma+tytuł).

### Wykrywanie Vue

Regex `\bvue(\.?js|2|3)?\b` (case-insensitive) na **tytule + opisie + skillach**.
Pokrywa: `Vue`, `Vue.js`, `vuejs`, `Vue 2`, `Vue 3`. Plus osobne flagi
`has_react`, `has_angular`, `has_svelte` żebyś widział mixedy (np. "React dev,
Vue mile widziane").

## Dodawanie nowego portalu

1. Stwórz `server/scrapers/<portal>.ts` implementujący `JobScraper` z `./types.ts`.
2. Zarejestruj w `server/scrapers/index.ts` (jedna linia w array `SCRAPERS`).
3. Tyle. Orchestrator automatycznie go uruchomi.

Każdy scraper zwraca `RawJob[]` — wspólny format. Dedup engine i Vue detector
działają identycznie dla wszystkich źródeł.

## Wymagania Playwright

Tier 3 scrapery (Pracuj.pl, theProtocol.it, Indeed.pl) używają Chromium
przez bibliotekę `playwright`. Pierwsza instalacja pobiera ~150MB Chromium do
`%LOCALAPPDATA%\ms-playwright`. Po `npm install` uruchom raz:

```bash
npx playwright install chromium
```

Chromium uruchamia się tylko na czas scrape'a i jest zamykany po zakończeniu
(orchestrator wywołuje `closeBrowser()` w `.finally`) — między scrape'ami
proces nie trzyma ~100MB RAM.

## Planowane (post-MVP)

- **solid.jobs + 4programmers.net**: ich API są za sesją/CSRF; trzeba wyciągnąć
  token z headless context i powtórzyć request z nagłówkami. Kod scraperów
  (`server/scrapers/solidjobs.ts`, `fourprogrammers.ts`) jest gotowy — wystarczy
  odkomentować w `server/scrapers/index.ts` po naprawieniu fetcha.
- **Ręczne merge/split grup** w UI (bezpiecznik na błędy fuzzy match).
  Kolumny `manually_merged`/`manually_split` są już w schema.
- **Powiadomienia email** (nodemailer + Gmail SMTP — scaffolding w `.env` już jest).
- **Re-fetch description** dla istniejących ofert co N dni (obecnie listing
  jest tylko `last_seen_at`-touchowany przy ponownym scrape).

## Production build

```bash
npm run build
node .output/server/index.mjs
```

Domyślnie nasłuchuje na 3000. SQLite w `./data/jobs.sqlite`.
