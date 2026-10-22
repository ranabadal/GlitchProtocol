import { randomUUID } from "node:crypto";
import { z } from "zod";
import { now } from "../clock";
import { getDb, isUniqueViolation, parseJson, type DB } from "../db";
import { HttpError, USER_COLS, type UserRow } from "../http";
import { bankEntriesFor } from "../engine/bank";
import { applyOutcome, focusTagsFrom, freshSkill, HINT_OFFER_AFTER_FAILS, type DifficultyPref, type SkillState } from "../engine/difficulty";
import { GenerationError, generateFromSeed, getTemplate, selectInstance, type PlayHistory } from "../engine/generator";
import { HACKS } from "../engine/hacks";
import { describeTag, fallbackFeedback, fallbackNarrative, type Narrative } from "../engine/narratives";
import { newSeed } from "../engine/rng";
import { clearBonuses, corePoints, hackPoints, killPoints, levelForXp, SCORING, shardPoints, starsFor } from "../engine/scoring";
import type { HeistKey } from "../engine/templates/cityHeist";
import { BAND_LABELS, RULESET_VERSION, type Band, type GeneratedMission, type GenInputs, type TemplateId } from "../engine/types";
import { coreIds, COUNTDOWN_MS, courierPos, MAX_TRAVEL_SPEED, TRAVEL_SLACK_MS, type MissionPublic, type Pt, type RobotKind } from "../shared/mission";
import { checkAchievements } from "./achievements";
import { roomPlayerFinished, roomProgress, roomEnded } from "./rooms";

/** How long an unstarted briefing stays reserved before it is released. */
export const BRIEFING_TTL_MS = 30 * 60_000;
const TEMPLATE: TemplateId = "city-heist";

export interface InstanceRow {
  id: string;
  template_id: TemplateId;
  template_version: number;
  ruleset_version: string;
  seed: string;
  gen_attempt: number;
  gen_inputs: string;
  scope: "personal" | "event" | "room";
  user_id: string;
  event_id: string | null;
  room_id: string | null;
  band: Band;
  variant: string;
  fingerprint: string;
  tags: string;
  mission_public: string;
  mission_key: string;
  narrative: string;
  narrative_source: string;
  time_limit_sec: number;
  status: "briefing" | "active" | "completed" | "failed" | "abandoned";
  state: string;
  version: number;
  created_at: number;
  started_at: number | null;
  deadline_at: number | null;
  expires_at: number | null;
  finished_at: number | null;
}

export interface AttemptRow {
  id: string;
  instance_id: string;
  user_id: string;
  template_id: TemplateId;
  band: Band;
  scope: string;
  event_id: string | null;
  outcome: "success" | "fail" | "timeout" | "abandoned";
  elapsed_ms: number;
  score: number;
  xp_awarded: number;
  score_breakdown: string;
  mistake_tags: string;
  detail: string;
  ruleset_version: string;
  feedback: string | null;
  feedback_source: string | null;
  created_at: number;
}

export interface EventRow {
  id: string;
  code: string;
  name: string;
  template_id: TemplateId;
  band: Band;
  seed: string;
  gen_attempt: number;
  fingerprint: string;
  created_at: number;
  starts_at: number;
  ends_at: number;
  active: number;
}

// ---------------------------------------------------------------- live mission state

export interface HackResult {
  attempt: number;
  correct: boolean;
  timeout: boolean;
  ms: number;
  points: number;
  explain: string;
  tag: string;
  reveal: unknown;
}

export interface VaultState {
  attempt: number;
  started: { attempt: number; at: number } | null;
  results: HackResult[];
  bruteUntil: number | null;
}

export interface MissionState {
  lives: number;
  downs: number;
  hack: Record<string, VaultState>;
  unlocked: Record<string, { at: number; via: "hack" | "brute" | "titan" }>;
  picked: Record<string, number>;
  released: string[];
  kills: Record<string, number>;
  killTimes: number[];
  anchor: { x: number; z: number; at: number };
  uplink: { startedAt: number | null; doneAt: number | null };
  points: { cores: number; hacks: number; kills: number; shards: number };
  mistakes: string[];
  /** Bonus data shards collected (id -> time). */
  shards: Record<string, number>;
  /** Where the data truck was destroyed (its core drops there). */
  courierDrop: Pt | null;
}

function initialState(m: MissionPublic): MissionState {
  return {
    lives: m.lives,
    downs: 0,
    hack: Object.fromEntries(m.vaults.map((v) => [v.id, { attempt: 0, started: null, results: [], bruteUntil: null }])),
    unlocked: {},
    picked: {},
    released: ["start"],
    kills: {},
    killTimes: [],
    anchor: { x: m.start.x, z: m.start.z, at: 0 },
    uplink: { startedAt: null, doneAt: null },
    points: { cores: 0, hacks: 0, kills: 0, shards: 0 },
    mistakes: [],
    shards: {},
    courierDrop: null,
  };
}

/** Stored state, with fields added in later versions filled in for missions saved before them. */
function loadState(raw: string | null | undefined, m: MissionPublic): MissionState {
  const st = parseJson<MissionState>(raw, initialState(m));
  st.shards ??= {};
  st.courierDrop ??= null;
  st.points.shards ??= 0;
  return st;
}

const runningScore = (s: MissionState) => s.points.cores + s.points.hacks + s.points.kills + (s.points.shards ?? 0);

// ---------------------------------------------------------------- skills & history

export async function getSkill(db: DB, userId: string, templateId: TemplateId, level: number): Promise<SkillState> {
  const row = await db.prepare(`SELECT * FROM skill_state WHERE user_id = ? AND template_id = ?`).get(userId, templateId) as
    | { band: Band; success_streak: number; fail_streak: number; attempts: number; successes: number }
    | undefined;
  if (!row) return freshSkill(level);
  return { band: row.band, successStreak: row.success_streak, failStreak: row.fail_streak, attempts: row.attempts, successes: row.successes };
}

