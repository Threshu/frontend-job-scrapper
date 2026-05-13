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
    smtpHost: process.env.SMTP_HOST || '',
    smtpUser: process.env.SMTP_USER || '',
    smtpPass: process.env.SMTP_PASS || '',
    notifyEmail: process.env.NOTIFY_EMAIL || '',
  },
})
