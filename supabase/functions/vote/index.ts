/// <reference path="../_shared/types.d.ts" />

import { createClient } from "jsr:@supabase/supabase-js@2";
import { getAllowedOrigin, jsonResponse, sha256Hex } from "../_shared/utils.ts";

const COUNTRY = "KE";

Deno.serve(async (request: Request) => {
  const origin = getAllowedOrigin(request);

  if (request.method === "OPTIONS") {
    return jsonResponse({ ok: true }, 200, origin);
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const deviceSalt = Deno.env.get("DEVICE_SALT") || "";

  if (!supabaseUrl || !serviceRole || deviceSalt.length < 16) {
    return jsonResponse({ error: "Missing Supabase function environment" }, 500, origin);
  }

  const supabase = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: { optionId?: number; deviceId?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, origin);
  }

  const optionId = Number(body.optionId);
  const deviceId = String(body.deviceId || "").trim();

  if (!Number.isInteger(optionId) || optionId <= 0) {
    return jsonResponse({ error: "Invalid vote option" }, 400, origin);
  }

  if (!deviceId || deviceId.length < 12 || deviceId.length > 128) {
    return jsonResponse({ error: "Missing or invalid device ID" }, 400, origin);
  }

  const forwarded = request.headers.get("x-forwarded-for") || "unknown";
  const clientIp = forwarded.split(",")[0].trim() || "unknown";

  const { data: pollRows } = await supabase
    .from("polls")
    .select("id")
    .eq("is_active", true)
    .order("id", { ascending: false })
    .limit(1);

  const poll = pollRows?.[0];
  if (!poll) {
    return jsonResponse({ error: "No active poll available" }, 500, origin);
  }

  const { data: optionRows } = await supabase
    .from("poll_options")
    .select("id")
    .eq("poll_id", poll.id)
    .eq("id", optionId)
    .limit(1);

  if (!optionRows || optionRows.length === 0) {
    return jsonResponse({ error: "Invalid vote option" }, 400, origin);
  }

  const deviceHash = await sha256Hex(`device:${deviceSalt}:${deviceId}`);
  const ipHash = await sha256Hex(`ip:${deviceSalt}:${clientIp}`);

  const { error: insertError } = await supabase.from("votes").insert({
    poll_id: poll.id,
    option_id: optionId,
    device_hash: deviceHash,
    ip_hash: ipHash,
    country_code: COUNTRY,
  });

  if (insertError) {
    if (insertError.message.toLowerCase().includes("unique")) {
      return jsonResponse({ error: "This device has already voted in this poll." }, 409, origin);
    }
    return jsonResponse({ error: "Failed to record vote" }, 500, origin);
  }

  return jsonResponse({ message: "Vote recorded successfully.", countryCode: COUNTRY }, 201, origin);
});
