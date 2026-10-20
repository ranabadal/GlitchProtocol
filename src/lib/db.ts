import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { acquireLock, releaseLock } from "./dblock";

/*
 * Postgres everywhere, with no native modules to compile:
 *   - DATABASE_URL set (e.g. Supabase)  -> real Postgres through `pg` (use the pooler URL on Vercel)
 *   - DATABASE_URL empty (laptop, offline event day, tests) -> PGlite, Postgres compiled to
 *     WebAssembly, stored in ./data/pglite
 *
 * The rest of the code uses a small async API: prepare(sql).get/all/run, exec, and
 * transaction(fn, lockKey). SQL is written with `?` placeholders. Inside a transaction,
 * every query (even through getDb()) is routed to the transaction's connection via
 * AsyncLocalStorage; an optional lock key serialises transactions that touch the same
 * thing (e.g. one mission) with a Postgres advisory lock.
 */

type Param = string | number | bigint | null | boolean | undefined | Uint8Array | Buffer;
interface Conn {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[]; affectedRows: number }>;
  exec(sql: string): Promise<void>;
}

const txStore = new AsyncLocalStorage<Conn>();

/** `?` -> `$1, $2 ...` (outside quoted strings). */
export function toPg(sql: string): string {
  let n = 0, out = "", q = false;
  for (const ch of sql) {
    if (ch === "'") q = !q;
    out += ch === "?" && !q ? `$${++n}` : ch;
  }
  return out;
}

const clean = (args: Param[]) => args.map((a) => (a === undefined ? null : typeof a === "bigint" ? Number(a) : a));

export class Statement {
  constructor(private db: DB, private sql: string) {}
  private conn(): Conn {
    return txStore.getStore() ?? this.db.root;
  }
  async get<T = unknown>(...args: Param[]): Promise<T | undefined> {
    await this.db.ready;
    return (await this.conn().query(this.sql, clean(args))).rows[0] as T | undefined;
  }
  async all<T = unknown>(...args: Param[]): Promise<T[]> {
    await this.db.ready;
    return (await this.conn().query(this.sql, clean(args))).rows as T[];
  }
  async run(...args: Param[]): Promise<{ changes: number }> {
    await this.db.ready;
    return { changes: (await this.conn().query(this.sql, clean(args))).affectedRows };
  }
}

export class DB {
  ready: Promise<void>;
  constructor(public root: Conn & { transaction<T>(fn: (c: Conn) => Promise<T>): Promise<T>; close(): Promise<void> }, public kind: "postgres" | "pglite") {
    this.ready = migrate(this);
  }
  prepare(sql: string): Statement {
    return new Statement(this, toPg(sql));
  }
  async exec(sql: string): Promise<void> {
    await this.ready;
    await (txStore.getStore() ?? this.root).exec(sql);
  }
  /** Runs fn in one transaction. Nested calls join the outer one. lockKey serialises transactions on the same key. */
  async transaction<T>(fn: () => Promise<T>, lockKey?: string): Promise<T> {
    await this.ready;
    if (txStore.getStore()) return fn();
    return this.root.transaction(async (c) => {
      if (lockKey) await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey]);
      return txStore.run(c, fn);
    });
  }
  close(): Promise<void> {
    return this.root.close();
  }
}

/** True if err is a unique-constraint violation (optionally on a column/constraint containing `hint`). */
export function isUniqueViolation(err: unknown, hint?: string): boolean {
  const e = err as { code?: string; message?: string; constraint?: string; detail?: string };
  if (e?.code !== "23505" && !String(e?.message ?? "").includes("duplicate key")) return false;
  if (!hint) return true;
  return [e.constraint, e.message, e.detail].some((x) => String(x ?? "").includes(hint));
}

