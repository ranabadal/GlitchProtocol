import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { now } from "./clock";
import { config } from "./config";
import { getDb } from "./db";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
export const SESSION_COOKIE = "gp_session";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// A dummy hash so failed logins for unknown names take as long as real ones.
let dummyHash: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  if (!dummyHash) dummyHash = hashPassword("not-a-real-password-" + randomUUID());
  return dummyHash;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function newParticipantId(): string {
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (b) => CROCKFORD[b % 32]);
  return `GP-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}`;
}

export const RESERVED_NICKNAMES = new Set(["null", "admin", "system", "operator", "root", "glitch"]);

export const nicknameSchema = z
  .string()
  .trim()
  .min(3, "Kam se kam 3 letters ka naam rakho.")
  .max(16, "Naam 16 letters se chhota rakho.")
  .regex(/^[A-Za-z0-9_-]+$/, "Sirf letters, numbers, - ya _ use karo.")
  .refine((v) => !RESERVED_NICKNAMES.has(v.toLowerCase()), "Ye naam reserved hai. Koi aur chuno.");

export const passwordSchema = z
  .string()
  .min(8, "Password kam se kam 8 characters ka ho.")
  .max(128, "Password bahut lamba hai.");

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: number }> {
  const token = randomBytes(32).toString("base64url");
  const t = now();
  const expiresAt = t + config.sessionHours * 3600_000;
  await getDb()
    .prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`)
    .run(hashToken(token), userId, t, expiresAt, t);
  return { token, expiresAt };
}

export async function userIdForSession(token: string | null | undefined): Promise<string | null> {
  if (!token || token.length > 100) return null;
  const db = getDb();
  const row = await db.prepare(`SELECT user_id, expires_at, last_seen_at FROM sessions WHERE token_hash = ?`).get<{ user_id: string; expires_at: number; last_seen_at: number }>(hashToken(token));
  if (!row) return null;
  const t = now();
  if (row.expires_at <= t) {
    await db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
    return null;
  }
  if (t - row.last_seen_at > 60_000) await db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?`).run(t, hashToken(token));
  return row.user_id;
}

export async function deleteSession(token: string | null | undefined): Promise<void> {
  if (!token) return;
  await getDb().prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
}

export function sessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie("", 0, secure);
}

/**
 * Fixed-window counter stored in the database. Returns true when the action is allowed.
 * One atomic statement, so concurrent requests can't both slip under the limit.
 * Used for login attempts, registrations and AI calls.
 */
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  const t = now();
  const row = await getDb()
    .prepare(
      `INSERT INTO counters (key, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN ? - counters.window_start >= ? THEN 1 ELSE counters.count + 1 END,
         window_start = CASE WHEN ? - counters.window_start >= ? THEN ? ELSE counters.window_start END
       RETURNING count`,
    )
    .get<{ count: number }>(key, t, t, windowMs, t, windowMs, t);
  return (row?.count ?? 1) <= limit;
}
