#!/usr/bin/env bash
#
# Provisions the Supabase backend for kpolls.me end to end.
#
# Run the two interactive steps yourself first (they open a browser / prompt for
# your database password):
#
#   npx supabase login
#   npx supabase link --project-ref <your-project-ref>
#
# Then:
#   ./scripts/setup-supabase.sh <your-project-ref>
#
# Safe to re-run. Secrets are generated once and kept in .env (gitignored);
# subsequent runs reuse them, because regenerating DEVICE_SALT would invalidate
# every voter token already issued and let people vote a second time.

set -euo pipefail

PROJECT_REF="${1:-}"
SITE_ORIGINS="${ALLOWED_ORIGINS:-https://kpolls.me,https://www.kpolls.me}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [ -z "$PROJECT_REF" ]; then
  echo "Usage: ./scripts/setup-supabase.sh <project-ref>" >&2
  echo "Find the ref in your Supabase dashboard URL: /project/<ref>" >&2
  exit 1
fi

cd "$ROOT"

supa() { npx --yes supabase "$@"; }

# --- 1. secrets -------------------------------------------------------------
# Reuse whatever is already in .env; only generate what is missing.

read_env() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true
}

gen_secret() {
  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
}

DEVICE_SALT="$(read_env DEVICE_SALT)"
SESSION_SECRET="$(read_env SESSION_SECRET)"

case "$DEVICE_SALT" in ""|*replace-with*) DEVICE_SALT="$(gen_secret)"; NEW_SALT=1 ;; esac
case "$SESSION_SECRET" in ""|*replace-with*) SESSION_SECRET="$(gen_secret)"; NEW_SECRET=1 ;; esac

if [ -n "${NEW_SALT:-}${NEW_SECRET:-}" ]; then
  echo "==> Generated new secrets; saving to .env"
  touch "$ENV_FILE"
  # Drop any previous placeholder lines, then append the real values.
  grep -vE '^(DEVICE_SALT|SESSION_SECRET)=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  {
    echo "DEVICE_SALT=$DEVICE_SALT"
    echo "SESSION_SECRET=$SESSION_SECRET"
  } >> "$ENV_FILE"
else
  echo "==> Reusing existing secrets from .env"
fi

# --- 2. schema --------------------------------------------------------------

echo "==> Pushing migrations (creates tables, RLS, cast_vote, candidates)"
supa db push

# --- 3. function secrets ----------------------------------------------------

echo "==> Setting Edge Function secrets"
supa secrets set \
  "DEVICE_SALT=$DEVICE_SALT" \
  "SESSION_SECRET=$SESSION_SECRET" \
  "TOKEN_SECRET=$SESSION_SECRET" \
  "ALLOWED_ORIGINS=$SITE_ORIGINS" \
  "ALLOWED_COUNTRY_CODE=KE" \
  "GEO_ENFORCEMENT=lenient" \
  "MAX_VOTES_PER_FINGERPRINT=25" \
  "VOTE_PER_IP_PER_MINUTE=10" \
  "VOTE_PER_IP_PER_HOUR=60" \
  "TOKEN_TTL_HOURS=8760" >/dev/null

# --- 4. functions -----------------------------------------------------------
# --no-verify-jwt is essential: the poll page is anonymous and has no JWT, so
# with verification on every request returns 401 Invalid JWT.

echo "==> Deploying functions"
supa functions deploy poll --no-verify-jwt
supa functions deploy vote --no-verify-jwt

# --- 5. wire up the frontend ------------------------------------------------

echo "==> Fetching anon key"
ANON_KEY="$(supa projects api-keys --project-ref "$PROJECT_REF" --output json \
  | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const keys=JSON.parse(s);
  const anon=keys.find(k=>k.name==='anon'||k.name==='publishable');
  process.stdout.write(anon ? anon.api_key : '');
});")"

if [ -z "$ANON_KEY" ]; then
  echo "!! Could not read the anon key automatically." >&2
  echo "   Copy it from Dashboard > Project Settings > API into" >&2
  echo "   public/assets/config.js as supabaseAnonKey." >&2
else
  node -e "
const fs=require('fs');
const file='public/assets/config.js';
let src=fs.readFileSync(file,'utf8');
src=src.replace(/apiBase:\s*\"[^\"]*\"/, 'apiBase: \"https://$PROJECT_REF.supabase.co/functions/v1\"');
src=src.replace(/supabaseAnonKey:\s*\"[^\"]*\"/, 'supabaseAnonKey: \"$ANON_KEY\"');
fs.writeFileSync(file,src);
console.log('==> public/assets/config.js pointed at $PROJECT_REF');
"
fi

# --- 6. verify --------------------------------------------------------------

BASE="https://$PROJECT_REF.supabase.co/functions/v1"
echo "==> Verifying $BASE/poll"
STATUS="$(curl -s -o /tmp/kpolls-poll.json -w '%{http_code}' "$BASE/poll" \
  -H "apikey: $ANON_KEY" -H "Origin: https://kpolls.me" || true)"

if [ "$STATUS" = "200" ]; then
  node -e "
const d=require('/tmp/kpolls-poll.json');
console.log('    OK -', d.options.length, 'candidates,', d.totalVotes, 'votes, token issued:', !!d.token);
"
  echo ""
  echo "Backend is live. Commit public/assets/config.js and redeploy the frontend."
else
  echo "    FAILED with HTTP $STATUS:" >&2
  cat /tmp/kpolls-poll.json >&2 || true
  echo "" >&2
  echo "    401 here means the functions still verify JWTs - redeploy with --no-verify-jwt." >&2
  exit 1
fi
