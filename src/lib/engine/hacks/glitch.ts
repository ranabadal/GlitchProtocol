import { z } from "zod";
import type { Rng } from "../rng";
import { FITTERS, type Known } from "./fitters";
import type { HackBand, HackModule } from "./types";

/*
 * DATA STREAM BREACH (Pattern Breaker)
 * A row of holographic data nodes follows a pattern in colour, shape, size or number.
 * NULL corrupted exactly one node. The round is valid only if the untouched row cannot
 * be explained by any pattern and treating exactly ONE node as unknown makes every
 * attribute fit a pattern again, so there is always exactly one right node.
 */

export interface Tile {
  /** colour 0-5 */ c: number;
  /** shape 0-5 */ s: number;
  /** size 0-2 */ z: number;
  /** number shown on the node, if this round uses numbers */ n: number | null;
}

export interface GlitchRound { tiles: Tile[] }
export type Attr = "c" | "s" | "z" | "n";
export interface GlitchKey { glitch: number; attr: Attr }
export interface GlitchPick { index: number | null }

export const COLOR_NAMES = ["cyan", "pink", "yellow", "green", "orange", "purple"];
export const SHAPE_NAMES = ["circle", "square", "triangle", "diamond", "star", "hexagon"];
const SIZE_NAMES = ["chhota", "medium", "bada"];
const ATTR_HINDI: Record<Attr, string> = { c: "colours", s: "shapes", z: "size", n: "numbers" };

/** Does this attribute repeat with some period 1-3, ignoring position j? Every repeat group needs two known members. */
export function fitsCategorical(vals: number[], j: number | null): boolean {
  for (let p = 1; p <= 3; p++) {
    let ok = true;
    for (let r = 0; r < p && ok; r++) {
      const members: number[] = [];
      for (let i = r; i < vals.length; i += p) if (i !== j) members.push(vals[i]);
      if (members.length < 2 || members.some((v) => v !== members[0])) ok = false;
    }
    if (ok) return true;
  }
  return false;
}

export function fitsNumbers(nums: number[], j: number | null): boolean {
  const known: Known = nums.map((v, i) => (i === j ? null : v));
  return Object.values(FITTERS).some((f) => f(known) !== null);
}

function explainable(tiles: Tile[], j: number | null): boolean {
  const attr = (k: "c" | "s" | "z") => tiles.map((t) => t[k]);
  if (!fitsCategorical(attr("c"), j) || !fitsCategorical(attr("s"), j) || !fitsCategorical(attr("z"), j)) return false;
  if (tiles[0].n !== null) return fitsNumbers(tiles.map((t) => t.n as number), j);
  return true;
}

/** Positions that, if treated as the glitch, make the whole row follow its patterns. */
export function glitchCandidates(tiles: Tile[]): { clean: boolean; candidates: number[] } {
  const candidates: number[] = [];
  for (let j = 0; j < tiles.length; j++) if (explainable(tiles, j)) candidates.push(j);
  return { clean: explainable(tiles, null), candidates };
}

function periodic(rng: Rng, len: number, p: number, palette: number): number[] {
  const pool = rng.shuffle(Array.from({ length: palette }, (_, i) => i)).slice(0, p);
  return Array.from({ length: len }, (_, i) => pool[i % p]);
}

