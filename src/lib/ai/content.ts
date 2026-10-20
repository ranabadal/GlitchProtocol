import { z } from "zod";
import { now } from "../clock";
import { getDb, parseJson } from "../db";
import { THEMES, type VoicePack } from "../engine/narratives";
import { BAND_LABELS, type Band } from "../engine/types";
import { callStructured } from "./client";

/*
 * AI-written Hinglish flavour text. The AI never sees mission layouts, hack puzzles,
 * answers or anything a player typed (not even the callsign), so it cannot leak an
 * answer or be steered by a crafted nickname. Replies must match a strict JSON schema
 * and pass our own checks; otherwise the caller keeps the built-in text.
 */

const SYSTEM = [
  "You write in-game text for GLITCH PROTOCOL, a 3D sci-fi action game played by Indian school students (age 10-17) at a science fair.",
  "Setting: Neon City at night. NULL is a dramatic, funny rogue AI whose robots guard data vaults. The player is an operator who drives, fights robots with an energy blaster, hacks vaults and uploads stolen data cores at an uplink tower.",
  "Write in simple, punchy Hinglish: Hindi words in Roman letters mixed with easy English, like 'Jaldi karo, core uthao!'.",
  "Keep it exciting but kind: no gore, no harm to humans, no insults about intelligence, no real people, places or brands.",
  "Never invent mission numbers, answers, rules, scores or points. Plain text only: no markdown, emoji or links. Keep every line short.",
].join(" ");

const plain = (s: string) => !/https?:|www\.|[#*`<>]/i.test(s) && !/\b(stupid|idiot|dumb|bewakoof|pagal|kill (you|them)|blood|khoon)\b/i.test(s);
const line = (min: number, max: number) => z.string().min(min).max(max).refine(plain);
const str = (description: string) => ({ type: "string", description });
// No minItems/maxItems: not every deployment's strict mode accepts them. Zod checks counts instead.
const strs = (n: number, description: string) => ({ type: "array", items: { type: "string" }, description: `${description} Exactly ${n} items.` });

export interface AiPack {
  title: string;
  briefing: string;
  threat: string;
  voice: VoicePack;
}

const packSchema = z.object({
  title: line(3, 40),
  briefing: line(30, 300),
  threat: line(5, 90),
  on_kill: z.array(line(3, 60)).min(2).max(8),
  on_down: z.array(line(3, 60)).min(2).max(8),
  on_alarm: z.array(line(3, 60)).min(1).max(6),
  on_core: z.array(line(3, 60)).min(1).max(6),
  on_win: line(5, 90),
  on_lose: line(5, 90),
});

const packJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "briefing", "threat", "on_kill", "on_down", "on_alarm", "on_core", "on_win", "on_lose"],
  properties: {
    title: str("Mission codename, 2-4 words, English or Hinglish."),
    briefing: str("2-3 short Hinglish sentences, under 45 words, telling the operator to raid NULL's vaults, take the data cores and upload them at the uplink tower. Must include the literal token {{callsign}} once."),
    threat: str("NULL's taunt before the mission, under 10 words."),
    on_kill: strs(4, "Things NULL says when the player destroys one of his robots (NULL is annoyed). Under 8 words each."),
    on_down: strs(4, "Things NULL says when the player loses a life (teasing, never mean). Under 8 words each."),
    on_alarm: strs(3, "Things NULL shouts when the player fails a vault hack and the alarm goes off. Under 8 words each."),
    on_core: strs(3, "Things NULL says when the player steals a data core. Under 8 words each."),
    on_win: str("NULL's line when the player completes the upload (NULL's system crashes dramatically). Under 12 words."),
    on_lose: str("NULL's line when the player fails, encouraging them to try again. Under 12 words."),
  },
};

async function cacheGet<T>(key: string): Promise<T | null> {
  const db = getDb();
  const row = await db.prepare(`SELECT payload FROM ai_cache WHERE cache_key = ?`).get<{ payload: string }>(key);
  if (!row) return null;
  await db.prepare(`UPDATE ai_cache SET hits = hits + 1 WHERE cache_key = ?`).run(key);
  return parseJson<T | null>(row.payload, null);
}

