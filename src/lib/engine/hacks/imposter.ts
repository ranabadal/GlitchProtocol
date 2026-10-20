import { z } from "zod";
import type { HackBand, HackModule } from "./types";

/*
 * IDENTITY SCAN (Spot the Contradiction)
 * A line-up of security bots that should all be identical. One is NULL's fake and
 * differs in exactly one part (colour, eyes, antenna, mouth or chest light). Poses are
 * cosmetic only. Valid only if exactly one bot differs, in exactly one part.
 */

export type Feature = "body" | "eyes" | "ant" | "mouth" | "badge";
export const FEATURES: Feature[] = ["body", "eyes", "ant", "mouth", "badge"];
const RANGE: Record<Feature, number> = { body: 6, eyes: 4, ant: 4, mouth: 4, badge: 4 };
const FEATURE_HINDI: Record<Feature, string> = { body: "body ka colour", eyes: "aankhen", ant: "antenna", mouth: "muh", badge: "chest light" };
const FEATURE_SENTENCE: Record<Feature, string> = {
  body: "ka body colour alag tha",
  eyes: "ki aankhen alag thi",
  ant: "ka antenna alag tha",
  mouth: "ka muh alag tha",
  badge: "ki chest light alag thi",
};

export interface Bot { body: number; eyes: number; ant: number; mouth: number; badge: number; pose: number }
export interface ImposterRound { bots: Bot[]; cols: number }
export interface ImposterKey { imposter: number; feature: Feature }
export interface ImposterPick { index: number | null }

const COUNT: Record<HackBand, number> = { 1: 6, 2: 9, 3: 12 };
const COLS: Record<HackBand, number> = { 1: 3, 2: 3, 3: 4 };
const FEATURES_BY_BAND: Record<HackBand, Feature[]> = {
  1: ["body", "eyes", "ant"],
  2: ["eyes", "ant", "mouth"],
  3: ["ant", "mouth", "badge", "eyes"],
};

const sig = (b: Bot) => FEATURES.map((f) => b[f]).join(",");

/** The single bot that differs from all the others, if exactly one does. */
export function findImposter(bots: Bot[]): { index: number; features: Feature[] } | null {
  const counts = new Map<string, number>();
  for (const b of bots) counts.set(sig(b), (counts.get(sig(b)) ?? 0) + 1);
  if (counts.size !== 2) return null;
  const odd = [...counts.entries()].find(([, n]) => n === 1);
  if (!odd || bots.length - 1 < 2) return null;
  const index = bots.findIndex((b) => sig(b) === odd[0]);
  const ref = bots[index === 0 ? 1 : 0];
  return { index, features: FEATURES.filter((f) => bots[index][f] !== ref[f]) };
}

export const imposterHack: HackModule<ImposterRound, ImposterKey, ImposterPick> = {
  type: "imposter",
  title: "Identity Scan",
  challenge: "Spot the Contradiction",
  instruction: "Security bots mein ek nakli hai. Use pakdo!",
  timeLimitMs: (band) => [13000, 14000, 15000][band - 1],
  build(rng, band, focus) {
    const n = COUNT[band];
    const base = { body: rng.int(0, 5), eyes: rng.int(0, 3), ant: rng.int(0, 3), mouth: rng.int(0, 3), badge: rng.int(0, 3) };
    const feature = rng.weighted(FEATURES_BY_BAND[band].map((f) => ({ item: f, weight: focus.includes(`hack:imposter:${f}`) ? 3 : 1 })));
    const imposter = rng.int(0, n - 1);
    const fakeValue = rng.pick(Array.from({ length: RANGE[feature] }, (_, i) => i).filter((v) => v !== base[feature]));
    const bots: Bot[] = Array.from({ length: n }, (_, i) => ({ ...base, [feature]: i === imposter ? fakeValue : base[feature], pose: band >= 2 ? rng.int(0, 3) : 0 }) as Bot);
    return {
      round: { bots, cols: COLS[band] },
      key: { imposter, feature },
      tag: `hack:imposter:${feature}`,
      explain: `Bot ${imposter + 1} ${FEATURE_SENTENCE[feature]}, baaki sab ek jaise the.`,
    };
  },
  validate(round, key) {
    const bots = round.bots;
    if (bots.length < 4 || bots.length > 20) return { ok: false, reason: "bad squad size" };
    if (bots.some((b) => FEATURES.some((f) => b[f] < 0 || b[f] >= RANGE[f]))) return { ok: false, reason: "bad bot" };
    const found = findImposter(bots);
    if (!found) return { ok: false, reason: "not exactly one imposter" };
    if (found.features.length !== 1) return { ok: false, reason: `imposter differs in ${found.features.length} parts` };
    if (found.index !== key.imposter) return { ok: false, reason: "key disagrees with solver" };
    return { ok: true };
  },
  parsePick(raw, round) {
    const r = z.object({ index: z.number().int().min(0).max(30).nullable() }).safeParse(raw);
    if (!r.success || (r.data.index !== null && r.data.index >= round.bots.length)) return null;
    return r.data;
  },
  judge(key, pick) {
    return { correct: pick.index === key.imposter, reveal: { answer: key.imposter, feature: FEATURE_HINDI[key.feature] } };
  },
  solve(round) {
    const f = findImposter(round.bots);
    if (!f) throw new Error("imposter round ambiguous");
    return { index: f.index };
  },
  fingerprintInput: (round) => JSON.stringify(round.bots.map(sig)),
};