async function saveSkill(db: DB, userId: string, templateId: TemplateId, s: SkillState): Promise<void> {
  await db.prepare(
    `INSERT INTO skill_state (user_id, template_id, band, success_streak, fail_streak, attempts, successes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, template_id) DO UPDATE SET band = excluded.band, success_streak = excluded.success_streak,
       fail_streak = excluded.fail_streak, attempts = excluded.attempts, successes = excluded.successes, updated_at = excluded.updated_at`,
  ).run(userId, templateId, s.band, s.successStreak, s.failStreak, s.attempts, s.successes, now());
}

export async function loadHistory(db: DB, userId: string, templateId: TemplateId): Promise<PlayHistory> {
  const rows = await db
    .prepare(`SELECT fingerprint, variant, created_at FROM mission_instances WHERE user_id = ? AND template_id = ? AND scope = 'personal' ORDER BY created_at DESC, seq DESC LIMIT 500`)
    .all(userId, templateId) as { fingerprint: string; variant: string; created_at: number }[];
  const fingerprints = new Map<string, number>();
  for (const r of rows) if (!fingerprints.has(r.fingerprint)) fingerprints.set(r.fingerprint, r.created_at);
  return { fingerprints, recentVariants: rows.map((r) => r.variant) };
}

async function recentMistakeTags(db: DB, userId: string, templateId: TemplateId): Promise<string[][]> {
  const rows = await db
    .prepare(`SELECT mistake_tags FROM attempts WHERE user_id = ? AND template_id = ? AND scope = 'personal' ORDER BY created_at DESC, seq DESC LIMIT 4`)
    .all(userId, templateId) as { mistake_tags: string }[];
  return rows.map((r) => parseJson<string[]>(r.mistake_tags, []));
}

async function recentFailStreak(db: DB, userId: string, templateId: TemplateId): Promise<number> {
  const rows = await db
    .prepare(`SELECT outcome FROM attempts WHERE user_id = ? AND template_id = ? AND scope = 'personal' ORDER BY created_at DESC, seq DESC LIMIT 5`)
    .all(userId, templateId) as { outcome: string }[];
  let n = 0;
  for (const r of rows) { if (r.outcome === "success") break; n++; }
  return n;
}

// ---------------------------------------------------------------- instance lookup & lifecycle

async function getInstance(db: DB, id: string): Promise<InstanceRow | undefined> {
  return await db.prepare(`SELECT * FROM mission_instances WHERE id = ?`).get(id) as InstanceRow | undefined;
}

async function ownedInstance(db: DB, user: UserRow, id: string): Promise<InstanceRow> {
  const inst = typeof id === "string" && id.length <= 64 ? await getInstance(db, id) : undefined;
  if (!inst || inst.user_id !== user.id) throw new HttpError(404, "MISSION_NOT_FOUND", "Ye mission nahi mila.");
  return inst;
}

/** Lazily close missions whose timer or reservation has run out. */
async function refresh(db: DB, inst: InstanceRow): Promise<InstanceRow> {
  const t = now();
  if (inst.status === "briefing" && inst.expires_at !== null && t > inst.expires_at) {
    await db.prepare(`UPDATE mission_instances SET status = 'abandoned', finished_at = ? WHERE id = ? AND status = 'briefing'`).run(t, inst.id);
    return (await getInstance(db, inst.id))!;
  }
  if (inst.status === "active" && inst.room_id && (await roomEnded(db, inst.room_id))) {
    // Someone else won the race: this player's run ends here (points so far still count).
    await db.transaction(async () => {
      const fresh = (await getInstance(db, inst.id))!;
      if (fresh.status !== "active") return;
      await finishMission(db, fresh, loadState(fresh.state, JSON.parse(fresh.mission_public)), "fail", t);
    }, `mission:${inst.id}`);
    return (await getInstance(db, inst.id))!;
  }
  if (inst.status === "active" && inst.deadline_at !== null && t > inst.deadline_at + SCORING.graceMs) {
    await db.transaction(async () => {
      const fresh = (await getInstance(db, inst.id))!;
      if (fresh.status !== "active") return;
      const st = loadState(fresh.state, JSON.parse(fresh.mission_public));
      await finishMission(db, fresh, st, "timeout", fresh.deadline_at!);
    }, `mission:${inst.id}`);
    return (await getInstance(db, inst.id))!;
  }
  return inst;
}

async function openInstance(db: DB, userId: string): Promise<InstanceRow | undefined> {
  const inst = await db.prepare(`SELECT * FROM mission_instances WHERE user_id = ? AND status IN ('briefing','active')`).get(userId) as InstanceRow | undefined;
  if (!inst) return undefined;
  const r = await refresh(db, inst);
  return r.status === "briefing" || r.status === "active" ? r : undefined;
}

export type StartRequest = { mode: "personal" } | { mode: "event"; eventCode: string };

export async function findEvent(db: DB, code: string): Promise<EventRow | undefined> {
  return await db.prepare(`SELECT * FROM events WHERE code = ?`).get(code.trim().toUpperCase()) as EventRow | undefined;
}

export function eventIsLive(ev: EventRow): boolean {
  const t = now();
  return ev.active === 1 && t >= ev.starts_at && t <= ev.ends_at;
}

export interface Built {
  seed: string;
  attempt: number;
  inputs: GenInputs;
  puzzle: GeneratedMission;
  scope: "personal" | "event" | "room";
  eventId: string | null;
  firstTime: boolean;
  source: string;
}

async function buildPersonal(db: DB, user: UserRow): Promise<Built> {
  const template = getTemplate(TEMPLATE)!;
  const skill = await getSkill(db, user.id, TEMPLATE, user.level);
  const inputs: GenInputs = { band: skill.band, focusTags: focusTagsFrom(await recentMistakeTags(db, user.id, TEMPLATE)) };
  const history = await loadHistory(db, user.id, TEMPLATE);
  const seed = newSeed();
  try {
    const sel = selectInstance(template, seed, inputs, history);
    return { seed, attempt: sel.attempt, inputs, puzzle: sel.puzzle, scope: "personal", eventId: null, firstTime: skill.attempts === 0, source: sel.status };
  } catch (err) {
    if (!(err instanceof GenerationError)) throw err;
    return buildFromBank(skill.band, history, skill.attempts === 0);
  }
}

