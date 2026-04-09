# Kenya Election Sentiment Poll

This project is a polling API and web page designed for:

- Kenya-only voting using IP geolocation checks.
- One vote identity using server-issued signed HttpOnly session cookies and database uniqueness.
- High-concurrency operation using Fastify + PostgreSQL + Redis.

## Tech stack

- Node.js + Fastify
- PostgreSQL (durable votes)
- Redis (short-lived vote locking under high concurrency)
- geoip-lite (country lookup)

## Quick start

1. Copy environment values:

```powershell
Copy-Item .env.example .env
```

2. Start Postgres and Redis:

```powershell
docker compose up -d postgres redis
```

3. Install dependencies:

```powershell
npm install
```

4. Initialize schema and seed poll:

```powershell
npm run db:init
```

5. Start the server:

```powershell
npm start
```

6. Open http://localhost:3000

## Production readiness checklist

Before deploying, complete all of the following:

- Use strong random secrets for `DEVICE_SALT`, `SESSION_SECRET`, `POSTGRES_PASSWORD`, and `REDIS_PASSWORD`.
- Set `NODE_ENV=production`.
- Set `ALLOWED_ORIGINS` to your exact frontend origin(s), comma separated.
- Keep `BYPASS_GEO_CHECK=false` and `ALLOW_LOCALHOST=false`.
- Keep `SESSION_COOKIE_SECURE=true` and terminate TLS at your reverse proxy/load balancer.
- Keep Redis and Postgres private (do not expose host ports publicly).

Generate 64-byte secrets locally:

```powershell
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

## Deploying with Docker Compose (production)

1. Copy the template and set secure values:

```powershell
Copy-Item .env.example .env
```

2. Start the full stack:

```powershell
docker compose up --build -d
```

3. Verify health endpoint:

```powershell
Invoke-WebRequest http://localhost:3000/health
```

4. Confirm only the app port is exposed:

```powershell
docker compose ps
```

## Deploying on Vercel + Supabase (recommended)

Use this path if you want managed hosting with low ops overhead.

1. Create Supabase project and run schema:

```sql
-- In Supabase SQL Editor
-- paste and run sql/schema.sql
```

2. Create Upstash Redis and copy TLS URL:

```text
rediss://default:<token>@<host>:6379
```

3. Import this repo into Vercel and set environment variables (Production):

- `NODE_ENV=production`
- `DATABASE_URL=<Supabase pooled Postgres URL>`
- `REDIS_URL=<Upstash rediss URL>`
- `REDIS_TLS=true`
- `DEVICE_SALT=<64+ random hex chars>`
- `SESSION_SECRET=<64+ random hex chars>`
- `ALLOWED_ORIGINS=https://kpolls.me,https://www.kpolls.me`
- `SESSION_COOKIE_SECURE=true`
- `TRUST_PROXY=true`
- `BYPASS_GEO_CHECK=false`
- `ALLOW_LOCALHOST=false`

4. Add domains in Vercel (`kpolls.me`, `www.kpolls.me`) and update DNS to Vercel.

5. Deploy and verify:

```text
https://kpolls.me/health
```

For a full go-live list, follow [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md).

## Launch Live On A VPS (Ubuntu + HTTPS)

Use this when you want a public URL with SSL.

1. Provision an Ubuntu VPS and point your domain A record to the server IP.

2. SSH into the server and install Docker + Compose plugin:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin git
```

3. Clone your repo and enter it:

```bash
git clone https://github.com/nambiropeter/2027-election.git
cd 2027-election
```

4. Create production env values:

```bash
cp .env.example .env
```

Then edit `.env` and set all secure values, especially:

- `DOMAIN_NAME` (for example: `kpolls.me`)
- `ALLOWED_ORIGINS=https://kpolls.me,https://www.kpolls.me`
- strong random values for `DEVICE_SALT`, `SESSION_SECRET`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`
- keep `BYPASS_GEO_CHECK=false`, `ALLOW_LOCALHOST=false`, `SESSION_COOKIE_SECURE=true`

5. Start the production stack (Caddy + app + Postgres + Redis):

```bash
sudo docker compose -f docker-compose.prod.yml up --build -d
```

6. Verify deployment:

```bash
sudo docker compose -f docker-compose.prod.yml ps
curl -I https://kpolls.me/health
```

Notes:

- `docker-compose.prod.yml` uses Caddy for automatic HTTPS certificates.
- Keep ports `80/443` open on your VPS firewall; do not expose Postgres/Redis.
- App schema auto-initializes on startup.

## One-command container deployment

After creating `.env`, bring up app + PostgreSQL + Redis together:

```powershell
docker compose up --build -d
```

Then open http://localhost:3000

## API

### GET /api/poll
Returns active poll and vote totals.

### POST /api/vote
Body:

```json
{
  "optionId": 1
}
```

Possible responses:

- `201` Vote recorded
- `400` Invalid payload
- `403` Non-Kenya IP blocked
- `401` Missing/invalid vote session cookie
- `409` Device already voted
- `429` Concurrent duplicate request for same device

### Session identity

- The server issues a signed HttpOnly cookie on `GET /api/poll`.
- The cookie payload is tied to poll id, browser fingerprint context, and expiry.
- `POST /api/vote` requires this cookie and rejects missing/invalid sessions.
- Clearing browser storage no longer resets identity if the same fingerprint context is reused before session expiry.

## Abuse controls

The API includes Redis-backed abuse controls on the vote endpoint:

- Per-IP rate limit per minute (`VOTE_PER_IP_PER_MINUTE`)
- Per-IP rate limit per hour (`VOTE_PER_IP_PER_HOUR`)
- Geo-block anomaly spike alerts (`ANOMALY_BLOCKED_GEO_THRESHOLD_PER_MINUTE`)
- IP fanout anomaly alerts for too many device IDs (`ANOMALY_UNIQUE_DEVICES_PER_IP_PER_MINUTE`)
- Alert cooldown to avoid spam (`ANOMALY_ALERT_COOLDOWN_SECONDS`)

Alert delivery:

- If `ALERT_WEBHOOK_URL` is set, alerts are POSTed as JSON.
- Alerts are also written to the app logs.

## Concurrency/load testing (1000 users)

Run a local stress test with 1000 simultaneous connections:

```powershell
$env:BYPASS_GEO_CHECK="true"
npm run load:test
```

Notes:

- `BYPASS_GEO_CHECK=true` is recommended for local testing unless your local public IP geolocates to Kenya.
- Load test sends unique `x-device-id` per request to simulate different devices.

## Security and accuracy notes

- IP geolocation can be bypassed by VPN/proxy users.
- Device IDs are stronger than plain cookies but still not tamper-proof if someone manipulates browser storage.
- For stricter anti-fraud, combine this with phone OTP or national-ID verification.

## Security defaults in this build

- Production startup now fails fast if required secrets are weak/missing.
- CORS is restricted by `ALLOWED_ORIGINS`.
- Session cookies are secure by default in production.
- Redis can enforce password auth and optional TLS mode.
- Postgres and Redis run on an internal Docker network by default.
