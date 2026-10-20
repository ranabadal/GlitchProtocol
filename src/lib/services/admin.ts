import { hashPassword, passwordSchema } from "../auth";
import { getDb } from "../db";
import type { Band } from "../engine/types";
import { allEvents, closeEvent, createEvent } from "./events";

/*
 * Operator commands (npm run event / reset-password / db:backup). They run either directly
 * against the database, or inside the running game server via POST /api/admin when the
 * built-in database is already open there.
 */

const BACKUP_TABLES = ["users", "sessions", "skill_state", "events", "mission_instances", "attempts", "achievements", "ai_cache", "counters", "schema_migrations"];

export type AdminAction = "event.create" | "event.list" | "event.close" | "password.reset" | "backup";

export class AdminError extends Error {}

export async function runAdmin(action: AdminAction, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (action) {
    case "event.create": {
      const band = Number(args.band) as Band;
      if (![1, 2, 3, 4, 5].includes(band)) throw new AdminError("--band must be 1-5 (1 Rookie ... 5 Legend)");
      const minutes = Number(args.minutes);
      if (!(minutes > 0 && minutes <= 7 * 24 * 60)) throw new AdminError("--minutes must be between 1 and 10080");
      const name = String(args.name ?? "GLITCH PROTOCOL Event").slice(0, 60);
      return createEvent({ name, band, minutes, startsAt: Date.now() + Number(args.startsInMin ?? 0) * 60_000 });
    }
    case "event.list":
      return allEvents();
    case "event.close":
      return closeEvent(String(args.code ?? ""));
    case "password.reset":
      return resetPassword(String(args.ident ?? ""), String(args.password ?? ""));
    case "backup":
      return backup();
    default:
      throw new AdminError(`Unknown command ${String(action)}`);
  }
}

async function resetPassword(ident: string, password: string): Promise<{ nickname: string; participantId: string }> {
  const ok = passwordSchema.safeParse(password);
  if (!ok.success) throw new AdminError(ok.error.issues[0]?.message ?? "Password too short (min 8).");
  const db = getDb();
  const user = await db
    .prepare(`SELECT id, nickname, participant_id FROM users WHERE nickname_key = ? OR participant_id = ?`)
    .get<{ id: string; nickname: string; participant_id: string }>(ident.toLowerCase(), ident.toUpperCase());
  if (!user) throw new AdminError(`No player called "${ident}".`);
  const hash = await hashPassword(password);
  await db.transaction(async () => {
    await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, user.id);
    await db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(user.id);
    await db.prepare(`DELETE FROM counters WHERE key LIKE ?`).run(`login:id:${user.nickname.toLowerCase()}%`);
  });
  return { nickname: user.nickname, participantId: user.participant_id };
}

async function backup(): Promise<{ version: 1; createdAt: string; tables: Record<string, unknown[]> }> {
  const db = getDb();
  const tables: Record<string, unknown[]> = {};
  await db.transaction(async () => {
    for (const t of BACKUP_TABLES) {
      const rows = await db.prepare(`SELECT * FROM ${t}`).all<Record<string, unknown>>();
      tables[t] = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v])));
    }
  });
  return { version: 1, createdAt: new Date().toISOString(), tables };
}
