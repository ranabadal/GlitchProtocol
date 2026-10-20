import path from "node:path";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function resolveFromRoot(p: string): string {
  // Runtime data lives outside the build; skip build-time file tracing for it.
  return path.isAbsolute(p) ? p : path.join(/*turbopackIgnore: true*/ process.cwd(), p);
}

export const config = {
  /** Postgres connection string (Supabase etc.). Empty = local PGlite database folder. */
  get databaseUrl(): string {
    // POSTGRES_URL is what Vercel's Supabase integration sets automatically (pooled connection).
    return (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
  },
  /** Folder of the built-in database. Ignores an old SQLite file path (e.g. ./data/glitch.db) from earlier versions. */
  get databasePath(): string {
    const raw = (process.env.DATABASE_PATH ?? "").trim();
    return resolveFromRoot(raw && !/\.(db|sqlite3?)$/i.test(raw) ? raw : "./data/pglite");
  },
  get sessionHours(): number {
    return num("SESSION_HOURS", 12);
  },
  get aiTimeoutMs(): number {
    return num("AI_TIMEOUT_MS", 5000);
  },
  get aiDailyBudget(): number {
    return num("AI_DAILY_BUDGET", 600);
  },
  get aiUserHourlyLimit(): number {
    return num("AI_USER_HOURLY_LIMIT", 25);
  },
  get aiDisabled(): boolean {
    return process.env.GP_DISABLE_AI === "1" || process.env.GP_DISABLE_AI === "true";
  },
};
