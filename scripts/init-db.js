const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
require("dotenv").config();

// Applies the base schema followed by every migration in order. The migrations
// carry the integrity functions (cast_vote, poll_results, consume_rate_limit)
// that all three backends call, and guard their Supabase-only role grants, so
// this works against a plain self-hosted Postgres too.

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/election_poll";

const pool = new Pool({ connectionString: databaseUrl });

function collectSqlFiles() {
  const files = [path.join(__dirname, "..", "sql", "schema.sql")];
  const migrationsDir = path.join(__dirname, "..", "supabase", "migrations");

  if (fs.existsSync(migrationsDir)) {
    const migrations = fs
      .readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    for (const name of migrations) {
      files.push(path.join(migrationsDir, name));
    }
  }

  return files;
}

async function main() {
  for (const file of collectSqlFiles()) {
    process.stdout.write(`Applying ${path.relative(process.cwd(), file)}... `);
    await pool.query(fs.readFileSync(file, "utf8"));
    console.log("ok");
  }

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
