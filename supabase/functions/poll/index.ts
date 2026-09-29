/// <reference path="../_shared/types.d.ts" />

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  browserSignature,
  env,
  envInt,
  getCountry,
  hmacHex,
  isOriginRejected,
  jsonResponse,
  randomDeviceId,
  resolveOrigin,
  signToken,
  TOKEN_HEADER,
  verifyToken,
  type VoterTokenPayload,
} from "../_shared/utils.ts";

Deno.serve(async (request: Request) => {
  const origin = resolveOrigin(request);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...(origin
          ? {
            "access-control-allow-origin": origin,
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "access-control-allow-headers":
              `content-type,authorization,apikey,x-client-info,${TOKEN_HEADER}`,
            "access-control-max-age": "86400",
            "vary": "Origin",
          }
          : {}),
      },
    });
  }

  if (isOriginRejected(request)) {
    return jsonResponse({ error: "Origin not allowed." }, 403, null);
  }

  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed." }, 405, origin);
  }

  const supabaseUrl = env("SUPABASE_URL");
  const serviceRole = env("SUPABASE_SERVICE_ROLE_KEY");
  const deviceSalt = env("DEVICE_SALT");
  const tokenSecret = env("TOKEN_SECRET", deviceSalt);

  if (!supabaseUrl || !serviceRole) {
    return jsonResponse({ error: "Service is not configured." }, 500, origin);
  }

  if (deviceSalt.length < 32 || tokenSecret.length < 32) {
    // Refuse to mint weakly-signed tokens rather than issue forgeable ones.
    return jsonResponse(
      { error: "Service is not configured: DEVICE_SALT/TOKEN_SECRET too short." },
      500,
      origin,
    );
  }

  const supabase = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: pollRows, error: pollError } = await supabase
    .from("polls")
    .select("id,question,is_active")
    .eq("is_active", true)
    .order("id", { ascending: false })
    .limit(1);

  if (pollError) {
    return jsonResponse({ error: "Failed to load poll." }, 500, origin);
  }

  const poll = pollRows?.[0];
  if (!poll) {
    return jsonResponse({ error: "No active poll configured." }, 404, origin);
  }

  const { data: optionRows, error: optionError } = await supabase.rpc("poll_results", {
    p_poll_id: poll.id,
  });

  if (optionError) {
    return jsonResponse({ error: "Failed to load options." }, 500, origin);
  }

  const options = (optionRows ?? []).map((row: Record<string, unknown>) => ({
    id: Number(row.id),
    label: String(row.label),
    votes: Number(row.votes ?? 0),
  }));

  const totalVotes = options.reduce(
    (sum: number, row: { votes: number }) => sum + row.votes,
    0,
  );

  // --- voter token ---------------------------------------------------------
  const signature = await browserSignature(request, deviceSalt);
  const ttlSeconds = envInt("TOKEN_TTL_HOURS", 24 * 365) * 3600;
  const now = Math.floor(Date.now() / 1000);

  const presented = await verifyToken(request.headers.get(TOKEN_HEADER), tokenSecret);
  let payload: VoterTokenPayload;

  if (presented && presented.p === poll.id) {
    payload = presented;
  } else {
    payload = {
      v: 1,
      p: poll.id,
      d: randomDeviceId(),
      u: signature,
      iat: now,
      exp: now + ttlSeconds,
    };
  }

  const token = await signToken(payload, tokenSecret);
  const deviceHash = await hmacHex(deviceSalt, `device:${poll.id}:${payload.d}`);

  const { data: votedOption } = await supabase.rpc("has_voted", {
    p_poll_id: poll.id,
    p_device_hash: deviceHash,
  });

  const votedOptionId = votedOption === null || votedOption === undefined
    ? null
    : Number(votedOption);

  const country = getCountry(request);
  const allowedCountry = env("ALLOWED_COUNTRY_CODE", "KE").toUpperCase();
  const geoMode = env("GEO_ENFORCEMENT", "lenient").toLowerCase();
  const countryAllowed = geoMode === "off" ||
    country === allowedCountry ||
    (country === "--" && geoMode !== "strict");

  return jsonResponse(
    {
      pollId: poll.id,
      question: poll.question,
      totalVotes,
      options,
      hasVoted: votedOptionId !== null,
      votedOptionId,
      country,
      countryAllowed,
      token,
    },
    200,
    origin,
    { [TOKEN_HEADER]: token },
  );
});
