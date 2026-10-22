import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __setAiClientForTests, type ChatClient } from "@/lib/ai/client";
import { __advanceClockForTests, __resetClockForTests, now } from "@/lib/clock";
import { __setDbForTests, getDb, openDatabase, type DB } from "@/lib/db";
import { HACKS } from "@/lib/engine/hacks";
import { USER_COLS, type UserRow } from "@/lib/http";
import { beginMission, postEvent, startMission, type MissionView } from "@/lib/services/missions";
import { registerUser } from "@/lib/services/users";
import { COUNTDOWN_MS, courierPos, type MissionPublic, type Pt } from "@/lib/shared/mission";

let counter = 0;

/**
 * Fresh database per test (PGlite = real Postgres in WebAssembly). In memory by default;
 * pass persistent=true for an on-disk one, so a server restart can be simulated by reopening it.
 */
let shared: DB | null = null;
const TABLES = "users, sessions, skill_state, events, rooms, room_players, mission_instances, attempts, achievements, ai_cache, counters";
/** Run the suites against a real Postgres server instead: TEST_DATABASE_URL=postgres://... npx vitest run --no-file-parallelism */
const PG_URL = process.env.TEST_DATABASE_URL?.trim() || null;

export async function freshDb(persistent = false): Promise<string> {
  const prev = (globalThis as { __gpDb?: DB }).__gpDb;
  if (prev && prev !== shared) await prev.close().catch(() => {});
  __resetClockForTests();
  __setAiClientForTests(null);
  if (persistent && !PG_URL) {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gp-test-")), "pg");
    const db = openDatabase(dir);
    await db.ready;
    __setDbForTests(db);
    return dir;
  }
  // One database per test file, emptied before each test (starting Postgres is the slow part).
  if (!shared) { shared = openDatabase(PG_URL ?? ":memory:"); await shared.ready; }
  await shared.exec(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
  __setDbForTests(shared);
  return PG_URL ?? ":memory:";
}

export async function restartDb(target: string): Promise<void> {
  const cur = getDb();
  await cur.close();
  if (cur === shared) shared = null;
  const db = openDatabase(target);
  await db.ready;
  __setDbForTests(db);
}

export async function makeUser(nick?: string, avatarId = "viper"): Promise<UserRow> {
  const nickname = nick ?? `tester${++counter}${Math.floor(Math.random() * 1000)}`;
  return registerUser({ nickname, password: "correct horse battery", avatarId });
}

export async function reloadUser(id: string): Promise<UserRow> {
  return (await getDb().prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get<UserRow>(id))!;
}

export function fakeAi(reply: (body: Record<string, unknown>) => unknown | Promise<unknown>): { client: ChatClient; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const client: ChatClient = { chat: { completions: { create: async (body) => { calls.push(body); return reply(body); } } } };
  __setAiClientForTests(client);
  return { client, calls };
}

export function aiReply(obj: unknown) {
  return { choices: [{ message: { content: JSON.stringify(obj), refusal: null } }] };
}

export const SITE = "http://localhost:3000";

export function req(method: string, url: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}): Request {
  return new Request(SITE + url, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), host: "localhost:3000", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export function cookieFrom(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

export const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

// ---------------------------------------------------------------- simulated player

/** Move the test clock as if the player drove from a to b at a realistic 25 m/s. */
export function travel(a: Pt, b: Pt, speed = 25): void {
  __advanceClockForTests(Math.ceil((Math.hypot(a.x - b.x, a.z - b.z) / speed) * 1000) + 200);
}

export function wrongPick(type: keyof typeof HACKS, round: any): unknown {
  if (type === "power") return { rot: round.rot.slice() };
  const right = HACKS[type].solve(round) as { index: number };
  return { index: right.index === 0 ? 1 : 0 };
}

export interface PlayOptions {
  /** Return false to answer this vault's hack attempt wrongly. */
  hackRight?: (vaultIndex: number, attempt: number) => boolean;
  /** Robots to report as destroyed: "start" ones by default. */
  killStart?: boolean;
  /** Stop after this many vaults (to leave a mission unfinished). */
  stopAfterVaults?: number;
  /** Lose this many lives during the run. */
  downs?: number;
  /** Skip the upload. */
  skipUplink?: boolean;
  /** Also collect every bonus data shard. */
  shards?: boolean;
}

/** Drive to wherever the data truck will be when we get there, at a realistic speed. */
export function chaseTruck(m: MissionPublic, from: Pt, startedAt: number): Pt {
  const c = m.courier!;
  let t = now();
  for (let i = 0; i < 4; i++) {
    const p = courierPos(c, (t - startedAt) / 1000);
    t = now() + Math.ceil((Math.hypot(p.x - from.x, p.z - from.z) / 25) * 1000) + 200;
  }
  __advanceClockForTests(t - now());
  return courierPos(c, (now() - startedAt) / 1000);
}

/** Plays a whole mission through the event API, like an honest player would. */
export async function playMission(userId: string, opts: PlayOptions = {}): Promise<MissionView> {
  let view = await startMission(await reloadUser(userId), { mode: "personal" });
  view = await beginMission(await reloadUser(userId), view.id);
  __advanceClockForTests(COUNTDOWN_MS + 100);
  return playStarted(userId, view.id, view.mission, opts, view.startedAt!);
}

export async function playStarted(userId: string, id: string, m: MissionPublic, opts: PlayOptions = {}, startedAt = now() - 100): Promise<MissionView> {
  const send = async (ev: unknown) => postEvent(await reloadUser(userId), id, ev);
  const killed = new Set<string>();
  let at: Pt = m.start;
  let view: MissionView | null = null;
  if (opts.killStart !== false) {
    const startRobots = m.groups.filter((g) => g.release === "start").flatMap((g) => g.spawns.map((s) => s.id));
    for (let i = 0; i < startRobots.length; i += 8) {
      const r = await send({ type: "kill", robots: startRobots.slice(i, i + 8) });
      for (const k of r.outcome.killed ?? []) killed.add(k.id);
      __advanceClockForTests(1100);
    }
  }
  for (let d = 1; d <= (opts.downs ?? 0); d++) view = (await send({ type: "down", n: d })).view;
  if (view && view.status !== "active") return view;
  const vaults = m.vaults.slice(0, opts.stopAfterVaults ?? m.vaults.length);
  for (const [vi, v] of vaults.entries()) {
    if (v.lock === "titan") {
      // No hack here: the Titan holds the lock. Bring it down, then take the core.
      travel(at, v.door);
      at = v.door;
      if (!killed.has(v.guard!)) { await send({ type: "kill", robots: [v.guard!] }); killed.add(v.guard!); __advanceClockForTests(1100); }
      travel(at, v.core);
      at = v.core;
      view = (await send({ type: "pickup", vault: v.id })).view;
      continue;
    }
    travel(at, v.terminal);
    at = v.terminal;
    for (let attempt = 0; attempt < 3; attempt++) {
      const s = (await send({ type: "hack_start", vault: v.id })).outcome.hack!;
      __advanceClockForTests(1500);
      const right = opts.hackRight ? opts.hackRight(vi, attempt) : true;
      const pick = right ? HACKS[v.hackType].solve(s.round) : wrongPick(v.hackType, s.round);
      const j = (await send({ type: "hack_answer", vault: v.id, attempt, pick })).outcome.judge!;
      if (j.correct) break;
      if (j.bruteUntil) { __advanceClockForTests(m.bruteForceSec * 1000 + 100); break; }
    }
    view = (await send({ type: "pickup", vault: v.id })).view;
    at = v.core;
  }
  if (opts.stopAfterVaults !== undefined) return view!;
  if (m.courier) {
    at = chaseTruck(m, at, startedAt);
    const k = await send({ type: "kill", robots: [m.courier.id] });
    const drop = k.view.progress.courierDrop ?? at;
    travel(at, drop);
    at = drop;
    view = (await send({ type: "pickup", vault: m.courier.id })).view;
  }
  if (opts.shards) {
    for (const s of m.shards ?? []) {
      travel(at, s);
      at = s;
      view = (await send({ type: "shard", id: s.id })).view;
    }
  }
  if (opts.skipUplink) return view!;
  travel(at, m.uplink);
  await send({ type: "uplink_start" });
  __advanceClockForTests(m.uploadSec * 1000 + 100);
  return (await send({ type: "uplink_done" })).view;
}
