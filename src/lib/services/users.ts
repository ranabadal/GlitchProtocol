import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { aiStatus } from "../ai/client";
import { getDummyHash, hashPassword, newParticipantId, nicknameSchema, passwordSchema, verifyPassword } from "../auth";
import { AVATAR_IDS, isAvatarId } from "../avatars";
import { now } from "../clock";
import { getDb, isUniqueViolation } from "../db";
import { DIFFICULTY_PREFS, HINT_OFFER_AFTER_FAILS, PACE_RULES, type DifficultyPref } from "../engine/difficulty";
import { levelForXp, xpForLevel } from "../engine/scoring";
import { BAND_LABELS } from "../engine/types";
import { HttpError, USER_COLS, type UserRow } from "../http";
import { ACHIEVEMENTS, achievementInfo } from "./achievements";
import { getSkill } from "./missions";

function firstIssue(err: z.ZodError): string {
  return err.issues[0]?.message ?? "Form check karke dobara try karo.";
}

const registerSchema = z.object({
  nickname: nicknameSchema,
  password: passwordSchema,
  avatarId: z.string().refine(isAvatarId, "Ek avatar chuno."),
});

export async function registerUser(raw: unknown): Promise<UserRow> {
  const r = registerSchema.safeParse(raw);
  if (!r.success) throw new HttpError(400, "INVALID_INPUT", firstIssue(r.error));
  const db = getDb();
  const key = r.data.nickname.toLowerCase();
  const hash = await hashPassword(r.data.password);
  const id = randomUUID();
  // The unique index on nickname_key decides taken names; one round trip creates and returns the row.
  for (let i = 0; i < 5; i++) {
    try {
      return (await db.prepare(
        `INSERT INTO users (id, participant_id, nickname, nickname_key, password_hash, avatar_id, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${USER_COLS}`,
      ).get<UserRow>(id, newParticipantId(), r.data.nickname, key, hash, r.data.avatarId, now(), now()))!;
    } catch (err) {
      if (isUniqueViolation(err, "nickname_key")) throw new HttpError(409, "NICKNAME_TAKEN", "Ye naam pehle se kisi ne le liya hai. Koi aur try karo.");
      if (!isUniqueViolation(err, "participant_id")) throw err;
    }
  }
  throw new HttpError(500, "ID_EXHAUSTED", "Participant ID nahi ban paya. Dobara try karo.");
}

const loginSchema = z.object({ identifier: z.string().trim().min(1).max(32), password: z.string().min(1).max(128) });

/** Look up the account for a login name or participant ID (started early, alongside the rate-limit check). */
export function findLoginUser(raw: unknown): Promise<UserRow | undefined> {
  const r = loginSchema.safeParse(raw);
  if (!r.success) return Promise.resolve(undefined);
  const ident = r.data.identifier;
  return getDb().prepare(`SELECT ${USER_COLS} FROM users WHERE nickname_key = ? OR participant_id = ?`).get<UserRow>(ident.toLowerCase(), ident.toUpperCase());
}

export async function loginUser(raw: unknown, found?: Promise<UserRow | undefined>): Promise<UserRow> {
  const r = loginSchema.safeParse(raw);
  if (!r.success) throw new HttpError(400, "INVALID_INPUT", "Apna naam ya participant ID aur password daalo.");
  const db = getDb();
  const user = await (found ?? findLoginUser(raw));
  const ok = await verifyPassword(r.data.password, user?.password_hash ?? (await getDummyHash()));
  if (!user || !ok) throw new HttpError(401, "BAD_CREDENTIALS", "Naam aur password match nahi hue.");
  // Bookkeeping only: don't make the player wait for it.
  void db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(now(), user.id).catch(() => {});
  return user;
}

const profileSchema = z.object({
  nickname: nicknameSchema.optional(),
  avatarId: z.string().refine(isAvatarId, "Ek avatar chuno.").optional(),
  showPhoto: z.boolean().optional(),
  difficultyPref: z.enum(DIFFICULTY_PREFS as [DifficultyPref, ...DifficultyPref[]]).optional(),
});

