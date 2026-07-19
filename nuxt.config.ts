export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },
  ssr: true,
  css: ['~/assets/css/app.css'],
  nitro: {
    experimental: {
      tasks: true,
    },
  },
  runtimeConfig: {
    dbPath: process.env.DB_PATH || './data/jobs.sqlite',
    scrapeIntervalMinutes: Number(process.env.SCRAPE_INTERVAL_MINUTES || 30),
    staleLastSeenDays: Number(process.env.STALE_LAST_SEEN_DAYS || 7),
    stalePostedDays: Number(process.env.STALE_POSTED_DAYS || 60),
    public: {
      staleLastSeenDays: Number(process.env.STALE_LAST_SEEN_DAYS || 7),
      stalePostedDays: Number(process.env.STALE_POSTED_DAYS || 60),
    },
  },
})
