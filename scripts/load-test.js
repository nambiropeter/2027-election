const autocannon = require("autocannon");
const { randomUUID } = require("crypto");

const baseUrl = process.env.BASE_URL || "http://localhost:3000";
const optionId = Number(process.env.OPTION_ID || 1);
const connections = Number(process.env.CONNECTIONS || 1000);
const duration = Number(process.env.DURATION || 30);
const requestBody = JSON.stringify({ optionId });

async function main() {
  const pollResponse = await fetch(`${baseUrl}/api/poll`);
  const setCookie = pollResponse.headers.get("set-cookie");

  if (!setCookie) {
    throw new Error("No session cookie received from /api/poll. Cannot run vote load test.");
  }

  const cookieHeader = setCookie.split(";")[0];

  const instance = autocannon({
    url: `${baseUrl}/api/vote`,
    method: "POST",
    connections,
    duration,
    pipelining: 1,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(requestBody)),
      cookie: cookieHeader,
      "x-load-run-id": randomUUID(),
    },
    body: requestBody,
  });

  autocannon.track(instance, {
    renderProgressBar: true,
    renderResultsTable: true,
    renderLatencyTable: true,
  });

  instance.on("done", () => {
    console.log("Load test completed.");
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
