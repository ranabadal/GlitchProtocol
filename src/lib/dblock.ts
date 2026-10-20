import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/*
 * The built-in database (PGlite) may be opened by only one program at a time. Whoever opens
 * it writes data/pglite.lock with its process id and a random key:
 *   - the game server holds it while running; operator scripts (npm run event, ...) then send
 *     their command to the server instead (POST /api/admin with that key);
 *   - a script holds it for a second or two; a server starting meanwhile waits for it.
 * With DATABASE_URL (Supabase) none of this is needed: Postgres handles many clients.
 */

export interface LockInfo {
  pid: number;
  role: "server" | "script";
  key: string;
  port?: string;
  at: number;
}

export const lockPathFor = (dir: string) => path.resolve(dir) + ".lock";

export function readLock(dir: string): LockInfo | null {
  try {
    const l = JSON.parse(fs.readFileSync(lockPathFor(dir), "utf8")) as LockInfo;
    return typeof l?.pid === "number" && typeof l.key === "string" ? l : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lock of another program that is still running, if any. */
export function liveLock(dir: string): LockInfo | null {
  const l = readLock(dir);
  return l && l.pid !== process.pid && alive(l.pid) ? l : null;
}

let held: { dir: string; info: LockInfo } | null = null;

/** Key of the lock this process holds (the admin route checks scripts against it). */
export const heldLockKey = () => held?.info.key ?? null;

export async function acquireLock(dir: string): Promise<void> {
  const role: LockInfo["role"] = process.env.GP_DB_ROLE === "script" ? "script" : "server";
  const waitUntil = Date.now() + 60_000;
  for (;;) {
    const other = liveLock(dir);
    if (!other) break;
    if (role === "server" && other.role === "script" && Date.now() < waitUntil) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    const file = lockPathFor(dir);
    throw new Error(
      other.role === "server"
        ? `The game database is already open in another running game server (process ${other.pid}). Stop the other "npm run dev" / "npm run event-day" window first. If nothing else is running, delete ${file}.`
        : `Another "npm run ..." command is using the database right now (process ${other.pid}). Try again in a moment. If nothing else is running, delete ${file}.`,
    );
  }
  const info: LockInfo = { pid: process.pid, role, key: randomBytes(24).toString("base64url"), port: process.env.PORT, at: Date.now() };
  fs.mkdirSync(path.dirname(lockPathFor(dir)), { recursive: true });
  fs.writeFileSync(lockPathFor(dir), JSON.stringify(info), { mode: 0o600 });
  held = { dir, info };
  process.once("exit", releaseLock);
}

export function releaseLock(): void {
  if (!held) return;
  try {
    if (readLock(held.dir)?.pid === process.pid) fs.unlinkSync(lockPathFor(held.dir));
  } catch {
    /* already gone */
  }
  held = null;
}
