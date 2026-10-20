import { randomBytes, randomUUID } from "node:crypto";
import { now } from "../clock";
import { getDb, isUniqueViolation } from "../db";
import { getTemplate, selectInstance } from "../engine/generator";
import { newSeed } from "../engine/rng";
import { BANDS, type Band, type TemplateId } from "../engine/types";
import type { EventRow } from "./missions";

const CODE_CHARS = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

function newCode(): string {
  return Array.from(randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

/**
 * Shared-event mode: every participant who enters the code gets the identical mission.
 * The seed and attempt are resolved and validated once, here, and the fingerprint is
 * stored so each player's copy can be checked against it.
 */
export async function createEvent(opts: { name: string; band: Band; minutes: number; startsAt?: number; templateId?: TemplateId }): Promise<EventRow> {
  const templateId = opts.templateId ?? "city-heist";
  const template = getTemplate(templateId);
  if (!template) throw new Error(`unknown template ${templateId}`);
  if (!BANDS.includes(opts.band)) throw new Error("band must be 1-5");
  const seed = newSeed();
  const sel = selectInstance(template, seed, { band: opts.band, focusTags: [] });
  const db = getDb();
  const t = now();
  const startsAt = opts.startsAt ?? t;
  const id = randomUUID();
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    try {
      await db.prepare(
        `INSERT INTO events (id, code, name, template_id, band, seed, gen_attempt, fingerprint, created_at, starts_at, ends_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(id, code, opts.name.slice(0, 60), templateId, opts.band, seed, sel.attempt, sel.puzzle.fingerprint, t, startsAt, startsAt + opts.minutes * 60_000);
      return (await db.prepare(`SELECT * FROM events WHERE id = ?`).get<EventRow>(id))!;
    } catch (err) {
      if (!isUniqueViolation(err, "code")) throw err;
    }
  }
  throw new Error("could not allocate an event code");
}

export async function closeEvent(code: string): Promise<boolean> {
  return (await getDb().prepare(`UPDATE events SET active = 0 WHERE code = ?`).run(code.toUpperCase())).changes === 1;
}

export async function allEvents(): Promise<EventRow[]> {
  return getDb().prepare(`SELECT * FROM events ORDER BY created_at DESC`).all<EventRow>();
}
