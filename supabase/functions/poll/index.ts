/// <reference path="../_shared/types.d.ts" />

import { createClient } from "jsr:@supabase/supabase-js@2";
import { getAllowedOrigin, jsonResponse } from "../_shared/utils.ts";

Deno.serve(async (request: Request) => {
  const origin = getAllowedOrigin(request);

  if (request.method === "OPTIONS") {
    return jsonResponse({ ok: true }, 200, origin);
  }

  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRole) {
    return jsonResponse({ error: "Missing Supabase function environment" }, 500, origin);
  }

  const supabase = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: pollRows, error: pollError } = await supabase
    .from("polls")
    .select("id,question")
    .eq("is_active", true)
    .order("id", { ascending: false })
    .limit(1);

  if (pollError) {
    return jsonResponse({ error: "Failed to load poll", detail: pollError.message }, 500, origin);
  }

  const poll = pollRows?.[0];
  if (!poll) {
    return jsonResponse({ error: "No active poll configured" }, 404, origin);
  }

  const { data: optionRows, error: optionError } = await supabase.rpc("poll_option_totals", {
    p_poll_id: poll.id,
  });

  if (optionError) {
    return jsonResponse({ error: "Failed to load options", detail: optionError.message }, 500, origin);
  }

  const options = optionRows || [];
  const totalVotes = options.reduce((sum: number, row: { votes: number }) => sum + Number(row.votes || 0), 0);

  return jsonResponse(
    {
      pollId: poll.id,
      question: poll.question,
      totalVotes,
      options,
    },
    200,
    origin,
  );
});