async function cachePut(key: string, kind: string, payload: unknown): Promise<void> {
  await getDb().prepare(`INSERT INTO ai_cache (cache_key, kind, payload, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(cache_key) DO NOTHING`).run(key, kind, JSON.stringify(payload), now());
}

/**
 * One AI pack per (band, theme), cached and reused for every player, so a whole
 * science fair needs only a few dozen calls. The callsign is filled in afterwards.
 */
export async function aiMissionPack(opts: { band: Band; theme: number; userId: string }): Promise<{ data: AiPack; source: "ai" | "cache" } | null> {
  const key = `pack:v3:b${opts.band}:t${opts.theme}`;
  const cached = await cacheGet<AiPack>(key);
  if (cached?.voice?.onKill?.length) return { data: cached, source: "cache" };
  const premise = THEMES[opts.theme] ?? THEMES[0];
  const r = await callStructured({
    name: "mission_pack",
    jsonSchema: packJsonSchema,
    schema: packSchema,
    system: SYSTEM,
    user: JSON.stringify({
      task: "Write a fresh mission briefing and NULL's voice lines. Rewrite the premise in new words.",
      threat_level: BAND_LABELS[opts.band],
      premise_title: premise.title,
      premise: premise.briefing,
    }),
    maxTokens: 520,
    userId: opts.userId,
  });
  if (!r.ok) return null;
  const d = r.data;
  const data: AiPack = {
    title: d.title,
    briefing: d.briefing.includes("{{callsign}}") ? d.briefing : `{{callsign}}, ${d.briefing}`,
    threat: d.threat,
    voice: { onKill: d.on_kill.slice(0, 5), onDown: d.on_down.slice(0, 4), onAlarm: d.on_alarm.slice(0, 3), onCore: d.on_core.slice(0, 3), onWin: d.on_win, onLose: d.on_lose },
  };
  await cachePut(key, "pack", data);
  return { data, source: "ai" };
}

// ---------------------------------------------------------------- debrief

export interface AiDebrief { headline: string; feedback: string; next_tip: string }

const scoreClaim = /\b\d+\s*(xp|points?|pts|ank)\b/i;
const debriefSchema = z.object({
  headline: line(3, 40),
  feedback: line(20, 320).refine((s) => !scoreClaim.test(s)),
  next_tip: line(10, 160).refine((s) => !scoreClaim.test(s)),
});
const debriefJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "feedback", "next_tip"],
  properties: {
    headline: str("2-5 words, cheerful."),
    feedback: str("2-3 short Hinglish sentences of personal, encouraging feedback on how the mission went. If a hack was failed, explain one of them simply using the hack notes. Under 55 words."),
    next_tip: str("One practical Hinglish tip for the next mission, under 20 words."),
  },
};

export async function aiDebrief(opts: {
  outcome: string;
  band: Band;
  cores: number;
  coresTotal: number;
  kills: number;
  livesLost: number;
  hacksFirstTry: number;
  secondsLeft: number;
  missedHackNotes: string[];
  practiceAreas: string[];
  userId: string;
}): Promise<AiDebrief | null> {
  const r = await callStructured({
    name: "mission_debrief",
    jsonSchema: debriefJsonSchema,
    schema: debriefSchema,
    system: `${SYSTEM} For this message you are the operator's friendly coach, not NULL. Do not mention points, XP or scores; the game shows those itself.`,
    user: JSON.stringify({
      task: "Write the post-mission debrief for this student.",
      result: { success: "cleared the mission and uploaded every core", fail: "ran out of lives", timeout: "ran out of time" }[opts.outcome] ?? opts.outcome,
      threat_level: BAND_LABELS[opts.band],
      cores_collected: `${opts.cores} of ${opts.coresTotal}`,
      robots_destroyed: opts.kills,
      lives_lost: opts.livesLost,
      hacks_first_try: opts.hacksFirstTry,
      seconds_left: opts.secondsLeft,
      failed_hack_notes: opts.missedHackNotes,
      areas_to_practise: opts.practiceAreas,
    }),
    maxTokens: 240,
    userId: opts.userId,
  });
  return r.ok ? r.data : null;
}
