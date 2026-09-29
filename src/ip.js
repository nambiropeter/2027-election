const geoip = require("geoip-lite");
const { config } = require("./config");

function normalizeIp(ip) {
  if (!ip) {
    return "";
  }

  const cleaned = String(ip).trim();
  if (cleaned.startsWith("::ffff:")) {
    return cleaned.slice(7);
  }

  return cleaned;
}

function extractClientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (config.trustProxy && forwarded) {
    const first = String(forwarded).split(",")[0].trim();
    return normalizeIp(first);
  }

  return normalizeIp(request.ip || request.socket?.remoteAddress || "");
}

function isLocalIp(ip) {
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "localhost" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  );
}

/**
 * Collapses an address to its network block (/24 for IPv4, /64 for IPv6) so the
 * soft fan-out throttle sees a network rather than a single rotating address.
 */
function ipNetwork(ip) {
  if (!ip) {
    return "unknown";
  }

  if (ip.includes(":")) {
    return `${ip.split(":").slice(0, 4).join(":")}::/64`;
  }

  const octets = ip.split(".");
  if (octets.length !== 4) {
    return ip;
  }

  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

/**
 * Country reported by an upstream CDN, if any. Trusted only behind a proxy we
 * control, which is what TRUST_PROXY asserts.
 */
function countryFromHeaders(request) {
  if (!config.trustProxy) {
    return "";
  }

  const candidates = [
    request.headers["cf-ipcountry"],
    request.headers["x-vercel-ip-country"],
    request.headers["x-country-code"],
  ];

  for (const candidate of candidates) {
    const value = String(candidate || "").trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(value) && value !== "XX" && value !== "T1") {
      return value;
    }
  }

  return "";
}

function resolveCountry(request, ip) {
  const fromHeader = countryFromHeaders(request);
  if (fromHeader) {
    return fromHeader;
  }

  if (!ip) {
    return "--";
  }

  if (config.allowLocalhost && isLocalIp(ip)) {
    return config.allowedCountryCode;
  }

  return geoip.lookup(ip)?.country || "--";
}

/**
 * Geo decision for a request.
 *
 * "lenient" (default) blocks only addresses positively identified as foreign.
 * "strict" also blocks unknown origins - correct only when you are certain
 * every genuine request carries a resolvable address, otherwise it rejects real
 * voters whose IP the database cannot place.
 */
function checkCountry(request, ip) {
  const countryCode = resolveCountry(request, ip);

  if (config.geoEnforcement === "off") {
    return { allowed: true, countryCode, reason: "geo-check-disabled" };
  }

  if (config.allowLocalhost && isLocalIp(ip)) {
    return { allowed: true, countryCode, reason: "local-dev-ip" };
  }

  if (countryCode === config.allowedCountryCode) {
    return { allowed: true, countryCode, reason: "country-allowed" };
  }

  if (countryCode === "--") {
    const allowed = config.geoEnforcement !== "strict";
    return {
      allowed,
      countryCode,
      reason: allowed ? "country-unknown-allowed" : "country-unknown-blocked",
    };
  }

  return { allowed: false, countryCode, reason: "country-blocked" };
}

module.exports = { extractClientIp, ipNetwork, checkCountry, isLocalIp };
