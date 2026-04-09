# Deployment Checklist (Vercel + Supabase)

## 1. Supabase Setup

- [ ] Create a Supabase project (region near Kenya).
- [ ] In Supabase, open SQL Editor and run [sql/schema.sql](sql/schema.sql).
- [ ] In Project Settings -> Database, copy the pooled Postgres connection string.
- [ ] Ensure the DB password in the URL is URL-encoded if it contains special characters.

## 2. Redis Setup (Upstash)

- [ ] Create an Upstash Redis database.
- [ ] Copy the TLS URL in this format:
  - `rediss://default:<token>@<host>:6379`
- [ ] Keep `REDIS_TLS=true`.

## 3. Vercel Project Setup

- [ ] Import repository in Vercel.
- [ ] Framework preset: `Other`.
- [ ] Root directory: project root.
- [ ] Confirm [vercel.json](vercel.json) is detected.

## 4. Production Environment Variables (Vercel)

- [ ] `NODE_ENV=production`
- [ ] `DATABASE_URL=<Supabase pooled Postgres URL>`
- [ ] `REDIS_URL=<Upstash rediss URL>`
- [ ] `REDIS_PASSWORD=` (leave blank unless your URL style requires it)
- [ ] `REDIS_TLS=true`
- [ ] `DEVICE_SALT=<64+ random hex chars>`
- [ ] `SESSION_SECRET=<64+ random hex chars>`
- [ ] `ALLOWED_ORIGINS=https://kpolls.me,https://www.kpolls.me`
- [ ] `SESSION_COOKIE_SECURE=true`
- [ ] `SESSION_COOKIE_SAME_SITE=strict`
- [ ] `TRUST_PROXY=true`
- [ ] `BYPASS_GEO_CHECK=false`
- [ ] `ALLOW_LOCALHOST=false`
- [ ] `ALLOWED_COUNTRY_CODE=KE`
- [ ] Optional alerting: `ALERT_WEBHOOK_URL=<your webhook>`

Generate secrets locally:

```powershell
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

## 5. Domain

- [ ] Add `kpolls.me` and `www.kpolls.me` in Vercel Domains.
- [ ] Update DNS records at registrar to Vercel targets.
- [ ] Wait for SSL issuance in Vercel.

## 6. Deploy

- [ ] Push latest code to `main`.
- [ ] Trigger deploy in Vercel (auto on push if connected).
- [ ] Open deployment logs and confirm API function built successfully.

## 7. Verify Production

- [ ] Visit `https://kpolls.me/health` and confirm response includes `{"status":"ok"}`.
- [ ] Visit `https://kpolls.me` and load the poll.
- [ ] Cast one test vote and verify totals update.
- [ ] Confirm duplicate vote from same device is rejected.

## 8. Post-Launch Checks

- [ ] Verify Supabase connections are healthy.
- [ ] Verify Upstash command metrics are normal.
- [ ] Confirm logs show no config or CORS errors.
- [ ] Set up uptime monitor on `/health`.

## 9. Optional Cost Controls

- [ ] Set Vercel spend limit alerts.
- [ ] Set Supabase project budget alerts.
- [ ] Set Upstash usage alerts.

## Notes

- This project now uses Vercel serverless for backend + static frontend.
- AWS deployment artifacts were removed from the repository.

## 10. AdSense Readiness

- [ ] Replace placeholder publisher ID in [public/index.html](public/index.html) with your real AdSense client ID.
- [ ] Replace placeholder ad slot ID in [public/index.html](public/index.html) with your real slot ID.
- [ ] Replace placeholder publisher record in [public/ads.txt](public/ads.txt) with your real publisher ID.
- [ ] Verify legal pages are live:
  - [ ] [public/privacy.html](public/privacy.html)
  - [ ] [public/terms.html](public/terms.html)
  - [ ] [public/contact.html](public/contact.html)
  - [ ] [public/about.html](public/about.html)
- [ ] Verify crawl files are live:
  - [ ] [public/robots.txt](public/robots.txt)
  - [ ] [public/sitemap.xml](public/sitemap.xml)
- [ ] Confirm consent banner appears to first-time visitors and stores choice.
- [ ] Submit site in Google AdSense and wait for crawler review.