/** Verified-bank fallback: prefer an entry this player has not seen yet. */
export function buildFromBank(band: Band, history: PlayHistory, firstTime: boolean): Built {
  const template = getTemplate(TEMPLATE)!;
  const inputs: GenInputs = { band, focusTags: [] };
  let seen: Built | null = null;
  for (const e of bankEntriesFor(TEMPLATE, band)) {
    const r = generateFromSeed(template, e.seed, e.attempt, inputs);
    if (!r.ok) continue;
    const built: Built = { seed: e.seed, attempt: e.attempt, inputs, puzzle: r.puzzle, scope: "personal", eventId: null, firstTime, source: "bank" };
    if (!history.fingerprints.has(r.puzzle.fingerprint)) return built;
    seen ??= built;
  }
  if (seen) return seen;
  throw new HttpError(503, "NO_MISSION", "Abhi mission ban nahi pa raha. Thodi der baad try karo.");
}

function buildEvent(ev: EventRow): Built {
  const template = getTemplate(ev.template_id)!;
  const inputs: GenInputs = { band: ev.band, focusTags: [] };
  const r = generateFromSeed(template, ev.seed, ev.gen_attempt, inputs);
  if (!r.ok || r.puzzle.fingerprint !== ev.fingerprint) {
    throw new HttpError(500, "EVENT_INTEGRITY", "Is event ka mission match nahi ho raha. Operator se naya event banwao.");
  }
  return { seed: ev.seed, attempt: ev.gen_attempt, inputs, puzzle: r.puzzle, scope: "event", eventId: ev.id, firstTime: false, source: "event" };
}

/** One mission for everyone in a multiplayer room (fresh seed, verified bank as fallback). */
export function buildRoomMission(band: Band): Built {
  const template = getTemplate(TEMPLATE)!;
  const inputs: GenInputs = { band, focusTags: [] };
  const empty: PlayHistory = { fingerprints: new Map(), recentVariants: [] };
  const seed = newSeed();
  try {
    const sel = selectInstance(template, seed, inputs, empty);
    return { seed, attempt: sel.attempt, inputs, puzzle: sel.puzzle, scope: "room", eventId: null, firstTime: false, source: sel.status };
  } catch (err) {
    if (!(err instanceof GenerationError)) throw err;
    return { ...buildFromBank(band, empty, false), scope: "room" };
  }
}

/** Ends whatever single-player mission this player still has open (a room start takes over). */
export async function closeOpenMission(db: DB, userId: string): Promise<void> {
  const open = await db.prepare(`SELECT * FROM mission_instances WHERE user_id = ? AND status IN ('briefing','active')`).get<InstanceRow>(userId);
  if (!open) return;
  await db.prepare(`SELECT pg_advisory_xact_lock(hashtext(?))`).get(`mission:${open.id}`);
  if (open.status === "briefing") {
    await db.prepare(`UPDATE mission_instances SET status = 'abandoned', finished_at = ? WHERE id = ? AND status = 'briefing'`).run(now(), open.id);
  } else {
    await finishMission(db, open, loadState(open.state, JSON.parse(open.mission_public)), "abandoned", now());
  }
}

/**
 * Creates this player's copy of the room's mission, already running: every racer gets the
 * same city, vaults and puzzles, and the same start time and deadline.
 */
export async function createRoomInstance(db: DB, user: UserRow, built: Built, roomId: string, startAt: number): Promise<string> {
  const template = getTemplate(TEMPLATE)!;
  const p = built.puzzle;
  const mission = p.publicPuzzle as MissionPublic;
  const narrative: Narrative = fallbackNarrative({
    seed: p.fingerprint, callsign: user.nickname, level: user.level, band: built.inputs.band, focusTags: [], firstTime: false,
  });
  const st = initialState(mission);
  st.anchor.at = startAt;
  const id = randomUUID();
  const t = now();
  await db.prepare(
    `INSERT INTO mission_instances (id, template_id, template_version, ruleset_version, seed, gen_attempt, gen_inputs, scope, user_id, event_id, room_id,
       band, variant, fingerprint, tags, mission_public, mission_key, narrative, narrative_source, time_limit_sec, status, state,
       created_at, started_at, deadline_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'room', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'fallback', ?, 'active', ?, ?, ?, ?)`,
  ).run(
    id, TEMPLATE, template.version, RULESET_VERSION, built.seed, built.attempt, JSON.stringify(built.inputs), user.id, roomId,
    built.inputs.band, p.variant, p.fingerprint, JSON.stringify(p.tags), JSON.stringify(mission), JSON.stringify(p.answerKey),
    JSON.stringify(narrative), p.timeLimitSec, JSON.stringify(st), t, startAt, startAt + p.timeLimitSec * 1000,
  );
  return id;
}

