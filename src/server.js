const fs = require("fs");
const path = require("path");

const Fastify = require("fastify");
const cors = require("@fastify/cors");
const cookie = require("@fastify/cookie");
const helmet = require("@fastify/helmet");
const fastifyStatic = require("@fastify/static");

const { config } = require("./config");
const { query, closePool } = require("./db");
const { redis } = require("./redis");
const { extractClientIp, ipNetwork, checkCountry } = require("./ip");
const {
  TOKEN_HEADER,
  createToken,
  verifyToken,
  randomDeviceId,
  hmacHex,
} = require("./token");

const server = Fastify({
  logger: true,
  trustProxy: config.trustProxy,
  bodyLimit: 1024 * 20,
  keepAliveTimeout: 72000,
  requestTimeout: 10000,
});

const PUBLIC_DIR = path.join(__dirname, "..", "public");

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function getTokenTtlSeconds() {
  return Math.max(60, Math.floor(config.tokenTtlHours * 60 * 60));
}

/**
 * Stable parts of the browser signature. Excludes the IP on purpose: Kenyan
 * mobile users move between towers and networks constantly, and binding the
 * token to an address would invalidate it mid-session.
 */
function browserSignature(request) {
  const userAgent = request.headers["user-agent"] || "unknown";
  const language = request.headers["accept-language"] || "unknown";
  return hmacHex(config.deviceSalt, `ua:${userAgent}|lang:${language}`);
}

function readToken(request) {
  const fromHeader = request.headers[TOKEN_HEADER];
  if (typeof fromHeader === "string" && fromHeader) {
    return fromHeader;
  }

  const fromCookie = request.cookies?.[config.sessionCookieName];
  return typeof fromCookie === "string" && fromCookie ? fromCookie : null;
}

function setTokenCookie(reply, token) {
  reply.setCookie(config.sessionCookieName, token, {
    path: "/",
    httpOnly: true,
    sameSite: config.sessionCookieSameSite,
    secure: config.sessionCookieSecure,
    maxAge: getTokenTtlSeconds(),
  });
}

function deviceHashFor(payload) {
  return hmacHex(config.deviceSalt, `device:${payload.p}:${payload.d}`);
}

/**
 * Returns the caller's existing token when they present a valid one for this
 * poll, otherwise mints a fresh identity. Only this path creates identities -
 * POST /api/vote never does, so a forged token cannot become a new voter.
 */
function resolveVoterToken(request, reply, pollId) {
  const presented = verifyToken(readToken(request), config.sessionSecret);

  let payload = presented && presented.p === pollId ? presented : null;

  if (!payload) {
    const now = Math.floor(Date.now() / 1000);
    payload = {
      v: 1,
      p: pollId,
      d: randomDeviceId(),
      u: browserSignature(request),
      iat: now,
      exp: now + getTokenTtlSeconds(),
    };
  }

  const token = createToken(payload, config.sessionSecret);
  setTokenCookie(reply, token);
  reply.header(TOKEN_HEADER, token);

  return { payload, token };
}

// ---------------------------------------------------------------------------
// Rate limiting: Redis when it is reachable, Postgres otherwise.
// ---------------------------------------------------------------------------

async function consumeLimitViaRedis(key, limit, windowSeconds) {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  return count <= limit;
}

async function consumeLimit(key, limit, windowSeconds) {
  try {
    return await consumeLimitViaRedis(key, limit, windowSeconds);
  } catch (error) {
    server.log.warn({ err: error }, "Redis rate limit unavailable; falling back to Postgres");
    const result = await query(
      `SELECT consume_rate_limit($1, $2, $3) AS allowed`,
      [key, limit, windowSeconds]
    );
    return result.rows[0]?.allowed !== false;
  }
}

async function sendAlert(eventType, details) {
  server.log.warn({ eventType, ...details }, "Poll abuse/anomaly alert");

  if (!config.alertWebhookUrl) {
    return;
  }

  try {
    await fetch(config.alertWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service: "election-poll",
        eventType,
        timestamp: new Date().toISOString(),
        details,
      }),
    });
  } catch (error) {
    server.log.error({ err: error }, "Failed to send alert webhook");
  }
}

