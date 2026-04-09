const path = require("path");
const crypto = require("crypto");

const Fastify = require("fastify");
const cors = require("@fastify/cors");
const cookie = require("@fastify/cookie");
const helmet = require("@fastify/helmet");
const fastifyStatic = require("@fastify/static");

const { config } = require("./config");
const { query, withTransaction, closePool } = require("./db");
const { redis } = require("./redis");
const { extractClientIp, checkKenyaIp } = require("./ip");

const server = Fastify({
  logger: true,
  trustProxy: config.trustProxy,
  bodyLimit: 1024 * 20,
  keepAliveTimeout: 72000,
  requestTimeout: 10000,
});

function hashValue(raw) {
  return crypto
    .createHash("sha256")
    .update(`${config.deviceSalt}:${raw}`)
    .digest("hex");
}

function getSessionTtlSeconds() {
  return Math.max(1, Math.floor(config.sessionTtlHours * 60 * 60));
}

function signSessionBody(encodedBody) {
  return crypto
    .createHmac("sha256", config.sessionSecret)
    .update(encodedBody)
    .digest("base64url");
}

function getRequestFingerprintHash(request, clientIp) {
  const userAgent = String(request.headers["user-agent"] || "unknown");
  return hashValue(`fp:${clientIp || "unknown"}:${userAgent}`);
}

function createSessionToken({ pollId, fingerprintHash }) {
  const payload = {
    v: 1,
    pollId,
    f: fingerprintHash,
    jti: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + getSessionTtlSeconds(),
  };

  const encodedBody = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signSessionBody(encodedBody);
  return `${encodedBody}.${signature}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }

  const [encodedBody, signature] = parts;
  const expectedSignature = signSessionBody(encodedBody);

  if (signature.length !== expectedSignature.length) {
    return null;
  }

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedBody, "base64url").toString("utf8"));
  } catch (_) {
    return null;
  }

  if (!payload || payload.v !== 1 || !payload.jti || !payload.exp || !payload.pollId || !payload.f) {
    return null;
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}

function setVoteSessionCookie(reply, token) {
  reply.setCookie(config.sessionCookieName, token, {
    path: "/",
    httpOnly: true,
    sameSite: config.sessionCookieSameSite,
    secure: config.sessionCookieSecure,
    maxAge: getSessionTtlSeconds(),
  });
}

function isAllowedCorsOrigin(origin) {
  if (!origin) {
    return true;
  }

  return config.allowedOrigins.includes(origin);
}

async function resolveVoteSession(request, reply, pollId, clientIp, allowIssue) {
  const fingerprintHash = getRequestFingerprintHash(request, clientIp);
  const tokenFromCookie = request.cookies?.[config.sessionCookieName];
  const cookiePayload = verifySessionToken(tokenFromCookie);

  if (cookiePayload && cookiePayload.pollId === pollId && cookiePayload.f === fingerprintHash) {
    return cookiePayload;
  }

  const redisKey = `vote-session:${pollId}:${fingerprintHash}`;
  const storedToken = await redis.get(redisKey);
  const storedPayload = verifySessionToken(storedToken);

  if (storedPayload && storedPayload.pollId === pollId && storedPayload.f === fingerprintHash) {
    setVoteSessionCookie(reply, storedToken);
    return storedPayload;
  }

  if (!allowIssue) {
    return null;
  }

  const newToken = createSessionToken({ pollId, fingerprintHash });
  const newPayload = verifySessionToken(newToken);

  await redis.set(redisKey, newToken, "EX", getSessionTtlSeconds());
  setVoteSessionCookie(reply, newToken);

  return newPayload;
}

async function incrementWithExpiry(key, expiresInSeconds) {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, expiresInSeconds);
  }
  return count;
}

async function sendAlert(eventType, details) {
  server.log.warn({ eventType, ...details }, "Poll abuse/anomaly alert");

  if (!config.alertWebhookUrl) {
    return;
  }

  try {
    await fetch(config.alertWebhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
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
  const key = `alert-cooldown:${cooldownKey}`;
  const shouldSend = await redis.set(
    key,
    "1",
    "NX",
    "EX",
    config.anomalyAlertCooldownSeconds
  );

  if (shouldSend === "OK") {
    await sendAlert(eventType, details);
  }
}

async function enforceVoteRateLimit(ipHash) {
  const minuteCount = await incrementWithExpiry(`rl:votes:ip:${ipHash}:1m`, 60);
  if (minuteCount > config.votePerIpPerMinute) {
    return {
      allowed: false,
      count: minuteCount,
      limit: config.votePerIpPerMinute,
      window: "1 minute",
    };
  }

  const hourCount = await incrementWithExpiry(`rl:votes:ip:${ipHash}:1h`, 60 * 60);
  if (hourCount > config.votePerIpPerHour) {
    return {
      allowed: false,
      count: hourCount,
      limit: config.votePerIpPerHour,
      window: "1 hour",
    };
  }

  return { allowed: true };
}

async function trackUniqueDevicesForIp(ipHash, deviceHash) {
  const minuteBucket = Math.floor(Date.now() / 60000);
  const key = `anom:unique-devices:${ipHash}:${minuteBucket}`;
  await redis.sadd(key, deviceHash);
  await redis.expire(key, 120);
  return redis.scard(key);
}

async function ensureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS polls (
      id SERIAL PRIMARY KEY,
      question TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS poll_options (
      id SERIAL PRIMARY KEY,
      poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS votes (
      id BIGSERIAL PRIMARY KEY,
      poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
      device_hash CHAR(64) NOT NULL,
      ip_hash CHAR(64) NOT NULL,
      ip_address INET,
      country_code CHAR(2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (poll_id, device_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_votes_poll_id ON votes (poll_id);
    CREATE INDEX IF NOT EXISTS idx_votes_option_id ON votes (option_id);
  `);

  await query(`
    INSERT INTO polls (question, is_active)
    SELECT 'With Chief Justice (Rtd) David Maraga joining the race, which candidate do you believe has the right vision to lead Kenya in 2027?', TRUE
    WHERE NOT EXISTS (SELECT 1 FROM polls WHERE is_active = TRUE);
  `);

  const activePoll = await query(
    `SELECT id FROM polls WHERE is_active = TRUE ORDER BY id DESC LIMIT 1`
  );

  const pollId = activePoll.rows[0]?.id;
  if (!pollId) {
    throw new Error("Unable to locate active poll after initialization");
  }

  await query(
    `
      INSERT INTO poll_options (poll_id, label, sort_order)
      SELECT $1, v.label, v.sort_order
      FROM (VALUES
        ('William Ruto - UDA (Kenya Kwanza): The Incumbent; Bottom-Up Transformation.', 1),
        ('Kalonzo Musyoka - Wiper (Azimio): The Diplomat; focus on stability and unity.', 2),
        ('David Maraga - United Green Movement: The Jurist; focus on integrity and the rule of law.', 3),
        ('Fred Matiang''i - Jubilee Party: The Reformer; focus on efficient service delivery.', 4),
        ('Okiya Omtatah - NRA: The Defender; focus on constitutionalism and the common man.', 5),
        ('Rigathi Gachagua - TBD: The Regional Voice; strong focus on Mt. Kenya interests.', 6),
        ('Undecided - Still weighing the impact of these new entries.', 7)
      ) AS v(label, sort_order)
      WHERE NOT EXISTS (SELECT 1 FROM poll_options WHERE poll_id = $1)
    `,
    [pollId]
  );
}