export async function updateProfile(user: UserRow, raw: unknown): Promise<void> {
  const r = profileSchema.safeParse(raw);
  if (!r.success) throw new HttpError(400, "INVALID_INPUT", firstIssue(r.error));
  const db = getDb();
  const d = r.data;
  if (d.nickname && d.nickname.toLowerCase() !== user.nickname_key) {
    if (await db.prepare(`SELECT 1 FROM users WHERE nickname_key = ? AND id != ?`).get(d.nickname.toLowerCase(), user.id)) {
      throw new HttpError(409, "NICKNAME_TAKEN", "Ye naam pehle se kisi ne le liya hai. Koi aur try karo.");
    }
  }
  await db.prepare(
    `UPDATE users SET nickname = COALESCE(?, nickname), nickname_key = COALESCE(?, nickname_key), avatar_id = COALESCE(?, avatar_id),
       show_photo = COALESCE(?, show_photo), difficulty_pref = COALESCE(?, difficulty_pref) WHERE id = ?`,
  ).run(d.nickname ?? null, d.nickname?.toLowerCase() ?? null, d.avatarId ?? null, d.showPhoto === undefined ? null : d.showPhoto ? 1 : 0, d.difficultyPref ?? null, user.id);
}

// ---------------------------------------------------------------- photos

export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

function sniffImage(buf: Buffer): "jpeg" | "png" | "webp" | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

/**
 * Re-encodes the upload to a 256x256 WebP. Re-encoding drops all metadata
 * (EXIF, GPS location, camera details) and anything that is not image data.
 * The small result (~10-20 KB) is stored in the database, so it works the same on a
 * laptop and on free hosting with no disk.
 */
export async function savePhoto(user: UserRow, buf: Buffer): Promise<void> {
  if (buf.length === 0) throw new HttpError(400, "NO_FILE", "Upload karne ke liye photo chuno.");
  if (buf.length > MAX_PHOTO_BYTES) throw new HttpError(413, "TOO_LARGE", "Photo 3 MB se chhoti honi chahiye.");
  if (!sniffImage(buf)) throw new HttpError(415, "BAD_TYPE", "JPEG, PNG ya WebP photo upload karo.");
  let sharp: (typeof import("sharp"))["default"];
  try {
    sharp = (await import("sharp")).default;
  } catch {
    throw new HttpError(503, "PHOTO_UNAVAILABLE", "Is computer pe photo upload nahi chal raha. Avatar use hoga.");
  }
  let out: Buffer;
  try {
    out = await sharp(buf, { limitInputPixels: 40_000_000, failOn: "error" }).rotate().resize(256, 256, { fit: "cover" }).webp({ quality: 82 }).toBuffer();
  } catch {
    throw new HttpError(415, "BAD_IMAGE", "Ye file photo ki tarah khul nahi rahi.");
  }
  // photo_file is just a version tag for cache-busting URLs.
  await getDb().prepare(`UPDATE users SET photo_data = ?, photo_file = ? WHERE id = ?`).run(out, randomBytes(8).toString("hex"), user.id);
}

export async function deletePhoto(user: UserRow): Promise<void> {
  await getDb().prepare(`UPDATE users SET photo_data = NULL, photo_file = NULL, show_photo = 0 WHERE id = ?`).run(user.id);
}

/** Only the owner, or any signed-in player when the owner opted in, may see a photo. */
export async function readPhotoFor(viewer: UserRow, ownerId: string): Promise<Buffer | null> {
  const owner = await getDb().prepare(`SELECT id, photo_data, show_photo FROM users WHERE id = ?`).get<{ id: string; photo_data: Uint8Array | null; show_photo: number }>(ownerId);
  if (!owner?.photo_data) return null;
  if (owner.id !== viewer.id && owner.show_photo !== 1) return null;
  return Buffer.from(owner.photo_data);
}

export function photoUrl(u: { id: string; photo_file: string | null }): string | null {
  return u.photo_file ? `/api/photos/${u.id}?v=${u.photo_file.slice(0, 8)}` : null;
}

export async function deleteAccount(user: UserRow, raw: unknown): Promise<void> {
  const r = z.object({ password: z.string().min(1).max(128) }).safeParse(raw);
  if (!r.success || !(await verifyPassword(r.data.password, user.password_hash))) {
    throw new HttpError(401, "BAD_CREDENTIALS", "Account delete karne ke liye apna password daalo.");
  }
  await getDb().prepare(`DELETE FROM users WHERE id = ?`).run(user.id);
}