// Each entry runs once, in order, inside a transaction. Never edit an applied
// migration; append a new one instead so existing event databases upgrade cleanly.
const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE users (
    id              TEXT PRIMARY KEY,
    participant_id  TEXT NOT NULL UNIQUE,
    nickname        TEXT NOT NULL,
    nickname_key    TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    avatar_id       TEXT NOT NULL DEFAULT 'viper',
    photo_file      TEXT,
    photo_data      BYTEA,
    show_photo      BIGINT NOT NULL DEFAULT 0,
    difficulty_pref TEXT NOT NULL DEFAULT 'balanced',
    xp              BIGINT NOT NULL DEFAULT 0,
    level           BIGINT NOT NULL DEFAULT 1,
    created_at      BIGINT NOT NULL,
    last_login_at   BIGINT
  );

  CREATE TABLE sessions (
    token_hash   TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   BIGINT NOT NULL,
    expires_at   BIGINT NOT NULL,
    last_seen_at BIGINT NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE skill_state (
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    template_id    TEXT NOT NULL,
    band           BIGINT NOT NULL,
    success_streak BIGINT NOT NULL DEFAULT 0,
    fail_streak    BIGINT NOT NULL DEFAULT 0,
    attempts       BIGINT NOT NULL DEFAULT 0,
    successes      BIGINT NOT NULL DEFAULT 0,
    updated_at     BIGINT NOT NULL,
    PRIMARY KEY (user_id, template_id)
  );

  CREATE TABLE events (
    id           TEXT PRIMARY KEY,
    code         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    template_id  TEXT NOT NULL,
    band         BIGINT NOT NULL,
    seed         TEXT NOT NULL,
    gen_attempt  BIGINT NOT NULL,
    fingerprint  TEXT NOT NULL,
    created_at   BIGINT NOT NULL,
    starts_at    BIGINT NOT NULL,
    ends_at      BIGINT NOT NULL,
    active       BIGINT NOT NULL DEFAULT 1
  );

  -- One row per generated mission. mission_public is safe to send to the browser;
  -- mission_key (hack answers) never leaves the server. state is the live,
  -- server-validated progress; version guards it against concurrent updates.
  CREATE TABLE mission_instances (
    id               TEXT PRIMARY KEY,
    seq              BIGSERIAL,
    template_id      TEXT NOT NULL,
    template_version BIGINT NOT NULL,
    ruleset_version  TEXT NOT NULL,
    seed             TEXT NOT NULL,
    gen_attempt      BIGINT NOT NULL,
    gen_inputs       TEXT NOT NULL,
    scope            TEXT NOT NULL CHECK (scope IN ('personal','event')),
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id         TEXT REFERENCES events(id),
    band             BIGINT NOT NULL,
    variant          TEXT NOT NULL,
    fingerprint      TEXT NOT NULL,
    tags             TEXT NOT NULL,
    mission_public   TEXT NOT NULL,
    mission_key      TEXT NOT NULL,
    narrative        TEXT NOT NULL,
    narrative_source TEXT NOT NULL,
    time_limit_sec   BIGINT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('briefing','active','completed','failed','abandoned')),
    state            TEXT NOT NULL,
    version          BIGINT NOT NULL DEFAULT 0,
    created_at       BIGINT NOT NULL,
    started_at       BIGINT,
    deadline_at      BIGINT,
    expires_at       BIGINT,
    finished_at      BIGINT
  );
  CREATE INDEX idx_instances_user_template ON mission_instances(user_id, template_id, created_at);
  -- A player can have at most one open mission. This also stops a refresh from
  -- creating a second instance when two requests race.
  CREATE UNIQUE INDEX uq_one_open_mission ON mission_instances(user_id) WHERE status IN ('briefing','active');
  -- A player gets exactly one instance per shared event.
  CREATE UNIQUE INDEX uq_one_event_instance ON mission_instances(user_id, event_id) WHERE event_id IS NOT NULL;

  CREATE TABLE attempts (
    id              TEXT PRIMARY KEY,
    seq             BIGSERIAL,
    instance_id     TEXT NOT NULL UNIQUE REFERENCES mission_instances(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    template_id     TEXT NOT NULL,
    band            BIGINT NOT NULL,
    scope           TEXT NOT NULL,
    event_id        TEXT,
    outcome         TEXT NOT NULL CHECK (outcome IN ('success','fail','timeout','abandoned')),
    elapsed_ms      BIGINT NOT NULL,
    score           BIGINT NOT NULL,
    xp_awarded      BIGINT NOT NULL,
    score_breakdown TEXT NOT NULL,
    mistake_tags    TEXT NOT NULL,
    detail          TEXT NOT NULL,
    ruleset_version TEXT NOT NULL,
    feedback        TEXT,
    feedback_source TEXT,
    created_at      BIGINT NOT NULL
  );
  CREATE INDEX idx_attempts_user ON attempts(user_id, created_at);
  CREATE INDEX idx_attempts_scope ON attempts(scope, band, score);
  CREATE INDEX idx_attempts_event ON attempts(event_id, score);

  CREATE TABLE achievements (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code        TEXT NOT NULL,
    unlocked_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, code)
  );

  CREATE TABLE ai_cache (
    cache_key  TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    hits       BIGINT NOT NULL DEFAULT 0
  );

  CREATE TABLE counters (
    key          TEXT PRIMARY KEY,
    count        BIGINT NOT NULL,
    window_start BIGINT NOT NULL
  );
  `,
];


async function migrate(db: DB): Promise<void> {
  await db.root.transaction(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('gp-migrate'))`, []);
    await c.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version BIGINT PRIMARY KEY, applied_at BIGINT NOT NULL)`);
    const row = (await c.query(`SELECT MAX(version) AS v FROM schema_migrations`, [])).rows[0] as { v: number | null };
    for (let i = Number(row?.v ?? 0); i < MIGRATIONS.length; i++) {
      await c.exec(MIGRATIONS[i]);
      await c.query(`INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)`, [i + 1, Date.now()]);
    }
  });
}

// ---------------------------------------------------------------- drivers

/**
 * Cleans up a pasted connection string. SSL is always on for remote hosts (Supabase), and any
 * sslmode in the URL is dropped because node-postgres would then insist on verifying Supabase's
 * own certificate chain and refuse to connect.
 */
export function pgConnection(url: string): { connectionString: string; ssl: false | { rejectUnauthorized: false } } {
  if (/\[?YOUR[-_]PASSWORD\]?/i.test(url)) {
    throw new Error("DATABASE_URL still contains [YOUR-PASSWORD]. Replace it with your Supabase database password.");
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a valid postgres:// address. If your password has symbols like @ # / ? %, reset it in Supabase to letters and numbers only.");
  }
  const mode = (u.searchParams.get("sslmode") ?? "").toLowerCase();
  for (const k of ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]) u.searchParams.delete(k);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  return { connectionString: u.toString(), ssl: local || mode === "disable" ? false : { rejectUnauthorized: false } };
}

async function openPostgres(url: string): Promise<DB["root"]> {
  const pg = (await import("pg")).default;
  pg.types.setTypeParser(20, (v: string) => Number(v)); // int8 -> number (timestamps, counts)
  pg.types.setTypeParser(1700, (v: string) => Number(v)); // numeric (SUM) -> number
  const { connectionString, ssl } = pgConnection(url);
  const pool = new pg.Pool({ connectionString, ssl, max: Number(process.env.DB_POOL_MAX ?? (process.env.VERCEL ? 3 : 8)), idleTimeoutMillis: 10_000, });
  const wrap = (c: { query: (s: string, p: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> }): Conn => ({
    query: async (s, p) => { const r = await c.query(s, p); return { rows: r.rows, affectedRows: r.rowCount ?? 0 }; },
    exec: async (s) => { await c.query(s, []); },
  });
  const root = wrap(pool as never);
  return {
    ...root,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const r = await fn(wrap(client as never));
        await client.query("COMMIT");
        return r;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function openPglite(dir: string | null): Promise<DB["root"]> {
  const { PGlite, types } = await import("@electric-sql/pglite");
  if (dir) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await acquireLock(dir);
  }
  let db: InstanceType<typeof PGlite>;
  try {
    db = await PGlite.create(dir ?? undefined, { parsers: { [types.INT8]: (v: string) => Number(v), [types.NUMERIC]: (v: string) => Number(v) } });
  } catch (e) {
    if (dir) releaseLock();
    throw e;
  }
  type Q = { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>; exec: (s: string) => Promise<unknown> };
  const wrap = (c: Q): Conn => ({
    query: async (s, p) => { const r = await c.query(s, p); return { rows: r.rows as Record<string, unknown>[], affectedRows: r.affectedRows ?? 0 }; },
    exec: async (s) => { await c.exec(s); },
  });
  return {
    ...wrap(db as unknown as Q),
    transaction: (fn) => db.transaction((tx) => fn(wrap(tx as unknown as Q))),
    close: async () => {
      await db.close();
      if (dir) releaseLock();
    },
  };
}

/** A database handle that becomes usable once its driver has loaded and migrations ran. */
function lazyDb(open: () => Promise<DB["root"]>, kind: DB["kind"]): DB {
  let real: DB["root"] | null = null;
  const opening = open().then((r) => { real = r; });
  const proxy: DB["root"] = {
    query: async (s, p) => { await opening; return real!.query(s, p); },
    exec: async (s) => { await opening; return real!.exec(s); },
    transaction: async (fn) => { await opening; return real!.transaction(fn); },
    close: async () => { await opening; return real!.close(); },
  };
  return new DB(proxy, kind);
}

export function openDatabase(target: string): DB {
  if (/^postgres(ql)?:\/\//.test(target)) return lazyDb(() => openPostgres(target), "postgres");
  return lazyDb(() => openPglite(target === ":memory:" ? null : target), "pglite");
}

// One handle per server process, kept on globalThis so `next dev` hot reloads reuse it.
const g = globalThis as unknown as { __gpDb?: DB };

export function getDb(): DB {
  if (!g.__gpDb) {
    // Hosted servers (Vercel) have no lasting disk, so a real Postgres URL is required there.
    if (!config.databaseUrl && process.env.VERCEL) {
      throw new Error("DATABASE_URL is not set. Add your Supabase connection string in Vercel -> Settings -> Environment Variables, then redeploy.");
    }
    const db = openDatabase(config.databaseUrl || config.databasePath);
    g.__gpDb = db;
    // If the database can't be reached (network blip, wrong password), try again on the next request.
    db.ready.catch(() => {
      if (g.__gpDb === db) g.__gpDb = undefined;
      db.close().catch(() => {});
    });
  }
  return g.__gpDb;
}

export function __setDbForTests(db: DB): void {
  g.__gpDb = db;
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