function buildOnce(rng: Rng, band: HackBand, focus: string[]) {
  const options: Attr[] = band === 1 ? ["c", "s", "n"] : ["c", "s", "z", "n"];
  const attr = rng.weighted(options.map((a) => ({ item: a, weight: focus.includes(`hack:glitch:${a}`) ? 3 : 1 })));
  const primaryPeriod = attr === "n" ? 0 : band === 1 ? rng.pick([1, 2]) : band === 2 ? rng.pick([2, 2, 3]) : rng.pick([2, 3]);
  const len = primaryPeriod === 3 ? 9 : band === 1 ? 6 : 8;
  const decoyPeriod = (k: Attr) => (k === attr ? 0 : band === 1 ? 1 : band === 2 ? rng.pick([1, 2]) : rng.pick([1, 2, 2]));
  const c = attr === "c" ? periodic(rng, len, primaryPeriod, 6) : periodic(rng, len, decoyPeriod("c"), 6);
  const s = attr === "s" ? periodic(rng, len, primaryPeriod, 6) : periodic(rng, len, decoyPeriod("s"), 6);
  const zz = attr === "z" ? periodic(rng, len, primaryPeriod, 3) : band === 3 && rng.chance(0.4) ? periodic(rng, len, 2, 3) : Array(len).fill(1);

  let n: number[] | null = null;
  let rule = "";
  if (attr === "n") {
    if (band === 3 && rng.chance(0.3)) {
      const a = rng.int(1, 3);
      n = Array.from({ length: len }, (_, i) => a * 2 ** i);
      rule = "har baar double ho rahe the";
    } else {
      const d = rng.pick(band === 1 ? [1, 2, 5, 10] : band === 2 ? [2, 3, 4, 5, 10] : [3, 4, 6, 7, 9, 11]);
      const down = band >= 2 && rng.chance(0.35);
      const a = down ? rng.int(d * len, d * len + 20) : rng.int(1, 20);
      n = Array.from({ length: len }, (_, i) => a + (down ? -d : d) * i);
      rule = down ? `har baar ${d} kam ho rahe the` : `har baar ${d} badh rahe the`;
    }
  }

  const tiles: Tile[] = Array.from({ length: len }, (_, i) => ({ c: c[i], s: s[i], z: zz[i], n: n ? n[i] : null }));
  const glitch = rng.int(0, len - 1);
  const original = { ...tiles[glitch] };
  if (attr === "n") {
    const v = (tiles[glitch].n as number) + rng.int(1, 3) * rng.sign();
    if (v < 0) return null;
    tiles[glitch].n = v;
  } else {
    const palette = attr === "z" ? 3 : 6;
    tiles[glitch][attr] = rng.pick(Array.from({ length: palette }, (_, i) => i).filter((v) => v !== tiles[glitch][attr]));
  }

  let explain: string;
  if (attr === "n") explain = `Numbers ${rule}. Node ${glitch + 1} pe ${tiles[glitch].n} tha, hona chahiye tha ${original.n}.`;
  else {
    const names = attr === "c" ? COLOR_NAMES : attr === "s" ? SHAPE_NAMES : SIZE_NAMES;
    const seq = (attr === "c" ? c : attr === "s" ? s : zz).slice(0, Math.max(primaryPeriod, 1) * 2).map((v) => names[v]).join(", ");
    explain = primaryPeriod === 1
      ? `Saare nodes ${names[original[attr]]} the, sirf node ${glitch + 1} ${names[tiles[glitch][attr]]} tha.`
      : `${ATTR_HINDI[attr][0].toUpperCase() + ATTR_HINDI[attr].slice(1)} ka pattern tha: ${seq}... Node ${glitch + 1} pe ${names[tiles[glitch][attr]]} aa gaya.`;
  }
  return { round: { tiles }, key: { glitch, attr }, tag: `hack:glitch:${attr}`, explain };
}

export const glitchHack: HackModule<GlitchRound, GlitchKey, GlitchPick> = {
  type: "glitch",
  title: "Data Stream Breach",
  challenge: "Pattern Breaker",
  instruction: "Ek data node pattern tod raha hai. Use select karo!",
  timeLimitMs: (band) => [15000, 15000, 16000][band - 1],
  build(rng, band, focus) {
    for (let t = 0; t < 30; t++) {
      const cand = buildOnce(rng, band, focus);
      if (!cand) continue;
      const { clean, candidates } = glitchCandidates(cand.round.tiles);
      if (!clean && candidates.length === 1 && candidates[0] === cand.key.glitch) return cand;
    }
    return null;
  },
  validate(round, key) {
    const tiles = round.tiles;
    if (tiles.length < 5 || tiles.length > 10) return { ok: false, reason: "bad length" };
    if (tiles.some((t) => t.c < 0 || t.c > 5 || t.s < 0 || t.s > 5 || t.z < 0 || t.z > 2)) return { ok: false, reason: "bad tile" };
    const { clean, candidates } = glitchCandidates(tiles);
    if (clean) return { ok: false, reason: "nothing is broken" };
    if (candidates.length !== 1) return { ok: false, reason: `${candidates.length} possible glitches` };
    if (candidates[0] !== key.glitch) return { ok: false, reason: "key disagrees with solver" };
    return { ok: true };
  },
  parsePick(raw, round) {
    const r = z.object({ index: z.number().int().min(0).max(20).nullable() }).safeParse(raw);
    if (!r.success || (r.data.index !== null && r.data.index >= round.tiles.length)) return null;
    return r.data;
  },
  judge(key, pick) {
    return { correct: pick.index === key.glitch, reveal: { answer: key.glitch } };
  },
  solve(round) {
    const { candidates } = glitchCandidates(round.tiles);
    if (candidates.length !== 1) throw new Error("glitch round ambiguous");
    return { index: candidates[0] };
  },
  fingerprintInput: (round) => JSON.stringify(round.tiles),
};
