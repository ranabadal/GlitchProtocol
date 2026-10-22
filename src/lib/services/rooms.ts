import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { now } from "../clock";
import { getDb, isUniqueViolation, parseJson, type DB } from "../db";
import { HttpError, USER_COLS, type UserRow } from "../http";
import { COUNTDOWN_MS } from "../shared/mission";
import type { Band } from "../engine/types";
import { buildRoomMission, closeOpenMission, createRoomInstance, getSkill } from "./missions";

/*
 * Multiplayer races. One player opens a room and shares its code; friends on other
 * laptops join with it. When the host starts, everyone gets their own copy of the SAME
 * mission (same vaults, puzzles and robots) with the same start time, and sees the
 * others running around the city as live avatars.
 *
 *   solo  - 2 to 4 players. The first to finish the mission (upload complete) wins.
 *           If nobody finishes, the highest score when the clock runs out wins.
 *   teams - Team A vs Team B (up to 4 each). Team score = all members' points; the
 *           first player to finish adds a FIRST_FINISH bonus to their team and ends the
 *           race. Highest team score wins.
 *
 * Every mission event is still judged on the server exactly like single player, so a
 * race can't be won by a tampered client.
 */

export type RoomMode = "solo" | "teams";
export type Team = "A" | "B";
export const MAX_PLAYERS: Record<RoomMode, number> = { solo: 4, teams: 8 };
export const FIRST_FINISH_BONUS = 1000;
/** Time between "Start" and GO, so every laptop can load the city (the 3-2-1 is the last part). */
export const ROOM_LEAD_MS = 14_000 + COUNTDOWN_MS;
/** A lobby nobody touches is closed after this long. */
const LOBBY_TTL_MS = 45 * 60_000;
/** Players whose game hasn't reported in for this long are shown as disconnected. */
const ONLINE_MS = 6000;

