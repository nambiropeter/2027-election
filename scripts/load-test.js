const autocannon = require("autocannon");

/**
 * Load test for the poll API.
 *
 * MODE=read  (default) hammers the tally endpoint, which is the hot path: every
 *                      visitor loads it and the page re-polls it on a timer.
 * MODE=vote            mints a pool of distinct voter tokens up front and
 *                      rotates through them, so each request is a genuine first
 *                      vote from a different device.
 *
 * The previous version reused one session cookie for the whole run, so the
 * first request inserted a vote and every later one was rejected as a duplicate
 * - it measured the 409 path, not the write path.
 */

const baseUrl = process.env.BASE_URL || "http://localhost:3000";
const mode = (process.env.MODE || "read").toLowerCase();
const optionId = Number(process.env.OPTION_ID || 1);
const connections = Number(process.env.CONNECTIONS || 200);
const duration = Number(process.env.DURATION || 30);
const tokenPoolSize = Number(process.env.TOKEN_POOL || 5000);

const TOKEN_HEADER = "x-voter-token";

/** Each GET /api/poll mints a fresh identity; collect a pool of them. */
async function mintTokens(count) {
  const tokens = [];
  const batchSize = 50;

  process.stdout.write(`Minting ${count} voter tokens`);

  for (let index = 0; index < count; index += batchSize) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(batchSize, count - index) }, async () => {
        const response = await fetch(`${baseUrl}/api/poll`);
        if (!response.ok) {
          throw new Error(`GET /api/poll returned ${response.status}`);
        }
        const body = await response.json();
        return response.headers.get(TOKEN_HEADER) || body.token;
      })
    );

    tokens.push(...batch.filter(Boolean));
    process.stdout.write(".");
  }

  process.stdout.write("\n");

  if (tokens.length === 0) {
    throw new Error("No voter tokens were issued. Is the server reachable?");
  }

  return tokens;
}

function run(options) {
  const instance = autocannon(options);

  autocannon.track(instance, {
    renderProgressBar: true,
    renderResultsTable: true,
    renderLatencyTable: true,
  });

  return new Promise((resolve) => instance.on("done", resolve));
}

async function main() {
  if (mode === "read") {
    console.log(`Read load test against ${baseUrl}/api/results`);
    await run({
      url: `${baseUrl}/api/results`,
      connections,
      duration,
      pipelining: 1,
    });
    return;
  }

  if (mode !== "vote") {
    throw new Error(`Unknown MODE "${mode}". Use "read" or "vote".`);
  }

  const tokens = await mintTokens(tokenPoolSize);
  const requestBody = JSON.stringify({ optionId });
  let cursor = 0;

  console.log(
    `Vote load test against ${baseUrl}/api/vote with ${tokens.length} distinct devices`
  );
  console.log(
    "Note: each token can only succeed once, so expect 409s once the pool is exhausted."
  );

  await run({
    url: `${baseUrl}/api/vote`,
    connections,
    duration,
    pipelining: 1,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody,
    setupRequest(request) {
      const token = tokens[cursor % tokens.length];
      cursor += 1;

      return {
        ...request,
        headers: {
          ...request.headers,
          [TOKEN_HEADER]: token,
        },
      };
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
