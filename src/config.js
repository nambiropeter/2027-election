const dotenv = require("dotenv");

dotenv.config();

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";

function getBoolean(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined) {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function getNumber(name, defaultValue) {
  const rawValue = process.env[name];
  if (rawValue === undefined) {
    return defaultValue;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return parsed;
}

function parseAllowedOrigins(rawValue) {
  if (!rawValue) {
    return isProduction ? [] : ["http://localhost:3000"];
  }

  return rawValue
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isLikelyWeakSecret(secret) {
  const normalized = String(secret || "").toLowerCase();
  return (
    normalized.length < 32 ||
    normalized.includes("replace-this") ||
    normalized.includes("changeme") ||
    normalized.includes("default")
  );
}

function getSessionCookieSameSite() {
  const rawValue = String(process.env.SESSION_COOKIE_SAME_SITE || "").trim().toLowerCase();
  if (rawValue === "lax" || rawValue === "strict" || rawValue === "none") {
    return rawValue;
  }
  return isProduction ? "strict" : "lax";
}

const config = {
  nodeEnv,
  isProduction,
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || (isProduction ? "" : "postgres://postgres:postgres@localhost:5432/election_poll"),
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  redisPassword: process.env.REDIS_PASSWORD || "",
  redisTls: getBoolean("REDIS_TLS", false),
  deviceSalt: process.env.DEVICE_SALT || "",
  sessionSecret: process.env.SESSION_SECRET || process.env.DEVICE_SALT || "",
  sessionCookieName: process.env.SESSION_COOKIE_NAME || "poll_session",
  sessionTtlHours: getNumber("SESSION_TTL_HOURS", 24 * 30),
  sessionCookieSecure: getBoolean("SESSION_COOKIE_SECURE", isProduction),
  sessionCookieSameSite: getSessionCookieSameSite(),
  trustProxy: getBoolean("TRUST_PROXY", false),
  bypassGeoCheck: getBoolean("BYPASS_GEO_CHECK", false),
  allowLocalhost: getBoolean("ALLOW_LOCALHOST", !isProduction),
  allowedCountryCode: (process.env.ALLOWED_COUNTRY_CODE || "KE").toUpperCase(),
  allowedOrigins: parseAllowedOrigins(process.env.ALLOWED_ORIGINS),
  votePerIpPerMinute: getNumber("VOTE_PER_IP_PER_MINUTE", 20),
  votePerIpPerHour: getNumber("VOTE_PER_IP_PER_HOUR", 200),
  anomalyBlockedGeoThresholdPerMinute: getNumber("ANOMALY_BLOCKED_GEO_THRESHOLD_PER_MINUTE", 30),
  anomalyUniqueDevicesPerIpPerMinute: getNumber("ANOMALY_UNIQUE_DEVICES_PER_IP_PER_MINUTE", 60),
  anomalyAlertCooldownSeconds: getNumber("ANOMALY_ALERT_COOLDOWN_SECONDS", 300),
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || "",
};

function validateConfig(currentConfig) {
  if (!/^[A-Z]{2}$/.test(currentConfig.allowedCountryCode)) {
    throw new Error("ALLOWED_COUNTRY_CODE must be a 2-letter country code (for example: KE)");
  }

  if (currentConfig.sessionCookieSameSite === "none" && !currentConfig.sessionCookieSecure) {
    throw new Error("SESSION_COOKIE_SAME_SITE=none requires SESSION_COOKIE_SECURE=true");
  }

  if (!currentConfig.isProduction) {
    return;
  }

  if (!currentConfig.databaseUrl) {
    throw new Error("DATABASE_URL is required in production");
  }

  if (!currentConfig.redisUrl) {
    throw new Error("REDIS_URL is required in production");
  }

  if (isLikelyWeakSecret(currentConfig.deviceSalt)) {
    throw new Error("DEVICE_SALT is missing or too weak for production");
  }

  if (isLikelyWeakSecret(currentConfig.sessionSecret)) {
    throw new Error("SESSION_SECRET is missing or too weak for production");
  }

  if (!currentConfig.sessionCookieSecure) {
    throw new Error("SESSION_COOKIE_SECURE must be true in production");
  }

  if (currentConfig.allowLocalhost) {
    throw new Error("ALLOW_LOCALHOST must be false in production");
  }

  if (currentConfig.bypassGeoCheck) {
    throw new Error("BYPASS_GEO_CHECK must be false in production");
  }

  if (currentConfig.allowedOrigins.length === 0) {
    throw new Error("ALLOWED_ORIGINS must be set in production");
  }
}

validateConfig(config);

module.exports = { config };
