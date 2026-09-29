/// <reference path="./types.d.ts" />

// Shared helpers for the poll + vote edge functions.
//
// The one-vote guarantee rests on a voter token: an HMAC-signed blob minted by
// GET /poll and replayed by POST /vote. The browser can read it but cannot
// forge one, so clearing localStorage only loses the receipt - it does not mint
// a second identity, because the device id inside the token is what the unique
// index in Postgres keys on.

export const TOKEN_HEADER = "x-voter-token";

export interface VoterTokenPayload {
  v: 1;
  /** poll this token was minted for */
  p: number;
  /** opaque device id - hashed with the server salt before it touches the DB */
  d: string;
  /** hash of the stable parts of the browser signature */
  u: string;
  /** issued at (epoch seconds) */
  iat: number;
  /** expires at (epoch seconds) */
  exp: number;
}

const encoder = new TextEncoder();

export function env(name: string, fallback = ""): string {
  return Deno.env.get(name) ?? fallback;
}

export function envInt(name: string, fallback: number): number {
  const parsed = Number(Deno.env.get(name));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function allowedOrigins(): string[] {
  return env("ALLOWED_ORIGINS")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Resolves the CORS origin. When ALLOWED_ORIGINS is configured, anything not on
 * the list is refused outright rather than echoed back.
 */
export function resolveOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  const allowed = allowedOrigins();

  if (!origin) {
    // Same-origin / server-to-server call: no CORS headers required.
    return null;
  }

  if (allowed.length === 0) {
    return origin;
  }

  return allowed.includes(origin) ? origin : null;
}

export function isOriginRejected(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const allowed = allowedOrigins();
  return allowed.length > 0 && !allowed.includes(origin);
}

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": `content-type,authorization,apikey,x-client-info,${TOKEN_HEADER}`,
    "access-control-expose-headers": TOKEN_HEADER,
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  origin: string | null = null,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...corsHeaders(origin),
      ...extraHeaders,
    },
  });
}

// ---------------------------------------------------------------------------
// Hashing + token signing
// ---------------------------------------------------------------------------

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function hmacHex(secret: string, input: string): Promise<string> {
  const key = await hmacKey(secret);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(input)));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function signToken(
  payload: VoterTokenPayload,
  secret: string,
): Promise<string> {
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verifies signature and expiry. crypto.subtle.verify is constant-time, so this
 * does not leak the signature through timing.
 */
export async function verifyToken(
  token: string | null,
  secret: string,
): Promise<VoterTokenPayload | null> {
  if (!token || typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const [body, signature] = parts;

  let valid = false;
  try {
    const key = await hmacKey(secret);
    valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlDecode(signature),
      encoder.encode(body),
    );
  } catch {
    return null;
  }

  if (!valid) return null;

  let payload: VoterTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
  } catch {
    return null;
  }

  if (
    !payload || payload.v !== 1 ||
    typeof payload.p !== "number" ||
    typeof payload.d !== "string" || payload.d.length < 16 ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

// ---------------------------------------------------------------------------
// Request signals
// ---------------------------------------------------------------------------

export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }
  return request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown";
}

/**
 * Collapses an address to its network block (/24 for IPv4, /64 for IPv6) so the
 * soft fan-out throttle sees a network rather than a single rotating address.
 */
export function ipNetwork(ip: string): string {
  if (ip === "unknown") return "unknown";

  if (ip.includes(":")) {
    const groups = ip.split(":");
    return groups.slice(0, 4).join(":") + "::/64";
  }

  const octets = ip.split(".");
  if (octets.length !== 4) return ip;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

/**
 * Country from the edge proxy. Returns "--" when no upstream reported one.
 */
export function getCountry(request: Request): string {
  const candidates = [
    request.headers.get("cf-ipcountry"),
    request.headers.get("x-vercel-ip-country"),
    request.headers.get("x-country-code"),
  ];

  for (const candidate of candidates) {
    const value = (candidate || "").trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(value) && value !== "XX" && value !== "T1") {
      return value;
    }
  }

  return "--";
}

/**
 * Stable parts of the browser signature. Deliberately excludes the IP: Kenyan
 * mobile users switch towers and networks constantly, and binding a token to an
 * address would log genuine voters out mid-session.
 */
export async function browserSignature(
  request: Request,
  salt: string,
): Promise<string> {
  const userAgent = request.headers.get("user-agent") || "unknown";
  const language = request.headers.get("accept-language") || "unknown";
  return hmacHex(salt, `ua:${userAgent}|lang:${language}`);
}

export function randomDeviceId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}