async function sendAlertWithCooldown(cooldownKey, eventType, details) {
  try {
    const shouldSend = await redis.set(
      `alert-cooldown:${cooldownKey}`,
      "1",
      "NX",
      "EX",
      config.anomalyAlertCooldownSeconds
    );

    if (shouldSend !== "OK") {
      return;
    }
  } catch (_) {
    // Redis down: still surface the alert rather than swallowing it.
  }

  await sendAlert(eventType, details);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

async function ensureSchema() {
  const files = [path.join(__dirname, "..", "sql", "schema.sql")];

  const migrationsDir = path.join(__dirname, "..", "supabase", "migrations");
  if (fs.existsSync(migrationsDir)) {
    for (const name of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      files.push(path.join(migrationsDir, name));
    }
  }

  for (const file of files) {
    await query(fs.readFileSync(file, "utf8"));
  }
}

async function loadActivePoll() {
  const result = await query(
    `SELECT id, question FROM polls WHERE is_active = TRUE ORDER BY id DESC LIMIT 1`
  );
  return result.rows[0] || null;
}

async function loadResults(pollId) {
  const result = await query(
    `SELECT id, label, votes FROM poll_results($1)`,
    [pollId]
  );

  const options = result.rows.map((row) => ({
    id: Number(row.id),
    label: row.label,
    votes: Number(row.votes),
  }));

  return {
    options,
    totalVotes: options.reduce((sum, row) => sum + row.votes, 0),
  };
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

server.register(cors, {
  credentials: true,
  // The token also travels in a custom header for cross-origin deployments.
  allowedHeaders: ["content-type", TOKEN_HEADER],
  exposedHeaders: [TOKEN_HEADER],
  // Decline by withholding the CORS headers rather than raising, which
  // @fastify/cors turns into a 500. Declining this way leaves same-origin
  // requests working even when ALLOWED_ORIGINS is wrong or unset, while the
  // browser still blocks a cross-origin caller from reading the response.
  origin(origin, callback) {
    callback(null, !origin || config.allowedOrigins.includes(origin));
  },
});

server.register(cookie);

server.register(helmet, {
  global: true,
  crossOriginEmbedderPolicy: false,
  // Scripts and styles live in their own files, so no 'unsafe-inline' is
  // needed for our own code. Google's ad tags are the only remote origins.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      scriptSrc: [
        "'self'",
        "https://pagead2.googlesyndication.com",
        "https://googleads.g.doubleclick.net",
        "https://tpc.googlesyndication.com",
      ],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://*.supabase.co"],
      frameSrc: ["https://googleads.g.doubleclick.net", "https://tpc.googlesyndication.com"],
      upgradeInsecureRequests: config.isProduction ? [] : null,
    },
  },
  hsts: config.isProduction
    ? { maxAge: 31536000, includeSubDomains: true, preload: true }
    : false,
});

