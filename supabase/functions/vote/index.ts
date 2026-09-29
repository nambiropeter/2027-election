/// <reference path="../_shared/types.d.ts" />

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  browserSignature,
  corsHeaders,
  env,
  envInt,
  getClientIp,
  getCountry,
  hmacHex,
  ipNetwork,
  isOriginRejected,
  jsonResponse,
  resolveOrigin,
  TOKEN_HEADER,
  verifyToken,
} from "../_shared/utils.ts";

Deno.serve(async (request: Request) => {
  const origin = resolveOrigin(request);

  if (request.method === "OPTIONS") {
    // Same header set as the real response, so the preflight cannot disagree
    // with it (a missing allow-credentials here fails the request silently).
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (isOriginRejected(request)) {
    return jsonResponse({ error: "Origin not allowed." }, 403, null);
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405, origin);
  }

  const supabaseUrl = env("SUPABASE_URL");
  const serviceRole = env("SUPABASE_SERVICE_ROLE_KEY");
  const deviceSalt = env("DEVICE_SALT");
  const tokenSecret = env("TOKEN_SECRET", deviceSalt);

  if (!supabaseUrl || !serviceRole || deviceSalt.length < 32 || tokenSecret.length < 32) {
    return jsonResponse({ error: "Service is not configured." }, 500, origin);
  }

  const supabase = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // --- identity ------------------------------------------------------------
  // Read the token from the header, falling back to the body for clients that
  // cannot set custom headers. A missing or forged token is never upgraded into
  // a fresh identity here; only GET /poll mints tokens.
  let body: { optionId?: unknown; token?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400, origin);
  }

  const rawToken = request.headers.get(TOKEN_HEADER) ??
    (typeof body.token === "string" ? body.token : null);

  const payload = await verifyToken(rawToken, tokenSecret);
  if (!payload) {
    return jsonResponse(
      {
        error: "Your voting session is missing or expired. Reload the page and try again.",
        code: "invalid_token",
      },
      401,
      origin,
    );
  }

  const optionId = Number(body.optionId);
  if (!Number.isInteger(optionId) || optionId <= 0 || optionId > 2147483647) {
    return jsonResponse({ error: "Choose a valid option.", code: "invalid_option" }, 400, origin);
  }

  const clientIp = getClientIp(request);
  const network = ipNetwork(clientIp);
  const ipHash = await hmacHex(deviceSalt, `ip:${clientIp}`);
  const networkHash = await hmacHex(deviceSalt, `net:${network}`);
  const signature = await browserSignature(request, deviceSalt);

  // --- rate limiting -------------------------------------------------------
  // Checked before any write so a flood costs one upsert, not a vote insert.
  const perMinute = envInt("VOTE_PER_IP_PER_MINUTE", 10);
  const perHour = envInt("VOTE_PER_IP_PER_HOUR", 60);

  const { data: withinMinute, error: minuteError } = await supabase.rpc("consume_rate_limit", {
    p_key: `vote:min:${ipHash}`,
    p_limit: perMinute,
    p_window_seconds: 60,
  });

  if (minuteError) {
    return jsonResponse({ error: "Could not record your vote. Try again." }, 500, origin);
  }

  if (withinMinute === false) {
    return jsonResponse(
      { error: "Too many attempts from your connection. Wait a minute and try again.", code: "rate_limited" },
      429,
      origin,
    );
  }

  const { data: withinHour } = await supabase.rpc("consume_rate_limit", {
    p_key: `vote:hr:${ipHash}`,
    p_limit: perHour,
    p_window_seconds: 3600,
  });

  if (withinHour === false) {
    return jsonResponse(
      { error: "Too many attempts from your connection. Try again later.", code: "rate_limited" },
      429,
      origin,
    );
  }

  // --- geography -----------------------------------------------------------
  const country = getCountry(request);
  const allowedCountry = env("ALLOWED_COUNTRY_CODE", "KE").toUpperCase();
  const geoMode = env("GEO_ENFORCEMENT", "lenient").toLowerCase();

  // "lenient" (default) blocks only addresses the edge positively identified as
  // foreign. "strict" additionally blocks unknown origins, which will reject
  // genuine voters whenever the upstream proxy omits the country header.
  const geoBlocked = geoMode !== "off" &&
    (country !== allowedCountry) &&
    (country !== "--" || geoMode === "strict");

  if (geoBlocked) {
    return jsonResponse(
      {
        error: `Voting is open to ${allowedCountry} connections only.`,
        code: "geo_blocked",
        countryCode: country,
      },
      403,
      origin,
    );
  }

  // --- cast ----------------------------------------------------------------
  const deviceHash = await hmacHex(deviceSalt, `device:${payload.p}:${payload.d}`);
  const fingerprintHash = await hmacHex(deviceSalt, `fp:${payload.p}:${networkHash}:${signature}`);

  const { data: result, error: castError } = await supabase.rpc("cast_vote", {
    p_poll_id: payload.p,
    p_option_id: optionId,
    p_device_hash: deviceHash,
    p_ip_hash: ipHash,
    p_fingerprint_hash: fingerprintHash,
    p_user_agent_hash: signature,
    p_country_code: country,
    p_max_per_fingerprint: envInt("MAX_VOTES_PER_FINGERPRINT", 25),
  });

  if (castError) {
    return jsonResponse({ error: "Could not record your vote. Try again." }, 500, origin);
  }

  const status = result?.[0]?.status ?? "unknown";
  const recordedOptionId = result?.[0]?.option_id ?? null;

  if (status !== "ok") {
    const responses: Record<string, { status: number; error: string }> = {
      already_voted: { status: 409, error: "You have already voted in this poll." },
      poll_closed: { status: 410, error: "This poll is closed." },
      invalid_option: { status: 400, error: "Choose a valid option." },
      fingerprint_limit: {
        status: 429,
        error: "Unusual activity from your connection. Try again later.",
      },
    };

    const mapped = responses[status] ??
      { status: 500, error: "Could not record your vote. Try again." };

    return jsonResponse(
      {
        error: mapped.error,
        code: status,
        votedOptionId: recordedOptionId === null ? null : Number(recordedOptionId),
      },
      mapped.status,
      origin,
    );
  }

  // Return fresh totals so the client renders results without a second call.
  const { data: optionRows } = await supabase.rpc("poll_results", { p_poll_id: payload.p });
  const options = (optionRows ?? []).map((row: Record<string, unknown>) => ({
    id: Number(row.id),
    label: String(row.label),
    votes: Number(row.votes ?? 0),
  }));

  return jsonResponse(
    {
      message: "Vote recorded.",
      votedOptionId: optionId,
      countryCode: country,
      totalVotes: options.reduce((sum: number, row: { votes: number }) => sum + row.votes, 0),
      options,
    },
    201,
    origin,
  );
});