// ---------------------------------------------------------------- profile payload

/** The player's own public profile fields (no database reads). */
export function publicUser(user: UserRow) {
  const level = levelForXp(user.xp);
  const pref = (user.difficulty_pref as DifficultyPref) in PACE_RULES ? (user.difficulty_pref as DifficultyPref) : "balanced";
  return {
    id: user.id,
    participantId: user.participant_id,
    nickname: user.nickname,
    avatarId: isAvatarId(user.avatar_id) ? user.avatar_id : AVATAR_IDS[0],
    photoUrl: photoUrl(user),
    showPhoto: user.show_photo === 1,
    difficultyPref: pref,
    xp: user.xp,
    level,
    levelFloorXp: xpForLevel(level),
    nextLevelXp: xpForLevel(level + 1),
  };
}

export async function mePayload(user: UserRow) {
  const db = getDb();
  const [s, last, unlocked, open, recent, stats, a] = await Promise.all([
    getSkill(db, user.id, "city-heist", user.level),
    db.prepare(`SELECT outcome FROM attempts WHERE user_id = ? AND scope = 'personal' ORDER BY created_at DESC, seq DESC LIMIT ?`).all<{ outcome: string }>(user.id, HINT_OFFER_AFTER_FAILS),
    db.prepare(`SELECT code, unlocked_at FROM achievements WHERE user_id = ? ORDER BY unlocked_at`).all<{ code: string; unlocked_at: number }>(user.id),
    db.prepare(`SELECT id, status, scope FROM mission_instances WHERE user_id = ? AND status IN ('briefing','active')`).get<{ id: string; status: string; scope: string }>(user.id),
    db
      .prepare(`SELECT instance_id, band, outcome, score, scope, score_breakdown, created_at FROM attempts WHERE user_id = ? ORDER BY created_at DESC, seq DESC LIMIT 8`)
      .all<{ instance_id: string; band: number; outcome: string; score: number; scope: string; score_breakdown: string; created_at: number }>(user.id),
    db
      .prepare(`SELECT COUNT(*) AS missions, COUNT(*) FILTER (WHERE outcome = 'success') AS wins, MAX(score) AS best,
                  SUM(CASE WHEN scope = 'personal' THEN score ELSE 0 END) AS total,
                  SUM(COALESCE((score_breakdown::jsonb ->> 'kills')::int, 0)) AS kills
                FROM attempts WHERE user_id = ?`)
      .get<{ missions: number; wins: number | null; best: number | null; total: number | null; kills: number | null }>(user.id),
    aiStatus(),
  ]);
  const kills = stats?.kills ?? 0;

  return {
    user: publicUser(user),
    skill: {
      band: s.band,
      bandLabel: BAND_LABELS[s.band],
      attempts: s.attempts,
      successes: s.successes,
      successStreak: s.successStreak,
      failStreak: s.failStreak,
      tipOffered: last.length === HINT_OFFER_AFTER_FAILS && last.every((l) => l.outcome !== "success"),
    },
    achievements: unlocked.map((x) => ({ ...achievementInfo(x.code), unlockedAt: x.unlocked_at })),
    achievementCount: ACHIEVEMENTS.length,
    openMission: open ? { id: open.id, status: open.status, mode: open.scope } : null,
    recent: recent.map((r) => {
      let cores = 0, coresTotal = 0;
      try { const b = JSON.parse(r.score_breakdown); cores = b.cores ?? 0; coresTotal = b.coresTotal ?? 0; } catch { /* ignore */ }
      return { instanceId: r.instance_id, band: r.band, outcome: r.outcome, score: r.score, mode: r.scope, cores, coresTotal, createdAt: r.created_at };
    }),
    stats: { missions: stats?.missions ?? 0, wins: stats?.wins ?? 0, best: stats?.best ?? 0, total: stats?.total ?? 0, kills },
    narrator: { state: a.state },
  };
}

export type MePayload = Awaited<ReturnType<typeof mePayload>>;
