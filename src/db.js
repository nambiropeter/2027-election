const { Pool } = require("pg");
const { config } = require("./config");

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 80,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

async function query(text, params) {
  return pool.query(text, params);
}

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function closePool() {
  await pool.end();
}

module.exports = { query, withTransaction, closePool };