export async function startMission(user: UserRow, req: StartRequest): Promise<MissionView> {
  const db = getDb();
  let ev: EventRow | undefined;
  if (req.mode === "event") {
    ev = await findEvent(db, req.eventCode);
    if (!ev) throw new HttpError(404, "EVENT_NOT_FOUND", "Is code ka koi event nahi hai. Code dobara check karo.");
    if (!eventIsLive(ev)) throw new HttpError(409, "EVENT_CLOSED", "Ye event abhi open nahi hai.");
  }

  const open = await openInstance(db, user.id);
  if (open) {
    const same = req.mode === "event" ? open.event_id === ev!.id : open.scope === "personal";
    if (same) return { ...(await buildView(db, user, open)), resumed: true };
    throw new HttpError(409, "OPEN_MISSION", "Pehle apna chalu mission khatam karo ya chhodo.", { instanceId: open.id });
  }
  if (ev) {
    const prior = await db.prepare(`SELECT id FROM mission_instances WHERE user_id = ? AND event_id = ?`).get(user.id, ev.id) as { id: string } | undefined;
    if (prior) throw new HttpError(409, "EVENT_DONE", "Ye event tum pehle hi khel chuke ho.", { instanceId: prior.id });
  }

  const built = ev ? buildEvent(ev) : await buildPersonal(db, user);
  const seed = built.seed;
  const template = getTemplate(TEMPLATE)!;
  const p = built.puzzle;
  const mission = p.publicPuzzle as MissionPublic;
  const narrative: Narrative = fallbackNarrative({
    seed: p.fingerprint,
    callsign: user.nickname,
    level: user.level,
    band: built.inputs.band,
    focusTags: built.inputs.focusTags,
    firstTime: built.firstTime,
  });
  const id = randomUUID();
  const t = now();
  try {
    await db.prepare(
      `INSERT INTO mission_instances (id, template_id, template_version, ruleset_version, seed, gen_attempt, gen_inputs, scope, user_id, event_id,
         band, variant, fingerprint, tags, mission_public, mission_key, narrative, narrative_source, time_limit_sec, status, state,
         created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fallback', ?, 'briefing', ?, ?, ?)`,
    ).run(
      id, TEMPLATE, template.version, RULESET_VERSION, seed, built.attempt, JSON.stringify(built.inputs), built.scope, user.id, built.eventId,
      built.inputs.band, p.variant, p.fingerprint, JSON.stringify(p.tags), JSON.stringify(mission), JSON.stringify(p.answerKey),
      JSON.stringify(narrative), p.timeLimitSec, JSON.stringify(initialState(mission)), t, t + BRIEFING_TTL_MS,
    );
  } catch (err) {
    // Two requests raced (double click, two tabs): the unique index kept only one.
    if (isUniqueViolation(err)) {
      const existing = await openInstance(db, user.id);
      if (existing) return { ...(await buildView(db, user, existing)), resumed: true };
    }
    throw err;
  }
  return await buildView(db, user, (await getInstance(db, id))!);
}

export async function getMission(user: UserRow, id: string): Promise<MissionView> {
  const db = getDb();
  return await buildView(db, user, await refresh(db, await ownedInstance(db, user, id)));
}

export async function beginMission(user: UserRow, id: string): Promise<MissionView> {
  const db = getDb();
  const inst = await refresh(db, await ownedInstance(db, user, id));
  if (inst.status === "briefing") {
    const t = now();
    const startAt = t + COUNTDOWN_MS;
    const st = loadState(inst.state, JSON.parse(inst.mission_public));
    st.anchor.at = startAt;
    await db.prepare(`UPDATE mission_instances SET status = 'active', started_at = ?, deadline_at = ?, state = ?, version = version + 1 WHERE id = ? AND status = 'briefing'`)
      .run(startAt, startAt + inst.time_limit_sec * 1000, JSON.stringify(st), inst.id);
  } else if (inst.status === "abandoned" && inst.started_at === null) {
    throw new HttpError(409, "BRIEFING_EXPIRED", "Ye briefing expire ho gayi. Naya mission shuru karo.");
  }
  return await buildView(db, user, (await getInstance(db, id))!);
}

export async function abortMission(user: UserRow, id: string): Promise<MissionView> {
  const db = getDb();
  const inst = await refresh(db, await ownedInstance(db, user, id));
  if (inst.status === "briefing") {
    await db.prepare(`UPDATE mission_instances SET status = 'abandoned', finished_at = ? WHERE id = ? AND status = 'briefing'`).run(now(), inst.id);
  } else if (inst.status === "active") {
    await db.transaction(async () => {
      const fresh = (await getInstance(db, inst.id))!;
      if (fresh.status !== "active") return;
      await finishMission(db, fresh, loadState(fresh.state, JSON.parse(fresh.mission_public)), "abandoned", now());
    }, `mission:${inst.id}`);
  }
  return await buildView(db, user, (await getInstance(db, id))!);
}

// ---------------------------------------------------------------- events

const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hack_start"), vault: z.string().max(8) }),
  z.object({ type: z.literal("hack_answer"), vault: z.string().max(8), attempt: z.number().int().min(0).max(2), pick: z.unknown() }),
  z.object({ type: z.literal("pickup"), vault: z.string().max(8) }),
  z.object({ type: z.literal("kill"), robots: z.array(z.string().max(12)).min(1).max(16) }),
  z.object({ type: z.literal("down"), n: z.number().int().min(1).max(20) }),
  z.object({ type: z.literal("uplink_start") }),
  z.object({ type: z.literal("uplink_done") }),
  z.object({ type: z.literal("shard"), id: z.string().max(8) }),
]);
export type MissionEvent = z.infer<typeof eventSchema>;

export interface EventOutcome {
  duplicate?: boolean;
  hack?: { vault: string; attempt: number; type: string; round: unknown; timeLimitMs: number; startedAt: number };
  judge?: HackResult & { vault: string; attemptsLeft: number; bruteUntil: number | null };
  killed?: { id: string; points: number }[];
  rejected?: { id: string; reason: string }[];
  points?: number;
  allShards?: boolean;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.z - b.z);

/** What the player is shown after a failed or timed-out hack: the right answer. */
function revealFor(a: { type: keyof typeof HACKS; key: unknown; round: unknown }): unknown {
  return HACKS[a.type].judge(a.key, { index: null, rot: null }, a.round).reveal;
}

function checkTravel(st: MissionState, to: Pt, at: number, radius = 0): void {
  const d = Math.max(0, dist(st.anchor, to) - radius);
  const minMs = (d / MAX_TRAVEL_SPEED) * 1000 - TRAVEL_SLACK_MS;
  if (at - st.anchor.at < minMs) throw new HttpError(422, "TOO_FAST", "Itni jaldi wahan pahunchna mumkin nahi. Event reject hua.");
}

function robotIndex(m: MissionPublic): Map<string, { kind: RobotKind; release: string }> {
  const out = new Map<string, { kind: RobotKind; release: string }>();
  for (const g of m.groups) for (const s of g.spawns) out.set(s.id, { kind: s.kind, release: g.release });
  for (const t of m.turrets) out.set(t.id, { kind: "turret", release: "start" });
  if (m.courier) out.set(m.courier.id, { kind: "courier", release: "start" });
  return out;
}