const CODE_CHARS = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const newCode = () => Array.from(randomBytes(5), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");

export interface RoomRow {
  id: string;
  code: string;
  host_id: string;
  mode: RoomMode;
  status: "lobby" | "playing" | "finished" | "closed";
  band: Band;
  started_at: number | null;
  deadline_at: number | null;
  winner_user: string | null;
  winner_team: Team | null;
  finish_reason: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

interface PlayerRow {
  room_id: string;
  user_id: string;
  team: Team | null;
  joined_at: number;
  instance_id: string | null;
  score: number;
  cores: number;
  kills: number;
  finished_at: number | null;
  outcome: string | null;
  pose: string | null;
  pose_at: number | null;
  seen_at: number | null;
  nickname: string;
  avatar_id: string;
  level: number;
}

export interface RoomPlayerView {
  userId: string;
  nickname: string;
  avatarId: string;
  level: number;
  team: Team | null;
  host: boolean;
  you: boolean;
  online: boolean;
  score: number;
  cores: number;
  kills: number;
  finished: boolean;
  outcome: string | null;
  finishedAt: number | null;
}

export interface RoomView {
  code: string;
  mode: RoomMode;
  status: RoomRow["status"];
  band: Band;
  hostId: string;
  youAreHost: boolean;
  maxPlayers: number;
  players: RoomPlayerView[];
  teams: { A: number; B: number } | null;
  startedAt: number | null;
  deadline: number | null;
  coresTotal: number | null;
  yourInstanceId: string | null;
  winner: { userId: string | null; nickname: string | null; team: Team | null; reason: string | null } | null;
  serverNow: number;
}

/** Another racer's latest position, as sent by their game. */
export interface RemotePose {
  userId: string;
  nickname: string;
  team: Team | null;
  avatarId: string;
  at: number;
  pose: Pose;
}

export const poseSchema = z.object({
  x: z.number().finite().min(-2000).max(2000),
  y: z.number().finite().min(-50).max(400),
  z: z.number().finite().min(-2000).max(2000),
  /** Facing (radians). */
  h: z.number().finite().min(-100).max(100),
  /** Horizontal speed m/s, drives the run animation. */
  s: z.number().finite().min(0).max(200),
  /** foot | car | heli | train | dead */
  m: z.enum(["foot", "car", "heli", "train", "dead"]),
  /** Vehicle model variant when in a car. */
  v: z.number().int().min(0).max(9).optional(),
  /** Weapon in hand and whether they are shooting / aiming. */
  w: z.enum(["blaster", "scatter", "bomb", "blade"]).optional(),
  f: z.boolean().optional(),
  a: z.number().min(-2).max(2).optional(),
});
export type Pose = z.infer<typeof poseSchema>;

// ---------------------------------------------------------------- helpers

async function lockRoom(db: DB, roomId: string): Promise<void> {
  await db.prepare(`SELECT pg_advisory_xact_lock(hashtext(?))`).get(`room:${roomId}`);
}

async function findRoom(db: DB, code: string): Promise<RoomRow> {
  const c = String(code ?? "").trim().toUpperCase();
  const room = c.length >= 4 && c.length <= 8 ? await db.prepare(`SELECT * FROM rooms WHERE code = ?`).get<RoomRow>(c) : undefined;
  if (!room || room.status === "closed") throw new HttpError(404, "ROOM_NOT_FOUND", "Is code ka koi room nahi mila. Code dobara check karo.");
  return room;
}

async function players(db: DB, roomId: string): Promise<PlayerRow[]> {
  return db
    .prepare(`SELECT rp.*, u.nickname, u.avatar_id, u.level FROM room_players rp JOIN users u ON u.id = rp.user_id WHERE rp.room_id = ? ORDER BY rp.joined_at, rp.user_id`)
    .all<PlayerRow>(roomId);
}

function teamCounts(ps: { team: Team | null }[]): { A: number; B: number } {
  return { A: ps.filter((p) => p.team === "A").length, B: ps.filter((p) => p.team === "B").length };
}

/** Team totals: everyone's points, plus the bonus for the first finisher's team. */
export function teamScores(ps: { team: Team | null; score: number; outcome: string | null; finished_at: number | null }[]): { A: number; B: number } {
  const out = { A: 0, B: 0 };
  let first: { team: Team | null; at: number } | null = null;
  for (const p of ps) {
    if (p.team) out[p.team] += p.score;
    if (p.outcome === "success" && p.finished_at !== null && (!first || p.finished_at < first.at)) first = { team: p.team, at: p.finished_at };
  }
  if (first?.team) out[first.team] += FIRST_FINISH_BONUS;
  return out;
}

async function touch(db: DB, roomId: string): Promise<void> {
  await db.prepare(`UPDATE rooms SET updated_at = ? WHERE id = ?`).run(now(), roomId);
}

/** A player can be in one open room at a time; joining another leaves the old one. */
async function leaveOtherRooms(db: DB, userId: string, keep: string | null): Promise<void> {
  const rows = await db
    .prepare(`SELECT r.* FROM rooms r JOIN room_players rp ON rp.room_id = r.id WHERE rp.user_id = ? AND r.status = 'lobby'`)
    .all<RoomRow>(userId);
  for (const r of rows) if (r.id !== keep) await removeFromLobby(db, r, userId);
}

async function removeFromLobby(db: DB, room: RoomRow, userId: string): Promise<void> {
  await db.prepare(`DELETE FROM room_players WHERE room_id = ? AND user_id = ?`).run(room.id, userId);
  const left = await db.prepare(`SELECT user_id FROM room_players WHERE room_id = ? ORDER BY joined_at LIMIT 1`).get<{ user_id: string }>(room.id);
  if (!left) await db.prepare(`UPDATE rooms SET status = 'closed', updated_at = ? WHERE id = ?`).run(now(), room.id);
  else if (room.host_id === userId) await db.prepare(`UPDATE rooms SET host_id = ?, updated_at = ? WHERE id = ?`).run(left.user_id, now(), room.id);
  else await touch(db, room.id);
}

// ---------------------------------------------------------------- lobby

export async function createRoom(user: UserRow, mode: RoomMode): Promise<RoomView> {
  const db = getDb();
  const skill = await getSkill(db, user.id, "city-heist", user.level);
  const id = randomUUID();
  await db.transaction(async () => {
    await leaveOtherRooms(db, user.id, null);
    const t = now();
    for (let i = 0; i < 6; i++) {
      try {
        await db.prepare(`INSERT INTO rooms (id, code, host_id, mode, status, band, created_at, updated_at) VALUES (?, ?, ?, ?, 'lobby', ?, ?, ?)`)
          .run(id, newCode(), user.id, mode, skill.band, t, t);
        break;
      } catch (err) {
        if (!isUniqueViolation(err, "code") || i === 5) throw err;
      }
    }
    await db.prepare(`INSERT INTO room_players (room_id, user_id, team, joined_at, seen_at) VALUES (?, ?, ?, ?, ?)`).run(id, user.id, mode === "teams" ? "A" : null, t, t);
  });
  const room = (await db.prepare(`SELECT * FROM rooms WHERE id = ?`).get<RoomRow>(id))!;
  return view(db, user, room);
}

export async function joinRoom(user: UserRow, code: string): Promise<RoomView> {
  const db = getDb();
  const found = await findRoom(db, code);
  await db.transaction(async () => {
    await lockRoom(db, found.id);
    const room = (await db.prepare(`SELECT * FROM rooms WHERE id = ?`).get<RoomRow>(found.id))!;
    const ps = await players(db, room.id);
    if (ps.some((p) => p.user_id === user.id)) return;
    if (room.status !== "lobby") throw new HttpError(409, "ROOM_STARTED", "Is room ki race shuru ho chuki hai. Naya room banao ya agli race ka wait karo.");
    if (ps.length >= MAX_PLAYERS[room.mode]) throw new HttpError(409, "ROOM_FULL", `Room full hai (${MAX_PLAYERS[room.mode]} players).`);
    await leaveOtherRooms(db, user.id, room.id);
    const c = teamCounts(ps);
    const team: Team | null = room.mode === "teams" ? (c.A <= c.B ? "A" : "B") : null;
    const t = now();
    await db.prepare(`INSERT INTO room_players (room_id, user_id, team, joined_at, seen_at) VALUES (?, ?, ?, ?, ?)`).run(room.id, user.id, team, t, t);
    await touch(db, room.id);
  }, `room:${found.id}`);
  return getRoom(user, code);
}

export async function setTeam(user: UserRow, code: string, team: Team): Promise<RoomView> {
  const db = getDb();
  const room = await findRoom(db, code);
  if (room.mode !== "teams") throw new HttpError(409, "NOT_TEAMS", "Ye solo race hai, isme teams nahi hain.");
  if (room.status !== "lobby") throw new HttpError(409, "ROOM_STARTED", "Race shuru hone ke baad team nahi badal sakte.");
  await db.transaction(async () => {
    const ps = await players(db, room.id);
    const me = ps.find((p) => p.user_id === user.id);
    if (!me) throw new HttpError(403, "NOT_IN_ROOM", "Pehle room join karo.");
    if (me.team === team) return;
    if (teamCounts(ps)[team] >= MAX_PLAYERS.teams / 2) throw new HttpError(409, "TEAM_FULL", `Team ${team} full hai.`);
    await db.prepare(`UPDATE room_players SET team = ? WHERE room_id = ? AND user_id = ?`).run(team, room.id, user.id);
    await touch(db, room.id);
  }, `room:${room.id}`);
  return getRoom(user, code);
}

export async function leaveRoom(user: UserRow, code: string): Promise<{ ok: true }> {
  const db = getDb();
  const room = await findRoom(db, code);
  await db.transaction(async () => {
    const r = (await db.prepare(`SELECT * FROM rooms WHERE id = ?`).get<RoomRow>(room.id))!;
    if (r.status === "lobby") await removeFromLobby(db, r, user.id);
  }, `room:${room.id}`);
  // During a race, leaving means giving up: the page aborts the mission itself.
  return { ok: true };
}

export async function startRoom(user: UserRow, code: string): Promise<RoomView> {
  const db = getDb();
  const found = await findRoom(db, code);
  await db.transaction(async () => {
    const room = (await db.prepare(`SELECT * FROM rooms WHERE id = ?`).get<RoomRow>(found.id))!;
    if (room.status !== "lobby") return;
    if (room.host_id !== user.id) throw new HttpError(403, "NOT_HOST", "Sirf room banane wala (host) race start kar sakta hai.");
    const ps = await players(db, room.id);
    if (ps.length < 2) throw new HttpError(409, "NEED_PLAYERS", "Race ke liye kam se kam 2 players chahiye. Code dosto ko bhejo!");
    if (room.mode === "teams") {
      const c = teamCounts(ps);
      if (!c.A || !c.B) throw new HttpError(409, "NEED_TEAMS", "Dono teams mein kam se kam 1 player hona chahiye.");
    }
    const built = buildRoomMission(room.band);
    const startAt = now() + ROOM_LEAD_MS;
    for (const p of ps) {
      const u = (await db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get<UserRow>(p.user_id))!;
      await closeOpenMission(db, u.id);
      const inst = await createRoomInstance(db, u, built, room.id, startAt);
      await db.prepare(`UPDATE room_players SET instance_id = ?, score = 0, cores = 0, kills = 0, finished_at = NULL, outcome = NULL WHERE room_id = ? AND user_id = ?`).run(inst, room.id, u.id);
    }
    const t = now();
    await db.prepare(`UPDATE rooms SET status = 'playing', started_at = ?, deadline_at = ?, updated_at = ? WHERE id = ?`)
      .run(startAt, startAt + built.puzzle.timeLimitSec * 1000, t, room.id);
  }, `room:${found.id}`);
  return getRoom(user, code);
}

// ---------------------------------------------------------------- state

export async function getRoom(user: UserRow, code: string): Promise<RoomView> {
  const db = getDb();
  let room = await findRoom(db, code);
  // The lobby page polls this: it doubles as "I'm still here".
  await db.prepare(`UPDATE room_players SET seen_at = ? WHERE room_id = ? AND user_id = ?`).run(now(), room.id, user.id);
  room = await expire(db, room);
  return view(db, user, room);
}

/** Close idle lobbies and settle races whose clock ran out without a finisher. */
async function expire(db: DB, room: RoomRow): Promise<RoomRow> {
  const t = now();
  if (room.status === "lobby" && t - room.updated_at > LOBBY_TTL_MS) {
    await db.prepare(`UPDATE rooms SET status = 'closed', updated_at = ? WHERE id = ? AND status = 'lobby'`).run(t, room.id);
    throw new HttpError(404, "ROOM_NOT_FOUND", "Ye room band ho gaya (bahut der khali tha). Naya room banao.");
  }
  if (room.status === "playing" && room.deadline_at !== null && t > room.deadline_at + 5000) {
    await db.transaction(async () => {
      await lockRoom(db, room.id);
      const fresh = (await db.prepare(`SELECT * FROM rooms WHERE id = ?`).get<RoomRow>(room.id))!;
      if (fresh.status === "playing") await settle(db, fresh, "time");
    });
    return (await db.prepare(`SELECT * FROM rooms WHERE id = ?`).get<RoomRow>(room.id))!;
  }
  return room;
}

async function view(db: DB, user: UserRow, room: RoomRow, ps?: PlayerRow[]): Promise<RoomView> {
  ps ??= await players(db, room.id);
  const t = now();
  const me = ps.find((p) => p.user_id === user.id);
  let coresTotal: number | null = null;
  if (me?.instance_id && room.status !== "lobby") {
    const inst = await db.prepare(`SELECT mission_public FROM mission_instances WHERE id = ?`).get<{ mission_public: string }>(me.instance_id);
    const m = parseJson<{ vaults: unknown[]; courier?: unknown }>(inst?.mission_public, { vaults: [] });
    coresTotal = m.vaults.length + (m.courier ? 1 : 0);
  }
  const winnerName = room.winner_user ? ps.find((p) => p.user_id === room.winner_user)?.nickname ?? null : null;
  return {
    code: room.code,
    mode: room.mode,
    status: room.status,
    band: room.band,
    hostId: room.host_id,
    youAreHost: room.host_id === user.id,
    maxPlayers: MAX_PLAYERS[room.mode],
    players: ps.map((p) => ({
      userId: p.user_id,
      nickname: p.nickname,
      avatarId: p.avatar_id,
      level: p.level,
      team: p.team,
      host: p.user_id === room.host_id,
      you: p.user_id === user.id,
      online: p.seen_at !== null && t - p.seen_at < (room.status === "lobby" ? 20_000 : ONLINE_MS),
      score: p.score,
      cores: p.cores,
      kills: p.kills,
      finished: p.finished_at !== null,
      outcome: p.outcome,
      finishedAt: p.finished_at,
    })),
    teams: room.mode === "teams" ? teamScores(ps) : null,
    startedAt: room.started_at,
    deadline: room.deadline_at,
    coresTotal,
    yourInstanceId: me?.instance_id ?? null,
    winner: room.status === "finished" ? { userId: room.winner_user, nickname: winnerName, team: room.winner_team, reason: room.finish_reason } : null,
    serverNow: t,
  };
}

/**
 * Called by the game several times a second during a race: stores this player's position
 * and answers with everyone else's, plus the live scoreboard.
 */
export async function syncRoom(user: UserRow, code: string, raw: unknown): Promise<{ room: RoomView; others: RemotePose[] }> {
  const db = getDb();
  let room = await findRoom(db, code);
  const pose = raw && typeof raw === "object" && "pose" in raw ? poseSchema.safeParse((raw as { pose: unknown }).pose) : null;
  const t = now();
  if (pose && !pose.success) throw new HttpError(400, "BAD_POSE", "Position sahi format mein nahi hai.");
  if (pose?.success) {
    await db.prepare(`UPDATE room_players SET pose = ?, pose_at = ?, seen_at = ? WHERE room_id = ? AND user_id = ?`).run(JSON.stringify(pose.data), t, t, room.id, user.id);
  } else {
    await db.prepare(`UPDATE room_players SET seen_at = ? WHERE room_id = ? AND user_id = ?`).run(t, room.id, user.id);
  }
  room = await expire(db, room);
  const ps = await players(db, room.id);
  if (!ps.some((p) => p.user_id === user.id)) throw new HttpError(403, "NOT_IN_ROOM", "Tum is room mein nahi ho.");
  const others: RemotePose[] = [];
  for (const p of ps) {
    if (p.user_id === user.id || !p.pose || p.pose_at === null || t - p.pose_at > ONLINE_MS) continue;
    const ps2 = parseJson<Pose | null>(p.pose, null);
    if (ps2) others.push({ userId: p.user_id, nickname: p.nickname, team: p.team, avatarId: p.avatar_id, at: p.pose_at, pose: ps2 });
  }
  return { room: await view(db, user, room, ps), others };
}

// ---------------------------------------------------------------- hooks from the mission service

/** True once the race is over (someone won or time ran out). Used to end the other racers' runs. */
export async function roomEnded(db: DB, roomId: string): Promise<boolean> {
  const r = await db.prepare(`SELECT status FROM rooms WHERE id = ?`).get<{ status: string }>(roomId);
  return r?.status === "finished";
}

/** Live scoreboard numbers, copied after every accepted mission event. */
export async function roomProgress(db: DB, roomId: string, userId: string, score: number, cores: number, kills: number): Promise<void> {
  await db.prepare(`UPDATE room_players SET score = ?, cores = ?, kills = ? WHERE room_id = ? AND user_id = ? AND finished_at IS NULL`).run(score, cores, kills, roomId, userId);
}

/** A racer's mission ended (won, failed, timed out or quit). May end the race. Runs in the finishing transaction. */
export async function roomPlayerFinished(db: DB, roomId: string, userId: string, outcome: string, total: number, cores: number, kills: number, at: number): Promise<void> {
  await lockRoom(db, roomId);
  await db.prepare(`UPDATE room_players SET score = ?, cores = ?, kills = ?, finished_at = ?, outcome = ? WHERE room_id = ? AND user_id = ? AND finished_at IS NULL`)
    .run(total, cores, kills, at, outcome, roomId, userId);
  const room = await db.prepare(`SELECT * FROM rooms WHERE id = ?`).get<RoomRow>(roomId);
  if (!room || room.status !== "playing") return;
  if (outcome === "success") return settle(db, room, "first");
  const ps = await players(db, roomId);
  if (ps.every((p) => p.finished_at !== null)) await settle(db, room, "all");
}

/** Decide the winner and close the race. */
async function settle(db: DB, room: RoomRow, reason: "first" | "time" | "all"): Promise<void> {
  const ps = await players(db, room.id);
  const finishers = ps.filter((p) => p.outcome === "success" && p.finished_at !== null).sort((a, b) => a.finished_at! - b.finished_at!);
  let winnerUser: string | null = null;
  let winnerTeam: Team | null = null;
  if (room.mode === "solo") {
    winnerUser = finishers[0]?.user_id ?? [...ps].sort((a, b) => b.score - a.score || a.joined_at - b.joined_at)[0]?.user_id ?? null;
    // A draw on points with nobody finishing: no winner.
    const sorted = [...ps].sort((a, b) => b.score - a.score);
    if (!finishers.length && sorted.length > 1 && sorted[0].score === sorted[1].score) winnerUser = null;
  } else {
    const s = teamScores(ps);
    winnerTeam = s.A === s.B ? null : s.A > s.B ? "A" : "B";
    winnerUser = finishers[0]?.user_id ?? null;
  }
  const t = now();
  await db.prepare(`UPDATE rooms SET status = 'finished', winner_user = ?, winner_team = ?, finish_reason = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'playing'`)
    .run(winnerUser, winnerTeam, reason, t, t, room.id);
  const winners = room.mode === "solo" ? (winnerUser ? [winnerUser] : []) : ps.filter((p) => p.team && p.team === winnerTeam).map((p) => p.user_id);
  for (const uid of winners) {
    await db.prepare(`INSERT INTO achievements (user_id, code, unlocked_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`).run(uid, room.mode === "solo" ? "RACE_WINNER" : "TEAM_WIN", t);
  }
}

/** For the hub: the room this player is in right now, if any. */
export async function myRoom(userId: string): Promise<{ code: string; status: string; mode: RoomMode } | null> {
  const db = getDb();
  const r = await db
    .prepare(`SELECT r.code, r.status, r.mode FROM rooms r JOIN room_players rp ON rp.room_id = r.id WHERE rp.user_id = ? AND r.status IN ('lobby','playing') ORDER BY r.created_at DESC LIMIT 1`)
    .get<{ code: string; status: string; mode: RoomMode }>(userId);
  return r ?? null;
}