server.register(fastifyStatic, {
  root: PUBLIC_DIR,
  index: ["index.html"],
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

server.get("/health", async () => ({ status: "ok" }));

server.get("/api/poll", async (request, reply) => {
  const poll = await loadActivePoll();
  if (!poll) {
    return reply.code(404).send({ error: "No active poll configured." });
  }

  const { payload, token } = resolveVoterToken(request, reply, poll.id);
  const { options, totalVotes } = await loadResults(poll.id);

  const votedResult = await query(`SELECT has_voted($1, $2) AS option_id`, [
    poll.id,
    deviceHashFor(payload),
  ]);

  const votedOptionId = votedResult.rows[0]?.option_id ?? null;
  const clientIp = extractClientIp(request);
  const geo = checkCountry(request, clientIp);

  reply.header("cache-control", "no-store");

  return {
    pollId: poll.id,
    question: poll.question,
    totalVotes,
    options,
    hasVoted: votedOptionId !== null,
    votedOptionId: votedOptionId === null ? null : Number(votedOptionId),
    country: geo.countryCode,
    countryAllowed: geo.allowed,
    token,
  };
});

// Tally only - no token work, safe to poll on a timer.
server.get("/api/results", async (request, reply) => {
  const poll = await loadActivePoll();
  if (!poll) {
    return reply.code(404).send({ error: "No active poll configured." });
  }

  reply.header("cache-control", "no-store");
  const { options, totalVotes } = await loadResults(poll.id);
  return { pollId: poll.id, totalVotes, options };
});

server.post("/api/vote", async (request, reply) => {
  const poll = await loadActivePoll();
  if (!poll) {
    return reply.code(404).send({ error: "No active poll configured." });
  }

  const payload = verifyToken(readToken(request), config.sessionSecret);
  if (!payload || payload.p !== poll.id) {
    return reply.code(401).send({
      error: "Your voting session is missing or expired. Reload the page and try again.",
      code: "invalid_token",
    });
  }

  const { optionId } = request.body || {};
  if (!Number.isInteger(optionId) || optionId <= 0 || optionId > 2147483647) {
    return reply.code(400).send({ error: "Choose a valid option.", code: "invalid_option" });
  }

  const clientIp = extractClientIp(request);
  const ipHash = hmacHex(config.deviceSalt, `ip:${clientIp || "unknown"}`);
  const networkHash = hmacHex(config.deviceSalt, `net:${ipNetwork(clientIp)}`);
  const signature = browserSignature(request);

  const withinMinute = await consumeLimit(
    `rl:vote:min:${ipHash}`,
    config.votePerIpPerMinute,
    60
  );

  if (!withinMinute) {
    await sendAlertWithCooldown(`rate-limit:${ipHash}`, "ip_rate_limit_exceeded", {
      ipHash,
      limit: config.votePerIpPerMinute,
      window: "1 minute",
    });

    return reply.code(429).send({
      error: "Too many attempts from your connection. Wait a minute and try again.",
      code: "rate_limited",
    });
  }

  const withinHour = await consumeLimit(
    `rl:vote:hr:${ipHash}`,
    config.votePerIpPerHour,
    3600
  );

  if (!withinHour) {
    return reply.code(429).send({
      error: "Too many attempts from your connection. Try again later.",
      code: "rate_limited",
    });
  }

  const geo = checkCountry(request, clientIp);
  if (!geo.allowed) {
    await sendAlertWithCooldown(`blocked-country:${ipHash}`, "blocked_geo", {
      ipHash,
      reason: geo.reason,
      countryCode: geo.countryCode,
    });

    return reply.code(403).send({
      error: `Voting is open to ${config.allowedCountryCode} connections only.`,
      code: "geo_blocked",
      countryCode: geo.countryCode,
    });
  }

  const deviceHash = deviceHashFor(payload);
  const fingerprintHash = hmacHex(
    config.deviceSalt,
    `fp:${payload.p}:${networkHash}:${signature}`
  );

  // Every integrity check and the insert happen inside one database call, so
  // two concurrent requests for the same device cannot both pass the checks.
  const castResult = await query(
    `SELECT status, option_id FROM cast_vote($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      poll.id,
      optionId,
      deviceHash,
      ipHash,
      fingerprintHash,
      signature,
      geo.countryCode,
      config.maxVotesPerFingerprint,
    ]
  );

  const status = castResult.rows[0]?.status || "unknown";
  const recordedOptionId = castResult.rows[0]?.option_id ?? null;

  if (status !== "ok") {
    const responses = {
      already_voted: { code: 409, error: "You have already voted in this poll." },
      poll_closed: { code: 410, error: "This poll is closed." },
      invalid_option: { code: 400, error: "Choose a valid option." },
      fingerprint_limit: {
        code: 429,
        error: "Unusual activity from your connection. Try again later.",
      },
    };

    const mapped = responses[status] || {
      code: 500,
      error: "Could not record your vote. Try again.",
    };

    if (status === "fingerprint_limit") {
      await sendAlertWithCooldown(`fingerprint:${fingerprintHash}`, "fingerprint_fanout", {
        ipHash,
        limit: config.maxVotesPerFingerprint,
      });
    }

    return reply.code(mapped.code).send({
      error: mapped.error,
      code: status,
      votedOptionId: recordedOptionId === null ? null : Number(recordedOptionId),
    });
  }

  const { options, totalVotes } = await loadResults(poll.id);

  return reply.code(201).send({
    message: "Vote recorded.",
    votedOptionId: optionId,
    countryCode: geo.countryCode,
    totalVotes,
    options,
  });
});

// Single-page fallback: serve index.html for unknown non-API GETs so deep
// links do not 404. @fastify/static already owns "/" - registering it again
// here would throw a duplicate-route error at boot.
server.setNotFoundHandler((request, reply) => {
  if (request.method === "GET" && !request.url.startsWith("/api/")) {
    return reply.type("text/html").sendFile("index.html");
  }

  return reply.code(404).send({ error: "Not found." });
});

async function start() {
  await ensureSchema();

  await server.listen({ port: config.port, host: "0.0.0.0" });
  server.log.info(`Server running on port ${config.port}`);
}

async function shutdown() {
  try {
    await server.close();
  } catch (_) {
    // Ignore close errors during shutdown.
  }

  try {
    await closePool();
  } catch (_) {
    // Ignore pool teardown errors.
  }

  redis.disconnect();
}

if (require.main === module) {
  start().catch(async (error) => {
    server.log.error(error);
    try {
      await shutdown();
    } catch (_) {
      // Ignore shutdown cleanup errors.
    }
    process.exit(1);
  });

  process.on("SIGINT", async () => {
    await shutdown();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await shutdown();
    process.exit(0);
  });
}

module.exports = { server, ensureSchema, start, shutdown };