function failHack(st: MissionState, m: MissionPublic, vaultId: string, result: HackResult, at: number): void {
  const v = st.hack[vaultId];
  v.results.push(result);
  v.started = null;
  v.attempt += 1;
  st.mistakes.push(result.tag);
  const key = `alarm:${vaultId}:${v.attempt}`;
  if (!st.released.includes(key)) st.released.push(key);
  if (v.attempt >= 3) v.bruteUntil = at + m.bruteForceSec * 1000;
}

/**
 * Apply one gameplay event. Every rule here is what makes the score trustworthy:
 * objectives in order, puzzles judged on the server, robots counted once and only
 * after they could exist, and travel times that a real car could achieve.
 */
export async function postEvent(user: UserRow, id: string, raw: unknown): Promise<{ view: MissionView; outcome: EventOutcome }> {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "BAD_EVENT", "Event sahi format mein nahi hai.");
  const ev = parsed.data;
  const db = getDb();
  let outcome: EventOutcome = {};
  let after: InstanceRow | null = null;
  // One event at a time per mission: the advisory lock makes concurrent reports queue up.
  await db.transaction(async () => {
    const inst = await refresh(db, await ownedInstance(db, user, id));
    if (inst.status !== "active") {
      if (inst.status === "briefing") throw new HttpError(409, "NOT_STARTED", "Pehle mission start karo.");
      outcome = { duplicate: true };
      return;
    }
    const t = now();
    if (inst.started_at !== null && t < inst.started_at - SCORING.graceMs) throw new HttpError(409, "TOO_EARLY", "Countdown abhi chal raha hai.");
    const m = JSON.parse(inst.mission_public) as MissionPublic;
    const key = JSON.parse(inst.mission_key) as HeistKey;
    const st = loadState(inst.state, m);
    let finish: "success" | "fail" | null = null;

    const vault = "vault" in ev ? m.vaults.find((v) => v.id === ev.vault) : undefined;
    const truckCore = ev.type === "pickup" && !!m.courier && ev.vault === m.courier.id;
    if ("vault" in ev && !vault && !truckCore) throw new HttpError(404, "NO_SUCH_VAULT", "Ye vault is mission mein nahi hai.");
    const missionSec = (at: number) => Math.max(0, (at - (inst.started_at ?? at)) / 1000);

    switch (ev.type) {
      case "hack_start": {
        const v = vault!;
        if (v.lock === "titan") throw new HttpError(409, "TITAN_LOCK", "Is vault ka lock TITAN ke paas hai. Pehle Titan ko giraao!");
        const vs = st.hack[v.id];
        if (st.unlocked[v.id]) throw new HttpError(409, "ALREADY_OPEN", "Ye vault pehle hi khul chuka hai.");
        if (vs.bruteUntil !== null) throw new HttpError(409, "BRUTE_FORCING", "Vault brute-force ho raha hai. Ruko aur bachao!");
        const mod = HACKS[v.hackType];
        if (vs.started) {
          if (t <= vs.started.at + v.hackTimeMs + SCORING.graceMs) {
            const a = key.hacks[v.id][vs.started.attempt];
            outcome = { duplicate: true, hack: { vault: v.id, attempt: vs.started.attempt, type: a.type, round: a.round, timeLimitMs: v.hackTimeMs, startedAt: vs.started.at } };
            break;
          }
          const a = key.hacks[v.id][vs.started.attempt];
          failHack(st, m, v.id, { attempt: vs.started.attempt, correct: false, timeout: true, ms: v.hackTimeMs, points: 0, explain: a.explain, tag: a.tag, reveal: revealFor(a) }, t);
          if (vs.bruteUntil !== null) break;
        }
        checkTravel(st, v.terminal, t);
        vs.started = { attempt: vs.attempt, at: t };
        st.anchor = { x: v.terminal.x, z: v.terminal.z, at: t };
        const a = key.hacks[v.id][vs.attempt];
        outcome = { hack: { vault: v.id, attempt: vs.attempt, type: a.type, round: a.round, timeLimitMs: v.hackTimeMs, startedAt: t } };
        break;
      }
      case "hack_answer": {
        const v = vault!;
        if (v.lock === "titan") throw new HttpError(409, "TITAN_LOCK", "Is vault ka lock TITAN ke paas hai.");
        const vs = st.hack[v.id];
        const done = vs.results.find((r) => r.attempt === ev.attempt);
        if (done) {
          outcome = { duplicate: true, judge: { ...done, vault: v.id, attemptsLeft: 3 - vs.attempt, bruteUntil: vs.bruteUntil } };
          break;
        }
        if (!vs.started || vs.started.attempt !== ev.attempt) throw new HttpError(409, "HACK_NOT_STARTED", "Ye hack abhi shuru nahi hua.");
        const a = key.hacks[v.id][ev.attempt];
        const mod = HACKS[a.type];
        const elapsed = t - vs.started.at;
        const late = elapsed > v.hackTimeMs + SCORING.graceMs;
        const pick = late ? null : mod.parsePick(ev.pick, a.round);
        if (!late && pick === null && ev.pick !== null) throw new HttpError(400, "BAD_PICK", "Jawab sahi format mein nahi hai.");
        const judged = pick === null ? { correct: false, reveal: revealFor(a) } : mod.judge(a.key, pick, a.round);
        const result: HackResult = {
          attempt: ev.attempt, correct: judged.correct, timeout: late || pick === null, ms: Math.min(elapsed, v.hackTimeMs),
          points: judged.correct ? hackPoints(inst.band, ev.attempt, elapsed, v.hackTimeMs) : 0, explain: a.explain, tag: a.tag, reveal: judged.reveal,
        };
        if (judged.correct) {
          vs.results.push(result);
          vs.started = null;
          st.unlocked[v.id] = { at: t, via: "hack" };
          st.points.hacks += result.points;
        } else {
          failHack(st, m, v.id, result, t);
        }
        outcome = { judge: { ...result, vault: v.id, attemptsLeft: 3 - vs.attempt, bruteUntil: vs.bruteUntil } };
        break;
      }
      case "pickup": {
        if (truckCore) {
          const c = m.courier!;
          if (st.picked[c.id]) { outcome = { duplicate: true }; break; }
          if (!st.kills[c.id] || !st.courierDrop) throw new HttpError(409, "TRUCK_RUNNING", "Truck abhi chal raha hai. Pehle use todo!");
          // The truck kept rolling while the kill report travelled; allow for that.
          checkTravel(st, st.courierDrop, t, 40);
          st.picked[c.id] = t;
          st.anchor = { x: st.courierDrop.x, z: st.courierDrop.z, at: t };
          st.points.cores += corePoints(inst.band);
          outcome = { points: corePoints(inst.band) };
          break;
        }
        const v = vault!;
        if (st.picked[v.id]) { outcome = { duplicate: true }; break; }
        const vs = st.hack[v.id];
        if (!st.unlocked[v.id]) {
          if (vs.bruteUntil !== null && t >= vs.bruteUntil - SCORING.graceMs) st.unlocked[v.id] = { at: t, via: "brute" };
          else if (v.lock === "titan") throw new HttpError(409, "VAULT_LOCKED", "Core abhi locked hai. Pehle TITAN ko giraao!");
          else throw new HttpError(409, "VAULT_LOCKED", "Core abhi locked hai. Pehle hack karo.");
        }
        checkTravel(st, v.core, t);
        st.picked[v.id] = t;
        st.anchor = { x: v.core.x, z: v.core.z, at: t };
        st.points.cores += corePoints(inst.band);
        outcome = { points: corePoints(inst.band) };
        break;
      }
      case "kill": {
        const idx = robotIndex(m);
        const killed: { id: string; points: number }[] = [];
        const rejected: { id: string; reason: string }[] = [];
        st.killTimes = st.killTimes.filter((x) => t - x < 1000);
        for (const rid of ev.robots) {
          const r = idx.get(rid);
          if (!r) { rejected.push({ id: rid, reason: "unknown robot" }); continue; }
          if (st.kills[rid]) { rejected.push({ id: rid, reason: "already destroyed" }); continue; }
          if (!st.released.includes(r.release)) { rejected.push({ id: rid, reason: "not deployed yet" }); continue; }
          if (st.killTimes.length >= SCORING.maxKillsPerSecond) { rejected.push({ id: rid, reason: "too many at once" }); continue; }
          if (r.kind === "courier") {
            // Only someone near the truck can destroy it (its route is known to the server).
            const at = courierPos(m.courier!, missionSec(t));
            try { checkTravel(st, at, t, 60); } catch { rejected.push({ id: rid, reason: "too far from the truck" }); continue; }
            st.courierDrop = { x: +at.x.toFixed(2), z: +at.z.toFixed(2) };
          }
          const pts = killPoints(inst.band, r.kind);
          st.kills[rid] = t;
          st.killTimes.push(t);
          st.points.kills += pts;
          killed.push({ id: rid, points: pts });
          if (r.kind === "titan") {
            for (const v of m.vaults) if (v.guard === rid && !st.unlocked[v.id]) st.unlocked[v.id] = { at: t, via: "titan" };
          }
        }
        outcome = { killed, rejected, duplicate: killed.length === 0 && rejected.every((r) => r.reason === "already destroyed") };
        break;
      }
      case "down": {
        if (ev.n <= st.downs) { outcome = { duplicate: true }; break; }
        const lost = ev.n - st.downs;
        st.downs = ev.n;
        st.lives = Math.max(0, st.lives - lost);
        if (st.lives === 0) { st.mistakes.push("survival"); finish = "fail"; }
        break;
      }
      case "uplink_start": {
        if (st.uplink.startedAt !== null) { outcome = { duplicate: true }; break; }
        const missing = coreIds(m).filter((id) => !st.picked[id]);
        if (missing.length) throw new HttpError(409, "CORES_MISSING", `Abhi ${missing.length} core baaki hain.`);
        checkTravel(st, m.uplink, t, m.uplink.radius);
        st.uplink.startedAt = t;
        st.anchor = { x: m.uplink.x, z: m.uplink.z, at: t };
        for (const k of ["uplink:1", "uplink:2"]) if (!st.released.includes(k)) st.released.push(k);
        break;
      }
      case "uplink_done": {
        if (st.uplink.startedAt === null) throw new HttpError(409, "UPLINK_NOT_STARTED", "Upload abhi shuru nahi hua.");
        if (t - st.uplink.startedAt < m.uploadSec * 1000 - SCORING.graceMs) throw new HttpError(409, "UPLOAD_RUNNING", "Upload abhi chal raha hai.");
        st.uplink.doneAt = t;
        finish = "success";
        break;
      }
      case "shard": {
        const sh = (m.shards ?? []).find((x) => x.id === ev.id);
        if (!sh) throw new HttpError(404, "NO_SUCH_SHARD", "Ye shard is mission mein nahi hai.");
        if (st.shards[sh.id]) { outcome = { duplicate: true }; break; }
        checkTravel(st, sh, t, 4);
        st.shards[sh.id] = t;
        st.anchor = { x: sh.x, z: sh.z, at: t };
        const all = Object.keys(st.shards).length === (m.shards ?? []).length;
        const pts = shardPoints(inst.band, all);
        st.points.shards += pts;
        outcome = { points: pts, allShards: all };
        break;
      }
    }

    const state = JSON.stringify(st);
    await db.prepare(`UPDATE mission_instances SET state = ?, version = version + 1 WHERE id = ?`).run(state, inst.id);
    if (inst.room_id) await roomProgress(db, inst.room_id, inst.user_id, runningScore(st), Object.keys(st.picked).length, Object.keys(st.kills).length);
    if (finish) await finishMission(db, (await getInstance(db, inst.id))!, st, finish, t);
    else after = { ...inst, state, version: inst.version + 1 };
  }, `mission:${id}`);
  // Most events don't change the mission's status: answer from what we just wrote instead of reading it back.
  return { view: await buildView(db, user, after ?? (await getInstance(db, id))!), outcome };
}

