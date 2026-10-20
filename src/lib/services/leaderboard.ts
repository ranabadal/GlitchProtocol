import { getDb } from "../db";
import { BAND_LABELS, type Band } from "../engine/types";
import { photoUrl } from "./users";
import { eventIsLive, type EventRow } from "./missions";

/*
 * Three separate boards so like is compared with like:
 *  - overall: total points from personal missions (band multipliers are public)
 *  - band:    each player's best single cleared mission at one band
 *  - event:   the single shared-event attempt, identical mission for everyone
 */

export interface BoardRow {
  rank: number;
  userId: string;
  nickname: string;
  avatarId: string;
  photoUrl: string | null;
  level: number;
  score: number;
  detail: string;
  isYou: boolean;
}

interface RawRow {
  id: string;
  nickname: string;
  avatar_id: string;
  photo_file: string | null;
  show_photo: number;
  level: number;
  score: number;
  wins: number;
  missions: number;
  elapsed?: number;
  top_band?: number;
}

function shape(rows: RawRow[], viewerId: string, detail: (r: RawRow) => string): BoardRow[] {
  return rows.map((r, i) => ({
    rank: i + 1,
    userId: r.id,
    nickname: r.nickname,
    avatarId: r.avatar_id,
    photoUrl: r.show_photo === 1 ? photoUrl(r) : null,
    level: r.level,
    score: r.score,
    detail: detail(r),
    isYou: r.id === viewerId,
  }));
}

export async function overallBoard(viewerId: string, limit = 50): Promise<BoardRow[]> {
  const rows = await getDb()
    .prepare(
      `SELECT u.id, u.nickname, u.avatar_id, u.photo_file, u.show_photo, u.level,
              COALESCE(SUM(a.score), 0) AS score, COUNT(*) FILTER (WHERE a.outcome = 'success') AS wins, COUNT(a.id) AS missions, MAX(CASE WHEN a.outcome = 'success' THEN a.band END) AS top_band
       FROM users u JOIN attempts a ON a.user_id = u.id AND a.scope = 'personal'
       GROUP BY u.id, u.nickname, u.avatar_id, u.photo_file, u.show_photo, u.level
       ORDER BY score DESC, wins DESC, MIN(a.created_at) ASC
       LIMIT ?`,
    )
    .all<RawRow>(limit);
  return shape(rows, viewerId, (r) => `${r.missions} missions, ${r.wins} clear${r.top_band ? `, best band ${r.top_band}` : ""}`);
}

export async function bandBoard(viewerId: string, band: Band, limit = 50): Promise<BoardRow[]> {
  const rows = await getDb()
    .prepare(
      `WITH wins AS (
         SELECT user_id, score, elapsed_ms,
                ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY score DESC, elapsed_ms ASC) AS rn,
                COUNT(*) OVER (PARTITION BY user_id) AS wins
         FROM attempts WHERE scope = 'personal' AND band = ? AND outcome = 'success'
       )
       SELECT u.id, u.nickname, u.avatar_id, u.photo_file, u.show_photo, u.level, w.score, w.wins, w.wins AS missions, w.elapsed_ms AS elapsed
       FROM wins w JOIN users u ON u.id = w.user_id
       WHERE w.rn = 1
       ORDER BY w.score DESC, w.elapsed_ms ASC
       LIMIT ?`,
    )
    .all<RawRow>(band, limit);
  return shape(rows, viewerId, (r) => `${BAND_LABELS[band]} band, best run ${Math.round((r.elapsed ?? 0) / 1000)} sec`);
}

export async function eventBoard(viewerId: string, eventId: string, limit = 100): Promise<BoardRow[]> {
  const rows = await getDb()
    .prepare(
      `SELECT u.id, u.nickname, u.avatar_id, u.photo_file, u.show_photo, u.level, a.score, (a.outcome = 'success') AS wins, 1 AS missions, a.elapsed_ms AS elapsed
       FROM attempts a JOIN users u ON u.id = a.user_id
       WHERE a.event_id = ?
       ORDER BY a.score DESC, a.elapsed_ms ASC, a.created_at ASC
       LIMIT ?`,
    )
    .all<RawRow>(eventId, limit);
  return shape(rows, viewerId, (r) => (r.wins ? `Clear in ${Math.round((r.elapsed ?? 0) / 1000)} sec` : "Clear nahi hua"));
}

export async function listEvents(): Promise<{ id: string; code: string; name: string; templateId: string; band: number; live: boolean; endsAt: number }[]> {
  const rows = await getDb().prepare(`SELECT * FROM events ORDER BY created_at DESC LIMIT 20`).all<EventRow>();
  return rows.map((e) => ({ id: e.id, code: e.code, name: e.name, templateId: e.template_id, band: e.band, live: eventIsLive(e), endsAt: e.ends_at }));
}