server.register(cors, {
  credentials: true,
  origin(origin, callback) {
    if (isAllowedCorsOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error("Origin is not allowed by CORS"), false);
  },
});
server.register(cookie);
server.register(helmet, {
  global: true,
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  hsts: config.isProduction
    ? {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      }
    : false,
});
server.register(fastifyStatic, {
  root: path.join(__dirname, "..", "public"),
});

server.get("/health", async () => ({ status: "ok" }));

server.get("/api/poll", async (request, reply) => {
  const clientIp = extractClientIp(request);

  const pollResult = await query(
    `SELECT id, question FROM polls WHERE is_active = TRUE ORDER BY id DESC LIMIT 1`
  );

  const poll = pollResult.rows[0];
  if (!poll) {
    return { error: "No active poll configured" };
  }

  const optionResult = await query(
    `
    SELECT
      o.id,
      o.label,
      o.sort_order,
      COUNT(v.id)::INTEGER AS votes
    FROM poll_options o
    LEFT JOIN votes v ON v.option_id = o.id
    WHERE o.poll_id = $1
    GROUP BY o.id, o.label, o.sort_order
    ORDER BY o.sort_order ASC
  `,
    [poll.id]
  );

  const totalVotes = optionResult.rows.reduce((sum, row) => sum + row.votes, 0);

  await resolveVoteSession(request, reply, poll.id, clientIp, true);

  return {
    pollId: poll.id,
    question: poll.question,
    totalVotes,
    options: optionResult.rows,
  };
});

