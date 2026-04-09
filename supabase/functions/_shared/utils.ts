/// <reference path="./types.d.ts" />

export function jsonResponse(body: unknown, status = 200, origin = "*") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-client-info,apikey",
      "access-control-max-age": "86400",
    },
  });
}

export function getAllowedOrigin(request: Request) {
  const origin = request.headers.get("origin") || "";
  const rawAllowed = Deno.env.get("ALLOWED_ORIGINS") || "";
  const allowed = rawAllowed
    .split(",")
    .map((item: string) => item.trim())
    .filter(Boolean);

  if (!origin) {
    return "*";
  }

  if (allowed.length === 0) {
    return origin;
  }

  return allowed.includes(origin) ? origin : "null";
}

export async function sha256Hex(input: string) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
