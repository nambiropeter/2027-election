# Deployment checklist

Work top to bottom. The first two sections are the ones that break polls.

## 1. Database

- [ ] Applied `sql/schema.sql` and every file in `supabase/migrations/`
      (`npm run db:init`, or `supabase db push`).
- [ ] **Row level security is on.** Verify:
      ```sql
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('polls','poll_options','votes','rate_limits');
      ```
      All four must be `t`. Without this the public anon key can write to
      `votes` directly and the poll can be rigged.
- [ ] `anon` has no table grants:
      ```sql
      SELECT * FROM information_schema.role_table_grants
      WHERE grantee = 'anon' AND table_name IN ('polls','poll_options','votes');
      ```
      Must return zero rows.
- [ ] `cast_vote`, `poll_results`, `has_voted` and `consume_rate_limit` exist.
- [ ] A scheduled job runs `SELECT prune_rate_limits();` daily.

## 2. Secrets and origins

- [ ] `DEVICE_SALT` and `SESSION_SECRET` are 32+ random characters and are
      **identical across every backend you run**. Mismatched values mean tokens
      issued by one backend are rejected by another, which lets the same person
      vote again.
- [ ] Neither contains `replace-this`, `changeme` or `default` — the Node
      config refuses to start in production if they do.
- [ ] `ALLOWED_ORIGINS` lists every hostname the page is served from, including
      the `www` variant.
- [ ] `TOKEN_TTL_HOURS` outlasts the poll's closing date.

## 3. Supabase Edge Functions (if used)

- [ ] Deployed with `--no-verify-jwt`. With JWT verification on, every
      anonymous browser request returns `401 Invalid JWT` and the page shows
      nothing. This was the original cause of the site not working.
- [ ] Secrets set via `supabase secrets set` (functions do not read `.env`).
- [ ] `public/assets/config.js` has `apiBase` pointing at
      `https://<ref>.supabase.co/functions/v1` and `supabaseAnonKey` filled in.

## 4. Self-hosted backend (if used)

- [ ] `TRUST_PROXY=true` only when actually behind your own reverse proxy.
      Setting it without a proxy lets a client spoof `X-Forwarded-For` and
      bypass per-IP rate limits.
- [ ] `SESSION_COOKIE_SECURE=true` and HTTPS terminating correctly.
- [ ] `ALLOW_LOCALHOST=false` and `GEO_ENFORCEMENT` is not `off` (the Node
      config refuses to start in production otherwise).
- [ ] `npm run prod:validate-config` passes.

## 5. Verify the live site

- [ ] `GET /health` returns `{"status":"ok"}`.
- [ ] Loading the page shows the question and the ballot, not an error.
- [ ] Casting a vote returns `201` and the results view appears.
- [ ] **Reloading the page still shows the results view**, not the ballot —
      this proves the server, not local storage, remembers the vote.
- [ ] Voting a second time in a private window with local storage cleared
      returns `409` on the same browser profile.
- [ ] Browser console is free of CSP violations and CORS errors.
- [ ] Check a foreign origin gets no `Access-Control-Allow-Origin` header:
      ```bash
      curl -sI https://kpolls.me/api/poll -H 'Origin: https://evil.example' | grep -i access-control
      ```

## 6. Load and abuse

- [ ] `MODE=read npm run load:test` at expected peak concurrency.
- [ ] `MODE=vote npm run load:test` — confirm vote count equals distinct tokens.
- [ ] Rate limits trip as configured (`429` after `VOTE_PER_IP_PER_MINUTE`).
- [ ] `ALERT_WEBHOOK_URL` set and a test alert received.

## 7. Ads and compliance

- [ ] `adsenseClient` / `adsenseSlot` set in `public/assets/config.js`, or left
      as `REPLACE_WITH_...` to keep ads and the consent banner switched off.
- [ ] `public/ads.txt` matches your AdSense publisher id.
- [ ] Privacy and terms pages reflect what you actually collect.