server.post("/api/vote", async (request, reply) => {
  const clientIp = extractClientIp(request);
  const ipHash = hashValue(clientIp || "unknown");

  const pollResult = await query(
    `SELECT id FROM polls WHERE is_active = TRUE ORDER BY id DESC LIMIT 1`
  );

  const activePoll = pollResult.rows[0];
  if (!activePoll) {
    return reply.code(500).send({ error: "No active poll available." });
  }

  const voteSession = await resolveVoteSession(request, reply, activePoll.id, clientIp, false);
  if (!voteSession) {
    return reply.code(401).send({
      error: "Missing or invalid vote session. Reload the poll page and try again.",
    });
  }

  const rateLimitResult = await enforceVoteRateLimit(ipHash);
  if (!rateLimitResult.allowed) {
    await sendAlertWithCooldown(`rate-limit:${ipHash}`, "ip_rate_limit_exceeded", {
      ip: clientIp || "unknown",
      ipHash,
      count: rateLimitResult.count,
      limit: rateLimitResult.limit,
      window: rateLimitResult.window,
    });

    return reply.code(429).send({
      error: "Too many voting attempts from this IP. Please try later.",
      window: rateLimitResult.window,
      limit: rateLimitResult.limit,
    });
  }

  const geo = checkKenyaIp(clientIp);

  if (!geo.allowed) {
    const blockedCount = await incrementWithExpiry(`anom:blocked-country:${ipHash}`, 60);
    if (blockedCount >= config.anomalyBlockedGeoThresholdPerMinute) {
      await sendAlertWithCooldown(`blocked-country:${ipHash}`, "blocked_geo_spike", {
        ip: clientIp || "unknown",
        ipHash,
        blockedCount,
        threshold: config.anomalyBlockedGeoThresholdPerMinute,
        reason: geo.reason,
        countryCode: geo.countryCode,
      });
    }

    return reply.code(403).send({
      error: "Voting is restricted to Kenya IP addresses.",
      reason: geo.reason,
      countryCode: geo.countryCode,
    });
  }

  const { optionId } = request.body || {};
  if (!Number.isInteger(optionId) || optionId <= 0 || optionId > 2147483647) {
    return reply.code(400).send({ error: "Invalid vote option." });
  }

  const deviceHash = hashValue(`session:${voteSession.jti}`);

  const uniqueDevicesCount = await trackUniqueDevicesForIp(ipHash, deviceHash);
  if (uniqueDevicesCount >= config.anomalyUniqueDevicesPerIpPerMinute) {
    await sendAlertWithCooldown(`unique-devices:${ipHash}`, "ip_device_fanout_spike", {
      ip: clientIp || "unknown",
      ipHash,
      uniqueDevicesCount,
      threshold: config.anomalyUniqueDevicesPerIpPerMinute,
    });
  }

  const lockKey = `vote-lock:${deviceHash}`;
  const lockAcquired = await redis.set(lockKey, "1", "NX", "EX", 15);
  if (lockAcquired !== "OK") {
    return reply.code(429).send({ error: "Another vote request is in progress for this device." });
  }

  try {
    const optionResult = await query(
      `SELECT id FROM poll_options WHERE poll_id = $1 AND id = $2 LIMIT 1`,
      [activePoll.id, optionId]
    );

    if (optionResult.rowCount === 0) {
      return reply.code(400).send({ error: "Invalid vote option." });
    }

    const inserted = await withTransaction(async (client) => {
      const insertVote = await client.query(
        `
          INSERT INTO votes (
            poll_id,
            option_id,
            device_hash,
            ip_hash,
            ip_address,
            country_code
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (poll_id, device_hash) DO NOTHING
          RETURNING id
        `,
        [
          activePoll.id,
          optionId,
          deviceHash,
          ipHash,
          clientIp || null,
          geo.countryCode,
        ]
      );

      return insertVote.rowCount > 0;
    });

    if (!inserted) {
      return reply.code(409).send({ error: "This device has already voted in this poll." });
    }

    await redis.set(`voted:${activePoll.id}:${deviceHash}`, "1", "EX", 60 * 60 * 24 * 400);

    return reply.code(201).send({
      message: "Vote recorded successfully.",
      countryCode: geo.countryCode,
    });
  } finally {
    await redis.del(lockKey);
  }
});

server.get("/", async (_, reply) => {
  return reply.sendFile("index.html");
});

async function start() {
  await ensureSchema();

  await server.listen({
    port: config.port,
    host: "0.0.0.0",
  });

  server.log.info(`Server running on port ${config.port}`);
}

async function shutdown() {
  try {
    await server.close();
  } catch (_) {
    // Ignore close errors during shutdown.
  }
  await closePool();
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

module.exports = {
  server,
  ensureSchema,
  start,
  shutdown,
};
