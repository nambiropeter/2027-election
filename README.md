# KPolls Kenya — 2027 presidential preference poll

A public sentiment poll with one vote per device, Kenya-focused participation,
and live tallies.

## How the one-vote guarantee works

There is no login, so "one vote per device" has to be enforced without an
identity provider. Three layers do it, strongest first:

1. **A signed voter token.** `GET /poll` mints an HMAC-SHA256 signed blob
   containing a random device id. The browser stores it and replays it on every
   vote. It can be read but not forged, and **only the read endpoint mints
   tokens** — the vote endpoint never does. Discarding the token loses the
   receipt; it does not create a second voter, because the salted hash of that
   device id is what a `UNIQUE (poll_id, device_hash)` index keys on.
2. **One atomic database call.** Every check and the insert happen inside
   `cast_vote()`, so two simultaneous requests cannot both pass the "have you
   voted?" test. Verified: 15 concurrent votes with one token produce exactly
   one row.
3. **Rate limits and a fan-out throttle.** Per-IP limits per minute and per
   hour, plus a soft cap on votes sharing one network block and browser
   signature.

**What this does not stop.** A determined person with several devices, or a
browser profile plus an incognito window on a different network, can vote more
than once — that is true of every public web poll without verified identity.
The layers above raise the cost and make scripted ballot-stuffing visible;
they are not an electoral roll. The fan-out cap is deliberately generous
(25 by default) because Kenyan mobile networks put very many genuine voters
behind one CGNAT address range, and a tight cap would lock out real people.

## Architecture

The page talks to **one** backend, selected by `apiBase` in
`public/assets/config.js`. All three implement the same contract and the same
token format, so you can switch between them without invalidating anyone's vote.

| Backend | Path | Best for |
|---|---|---|
| Supabase Edge Functions | `supabase/functions/` | Static hosting (Vercel) with no server |
| Node + Fastify | `src/` | Self-hosting with Docker/Caddy |
| ASP.NET Core | `services/KPolls.Api/` | Highest throughput; in-memory tally cache |

The integrity rules live in Postgres (`cast_vote`, `poll_results`,
`has_voted`, `consume_rate_limit`), not in any one backend, so all three
enforce them identically.

### API contract

| Endpoint | Purpose |
|---|---|
| `GET /poll` | Question, options, tallies, whether this device already voted, and a voter token |
| `GET /results` | Tallies only — cheap, safe to poll on a timer |
| `POST /vote` | `{ "optionId": 3 }` plus the token in the `x-voter-token` header |

Vote responses: `201` recorded, `401` missing/expired token, `409` already
voted (includes `votedOptionId`), `403` geo-blocked, `429` rate limited.

## Quick start (Node backend)

```bash
cp .env.example .env          # then fill in DEVICE_SALT and SESSION_SECRET
npm install
docker compose up -d postgres redis   # optional: Redis is not required
npm run db:init               # applies sql/schema.sql + every migration
npm start                     # http://localhost:3000
```

Generate the two secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Redis is optional. When it is unreachable the Node server falls back to the
Postgres `consume_rate_limit()` function automatically.

## Deploying on Supabase + Vercel

This is the setup for a static frontend with no server of your own.

### The scripted path

```bash
npx supabase login                              # opens a browser
npx supabase link --project-ref <your-ref>      # prompts for your DB password
./scripts/setup-supabase.sh <your-ref>
```

That pushes the migrations, generates and stores the secrets in `.env`, deploys
both functions with `--no-verify-jwt`, writes your project ref and anon key into
`public/assets/config.js`, and then calls the live endpoint to prove it works.
Re-running it reuses the existing secrets — regenerating `DEVICE_SALT` would
invalidate every token already issued and let people vote a second time.

### Or manually

1. **Apply the migrations** (`supabase db push`, or paste
   `supabase/migrations/20260930_secure_poll.sql` into the SQL editor). This
   also turns on row level security — see the warning below.
2. **Set the function secrets:**
   ```bash
   supabase secrets set DEVICE_SALT=... SESSION_SECRET=... \
     ALLOWED_ORIGINS=https://kpolls.me,https://www.kpolls.me \
     ALLOWED_COUNTRY_CODE=KE GEO_ENFORCEMENT=lenient
   ```
   `TOKEN_SECRET` falls back to `DEVICE_SALT` when unset.
3. **Deploy the functions:**
   ```bash
   supabase functions deploy poll --no-verify-jwt
   supabase functions deploy vote --no-verify-jwt
   ```
   `--no-verify-jwt` matters. These endpoints are called by an anonymous
   browser with no JWT; with verification on, **every request fails with
   `401 Invalid JWT`**. `supabase/config.toml` sets `verify_jwt = false` for
   both functions so local runs match.
4. **Point the page at the functions** in `public/assets/config.js`:
   ```js
   apiBase: "https://<your-ref>.supabase.co/functions/v1",
   supabaseAnonKey: "<your anon key>",
   ```
5. Deploy to Vercel. `vercel.json` serves `public/` with security headers.

> **Row level security.** The migration enables RLS on every table and grants
> nothing to `anon` or `authenticated`. Without it, the anon key that ships in
> your page lets anyone insert or delete rows in `votes` straight through
> PostgREST, which makes the poll trivially riggable. The edge functions use the
> service role, which bypasses RLS, so they keep working.

## The C# service

`services/KPolls.Api` is an ASP.NET Core minimal API covering the same contract
with the throughput work done: reflection-free JSON via a source-generated
serializer context, a single-flight in-memory tally cache (the read path is far
hotter than the write path), the built-in partitioned rate limiter in front of
the database, pooled Npgsql, response compression and server GC.

```bash
cd services/KPolls.Api
dotnet run                    # reads the same .env keys from the environment
```

It serves `public/` as well, so it can replace the Node server outright. Set
`STATIC_ROOT` to override where it looks for the site.

**Not built or run here** — this machine has no .NET SDK, so unlike the Node
path it has not been executed. Run `dotnet build` before relying on it.

## Operations

```bash
npm run security:check          # dependency audit
MODE=read npm run load:test     # tally endpoint under load
MODE=vote CONNECTIONS=200 npm run load:test   # vote path, distinct tokens
```

Run `SELECT prune_rate_limits();` periodically (a daily cron is plenty) to clear
expired rate-limit rows.

## Configuration notes

- `DEVICE_SALT` and `SESSION_SECRET` must be identical across every backend you
  run, or tokens from one are rejected by the others and people can vote again.
- `GEO_ENFORCEMENT=strict` blocks connections whose country cannot be
  determined. Only use it if you are certain every genuine request carries a
  country header from your CDN; otherwise it rejects real voters. The default
  `lenient` blocks only positively-identified foreign traffic.
- `TOKEN_TTL_HOURS` should outlast the poll. An expired token lets the same
  person vote again.

See `.env.example` for the full list and `DEPLOYMENT_CHECKLIST.md` before going
live.
