const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
require("dotenv").config();

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/election_poll";

const pool = new Pool({
  connectionString: databaseUrl,
});

async function main() {
  const schemaPath = path.join(__dirname, "..", "sql", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");

  await pool.query(sql);
  console.log("Database initialized successfully.");
}

main()
  .catch((error) => {
    console.error("Failed to initialize DB:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
