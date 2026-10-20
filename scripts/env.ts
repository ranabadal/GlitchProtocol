// Load .env.local (then .env) so scripts use the same database as the server.
for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(f);
  } catch {
    /* file not present */
  }
}

// Operator scripts open the database only briefly (see src/lib/dblock.ts).
process.env.GP_DB_ROLE = "script";
