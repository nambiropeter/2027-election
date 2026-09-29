const crypto = require("crypto");

// Voter token, byte-for-byte compatible with the Supabase edge function
// implementation in supabase/functions/_shared/utils.ts so a deployment can
// move between the two backends without invalidating anyone's vote receipt.
//
// Format: base64url(JSON payload) "." base64url(HMAC-SHA256 of that body)

const TOKEN_HEADER = "x-voter-token";

function sign(body, secret) {
  return crypto.createHmac("sha256", secret).update(body).digest("base64url");
}

function createToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }

  const [body, signature] = parts;
  const expected = sign(body, secret);

  const provided = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (provided.length !== expectedBuffer.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(provided, expectedBuffer)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch (_) {
    return null;
  }

  if (
    !payload ||
    payload.v !== 1 ||
    typeof payload.p !== "number" ||
    typeof payload.d !== "string" ||
    payload.d.length < 16 ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}

function randomDeviceId() {
  return crypto.randomBytes(24).toString("base64url");
}

function hmacHex(secret, input) {
  return crypto.createHmac("sha256", secret).update(input).digest("hex");
}

module.exports = { TOKEN_HEADER, createToken, verifyToken, randomDeviceId, hmacHex };
