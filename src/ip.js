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

function checkKenyaIp(ip) {
  if (config.bypassGeoCheck) {
    return { allowed: true, countryCode: config.allowedCountryCode, reason: "geo-check-bypassed" };
  }

  if (!ip) {
    return { allowed: false, countryCode: "--", reason: "ip-missing" };
  }

  if (config.allowLocalhost && isLocalIp(ip)) {
    return { allowed: true, countryCode: config.allowedCountryCode, reason: "local-dev-ip" };
  }

  const geo = geoip.lookup(ip);
  const countryCode = geo?.country || "--";
  const allowed = countryCode === config.allowedCountryCode;

  return {
    allowed,
    countryCode,
    reason: allowed ? "country-allowed" : "country-blocked",
  };
}

module.exports = { extractClientIp, checkKenyaIp };