/** Records the outcome exactly once. Runs inside the caller's transaction. */
async function finishMission(db: DB, inst: InstanceRow, st: MissionState, outcome: AttemptRow["outcome"], at: number): Promise<void> {
  if (await db.prepare(`SELECT 1 FROM attempts WHERE instance_id = ?`).get(inst.id)) return;
  const m = JSON.parse(inst.mission_public) as MissionPublic;
  const cleared = outcome === "success";
  const status = cleared ? "completed" : "failed";
  await db.prepare(`UPDATE mission_instances SET status = ?, finished_at = ? WHERE id = ?`).run(status, at, inst.id);

  const secondsLeft = Math.max(0, ((inst.deadline_at ?? at) - at) / 1000);
  const bonus = cleared ? clearBonuses(inst.band, secondsLeft, st.downs) : { clear: 0, time: 0, flawless: 0 };
  const total = runningScore(st) + bonus.clear + bonus.time + bonus.flawless;
  const xp = Math.max(total, SCORING.minXp);
  const user = (await db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(inst.user_id)) as UserRow;

  let bandBefore = inst.band, bandAfter = inst.band;
  let bandChange: "up" | "down" | "same" = "same";
  if (inst.scope === "personal") {
    const skill = await getSkill(db, user.id, inst.template_id, user.level);
    bandBefore = skill.band;
    const r = applyOutcome(skill, cleared, (user.difficulty_pref as DifficultyPref) ?? "balanced");
    await saveSkill(db, user.id, inst.template_id, r.next);
    bandAfter = r.next.band;
    bandChange = r.change;
  }
  const xpAfter = user.xp + xp;
  const levelAfter = levelForXp(xpAfter);
  await db.prepare(`UPDATE users SET xp = ?, level = ? WHERE id = ?`).run(xpAfter, levelAfter, user.id);

  const allResults = Object.values(st.hack).flatMap((v) => v.results);
  const hackVaults = m.vaults.filter((v) => v.lock !== "titan");
  const hacksFirstTry = hackVaults.filter((v) => st.hack[v.id]?.results[0]?.correct).length;
  const cracked = Array.from(new Set(m.vaults.filter((v) => st.unlocked[v.id]?.via === "hack").map((v) => v.hackType)));
  const kills = Object.keys(st.kills).length;
  const mistakes = Array.from(new Set([...st.mistakes.map((t) => t.split(":").slice(0, 2).join(":")), ...(outcome === "timeout" ? ["speed"] : [])]));
  const breakdown = {
    cores: Object.keys(st.picked).length,
    coresTotal: coreIds(m).length,
    corePoints: st.points.cores,
    hackPoints: st.points.hacks,
    hacksFirstTry,
    hackAttempts: allResults.length,
    hackTypesCracked: cracked,
    kills,
    killPoints: st.points.kills,
    shards: Object.keys(st.shards).length,
    shardsTotal: (m.shards ?? []).length,
    shardPoints: st.points.shards ?? 0,
    op: m.op ?? "classic",
    titanDown: m.vaults.some((v) => !!v.guard && !!st.kills[v.guard]),
    truckDown: !!(m.courier && st.kills[m.courier.id]),
    clear: bonus.clear,
    time: bonus.time,
    flawless: bonus.flawless,
    secondsLeft: Math.floor(secondsLeft),
    total,
    xp,
    livesLost: st.downs,
    stars: starsFor(cleared, st.downs),
    bandBefore, bandAfter, bandChange,
    levelBefore: user.level, levelAfter,
    newAchievements: [] as string[],
  };
  await db.prepare(
    `INSERT INTO attempts (id, instance_id, user_id, template_id, band, scope, event_id, outcome, elapsed_ms,
       score, xp_awarded, score_breakdown, mistake_tags, detail, ruleset_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(), inst.id, user.id, inst.template_id, inst.band, inst.scope, inst.event_id, outcome,
    Math.max(0, at - (inst.started_at ?? at)), total, xp, JSON.stringify(breakdown), JSON.stringify(mistakes),
    `${breakdown.cores}/${breakdown.coresTotal} cores, ${kills} robots`, inst.ruleset_version, now(),
  );
  if (outcome !== "abandoned") {
    breakdown.newAchievements = await checkAchievements(db, {
      userId: user.id, scope: inst.scope, cleared, band: inst.band, bandAfter, livesLost: st.downs, kills,
      hacksFirstTry, hackCount: hackVaults.length, hackTypesCracked: cracked, timeLeftFrac: secondsLeft / inst.time_limit_sec,
      titanDown: breakdown.titanDown, truckDown: breakdown.truckDown, allShards: breakdown.shardsTotal > 0 && breakdown.shards === breakdown.shardsTotal,
    });
    if (breakdown.newAchievements.length) await db.prepare(`UPDATE attempts SET score_breakdown = ? WHERE instance_id = ?`).run(JSON.stringify(breakdown), inst.id);
  }
  if (inst.room_id) await roomPlayerFinished(db, inst.room_id, user.id, outcome, total, breakdown.cores, kills, at);
}


// ---------------------------------------------------------------- views

export interface MissionResult {
  outcome: AttemptRow["outcome"];
  cleared: boolean;
  score: number;
  xpAwarded: number;
  breakdown: Record<string, unknown> & { stars: number; total: number; newAchievements: string[] };
  detail: string;
  elapsedMs: number;
  feedback: { headline: string; feedback: string; next_tip: string; source: string };
}

export interface Progress {
  lives: number;
  downs: number;
  unlocked: string[];
  picked: string[];
  released: string[];
  killed: string[];
  shards: string[];
  courierDrop: Pt | null;
  hacks: Record<string, { attempt: number; bruteUntil: number | null; results: HackResult[]; active: { attempt: number; startedAt: number; round: unknown; type: string; timeLimitMs: number } | null }>;
  uplink: { startedAt: number | null; doneAt: number | null };
  score: number;
  points: MissionState["points"];
}

export interface MissionView {
  id: string;
  templateId: TemplateId;
  title: string;
  mode: "personal" | "event" | "room";
  event: { code: string; name: string } | null;
  /** Multiplayer race this mission belongs to. */
  room: { code: string; mode: "solo" | "teams" } | null;
  band: Band;
  bandLabel: string;
  status: InstanceRow["status"];
  serverNow: number;
  startedAt: number | null;
  deadline: number | null;
  timeLimitSec: number;
  tipOffered: boolean;
  narrative: Narrative & { source: string };
  mission: MissionPublic;
  progress: Progress;
  result: MissionResult | null;
  rulesetVersion: string;
  resumed?: boolean;
}

export async function buildView(db: DB, user: UserRow, inst: InstanceRow): Promise<MissionView> {
  const m = JSON.parse(inst.mission_public) as MissionPublic;
  const key = JSON.parse(inst.mission_key) as HeistKey;
  const st = loadState(inst.state, m);
  const narrative = parseJson<Narrative>(inst.narrative, {} as Narrative);
  // Only read what this mission's status needs (each read is a round trip to the database).
  const live = inst.status === "briefing" || inst.status === "active";
  const [ev, attempt, failStreak, room] = await Promise.all([
    inst.event_id ? db.prepare(`SELECT code, name FROM events WHERE id = ?`).get<{ code: string; name: string }>(inst.event_id) : Promise.resolve(undefined),
    live ? Promise.resolve(undefined) : db.prepare(`SELECT * FROM attempts WHERE instance_id = ?`).get<AttemptRow>(inst.id),
    inst.scope === "personal" && inst.status === "briefing" ? recentFailStreak(db, user.id, inst.template_id) : Promise.resolve(0),
    inst.room_id ? db.prepare(`SELECT code, mode FROM rooms WHERE id = ?`).get<{ code: string; mode: "solo" | "teams" }>(inst.room_id) : Promise.resolve(undefined),
  ]);

  let result: MissionResult | null = null;
  if (attempt) {
    const b = parseJson<MissionResult["breakdown"]>(attempt.score_breakdown, { stars: 0, total: 0, newAchievements: [] });
    const stored = parseJson<{ headline: string; feedback: string; next_tip: string } | null>(attempt.feedback, null);
    result = {
      outcome: attempt.outcome,
      cleared: attempt.outcome === "success",
      score: attempt.score,
      xpAwarded: attempt.xp_awarded,
      breakdown: b,
      detail: attempt.detail,
      elapsedMs: attempt.elapsed_ms,
      feedback: stored
        ? { ...stored, source: attempt.feedback_source ?? "ai" }
        : { ...fallbackFeedback(attempt.outcome, Number(b.cores ?? 0), Number(b.coresTotal ?? coreIds(m).length), Number(b.kills ?? 0)), source: "fallback" },
    };
  }

  const hacks: Progress["hacks"] = {};
  for (const v of m.vaults) {
    const vs = st.hack[v.id];
    if (!vs) continue;
    const a = vs.started ? key.hacks[v.id][vs.started.attempt] : null;
    hacks[v.id] = {
      attempt: vs.attempt,
      bruteUntil: vs.bruteUntil,
      results: vs.results,
      active: vs.started && a ? { attempt: vs.started.attempt, startedAt: vs.started.at, round: a.round, type: a.type, timeLimitMs: v.hackTimeMs } : null,
    };
  }

  return {
    id: inst.id,
    templateId: inst.template_id,
    title: getTemplate(inst.template_id)?.title ?? inst.template_id,
    mode: inst.scope,
    event: ev ? { code: ev.code, name: ev.name } : null,
    room: room ? { code: room.code, mode: room.mode } : null,
    band: inst.band,
    bandLabel: BAND_LABELS[inst.band],
    status: inst.status,
    serverNow: now(),
    startedAt: inst.started_at,
    deadline: inst.deadline_at,
    timeLimitSec: inst.time_limit_sec,
    tipOffered: failStreak >= HINT_OFFER_AFTER_FAILS,
    narrative: { ...narrative, source: inst.narrative_source },
    mission: m,
    progress: {
      lives: st.lives,
      downs: st.downs,
      unlocked: Object.keys(st.unlocked),
      picked: Object.keys(st.picked),
      released: st.released,
      killed: Object.keys(st.kills),
      shards: Object.keys(st.shards),
      courierDrop: st.courierDrop,
      hacks,
      uplink: st.uplink,
      score: runningScore(st),
      points: st.points,
    },
    result,
    rulesetVersion: inst.ruleset_version,
  };
}

// ---------------------------------------------------------------- AI attachments

/** Replace the built-in story with AI text, only before the mission starts. */
export async function setNarrative(instanceId: string, patch: Partial<Narrative>, source: string): Promise<boolean> {
  const db = getDb();
  const inst = await getInstance(db, instanceId);
  if (!inst || inst.status !== "briefing" || inst.narrative_source !== "fallback") return false;
  const merged = { ...parseJson<Narrative>(inst.narrative, {} as Narrative), ...patch };
  return (await db.prepare(`UPDATE mission_instances SET narrative = ?, narrative_source = ? WHERE id = ? AND status = 'briefing' AND narrative_source = 'fallback'`)
    .run(JSON.stringify(merged), source, instanceId)).changes === 1;
}

export async function setFeedback(instanceId: string, feedback: { headline: string; feedback: string; next_tip: string }, source: string): Promise<void> {
  await getDb().prepare(`UPDATE attempts SET feedback = ?, feedback_source = ? WHERE instance_id = ? AND feedback IS NULL`).run(JSON.stringify(feedback), source, instanceId);
}

export async function debriefContext(user: UserRow, instanceId: string) {
  const db = getDb();
  const inst = await ownedInstance(db, user, instanceId);
  const attempt = await db.prepare(`SELECT * FROM attempts WHERE instance_id = ?`).get(inst.id) as AttemptRow | undefined;
  if (!attempt) return null;
  const st = loadState(inst.state, JSON.parse(inst.mission_public));
  const failed = Object.values(st.hack).flatMap((v) => v.results.filter((r) => !r.correct));
  return {
    inst,
    attempt,
    breakdown: parseJson<Record<string, unknown>>(attempt.score_breakdown, {}),
    missedHackNotes: failed.slice(0, 3).map((r) => r.explain),
    practiceAreas: Array.from(new Set(parseJson<string[]>(attempt.mistake_tags, []))).map(describeTag),
  };
}
