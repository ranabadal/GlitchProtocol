import { z } from "zod";
import { coreReached, DIRS, E, openings, W, type TileType, N, S } from "../../shared/power";
import type { Rng } from "../rng";
import type { HackBand, HackModule } from "./types";

/*
 * FIREWALL BYPASS (System Override)
 * A grid of circuit tiles sits between a power source (left edge) and the vault lock
 * (right edge). Rotate tiles until power flows across. Generation lays a hidden route
 * first, then scrambles every tile. Judging is an actual connectivity check on the
 * rotations the player sends, so any working route counts.
 */

export interface PowerRound {
  rows: number;
  cols: number;
  types: TileType[];
  /** Starting rotation of each tile, 0-3 quarter turns clockwise. */
  rot: number[];
  source: number;
  core: number;
}

export interface PowerKey { solution: number[]; path: number[] }
export interface PowerPick { rot: number[] | null }

const SIZE: Record<HackBand, [number, number]> = { 1: [3, 4], 2: [4, 4], 3: [4, 5] };
const MIN_WRONG: Record<HackBand, number> = { 1: 3, 2: 4, 3: 5 };
const DECOYS: Record<HackBand, TileType[]> = { 1: ["I", "L"], 2: ["I", "L", "T"], 3: ["I", "L", "T", "T"] };

function dirBetween(a: number, b: number, cols: number): number {
  const d = b - a;
  if (d === 1) return E;
  if (d === -1) return W;
  if (d === cols) return S;
  return N;
}

export function rotationFor(type: TileType, need: number): number | null {
  for (let r = 0; r < 4; r++) {
    const m = openings(type, r);
    if ((m & need) !== need) continue;
    if ((type === "I" || type === "L") && m !== need) continue;
    return r;
  }
  return null;
}

function route(rng: Rng, rows: number, cols: number, source: number, core: number): number[] | null {
  const target = core * cols + cols - 1;
  const seen = new Set<number>();
  const path: number[] = [];
  const maxLen = Math.floor(rows * cols * 0.7);
  const dfs = (cell: number): boolean => {
    path.push(cell);
    seen.add(cell);
    if (cell === target) return true;
    if (path.length < maxLen) {
      const r = Math.floor(cell / cols), c = cell % cols;
      const order = rng.shuffle(DIRS);
      if (rng.chance(0.55)) {
        const east = order.findIndex((d) => d.dc === 1);
        order.unshift(...order.splice(east, 1));
      }
      for (const d of order) {
        const nr = r + d.dr, nc = c + d.dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const next = nr * cols + nc;
        if (seen.has(next)) continue;
        if (dfs(next)) return true;
      }
    }
    path.pop();
    return false;
  };
  return dfs(source * cols) ? path : null;
}

function buildOnce(rng: Rng, band: HackBand) {
  const [rows, cols] = SIZE[band];
  const source = rng.int(0, rows - 1);
  const core = rng.int(0, rows - 1);
  const path = route(rng, rows, cols, source, core);
  if (!path || path.length < cols + 1) return null;
  const types: TileType[] = Array.from({ length: rows * cols }, () => rng.pick(DECOYS[band]));
  const solution: number[] = Array.from({ length: rows * cols }, () => rng.int(0, 3));
  for (let i = 0; i < path.length; i++) {
    const cell = path[i];
    const inDir = i === 0 ? W : dirBetween(cell, path[i - 1], cols);
    const outDir = i === path.length - 1 ? E : dirBetween(cell, path[i + 1], cols);
    const need = inDir | outDir;
    const straight = need === (N | S) || need === (E | W);
    const t: TileType = band === 3 && rng.chance(0.15) ? "T" : straight ? "I" : "L";
    types[cell] = t;
    const r = rotationFor(t, need);
    if (r === null) return null;
    solution[cell] = r;
  }
  const rot = solution.map(() => rng.int(0, 3));
  const round: PowerRound = { rows, cols, types, rot, source, core };
  const wrong = path.filter((c) => (openings(types[c], rot[c]) & openings(types[c], solution[c])) !== openings(types[c], solution[c])).length;
  if (wrong < MIN_WRONG[band] || coreReached(round, rot)) return null;
  return { round, key: { solution, path }, tag: "hack:power", explain: `Bijli ka rasta ${path.length} tiles lamba tha. Lock se ulta socho: right se left rasta banao.` };
}

/** Find any working set of rotations from public data alone: depth-first search over simple routes. */
function solve(round: PowerRound): PowerPick {
  const { rows, cols, types } = round;
  const start = round.source * cols;
  const target = round.core * cols + cols - 1;
  const onPath = new Set<number>();
  const chosen = new Map<number, number>();
  let budget = 500_000;
  const dfs = (cell: number, inDir: number): boolean => {
    if (--budget < 0) return false;
    onPath.add(cell);
    const r = Math.floor(cell / cols), c = cell % cols;
    for (const d of DIRS) {
      if (d.bit === inDir) continue;
      const rot = rotationFor(types[cell], inDir | d.bit);
      if (rot === null) continue;
      if (cell === target && d.bit === E) {
        chosen.set(cell, rot);
        const attempt = round.rot.slice();
        for (const [k, v] of chosen) attempt[k] = v;
        if (coreReached(round, attempt)) return true;
        chosen.delete(cell);
        continue;
      }
      const nr = r + d.dr, nc = c + d.dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const next = nr * cols + nc;
      if (onPath.has(next)) continue;
      chosen.set(cell, rot);
      if (dfs(next, d.opp)) return true;
      chosen.delete(cell);
    }
    onPath.delete(cell);
    return false;
  };
  if (!dfs(start, W)) throw new Error("power round unsolvable");
  const rot = round.rot.slice();
  for (const [k, v] of chosen) rot[k] = v;
  return { rot };
}

export const powerHack: HackModule<PowerRound, PowerKey, PowerPick> = {
  type: "power",
  title: "Firewall Bypass",
  challenge: "System Override",
  instruction: "Circuits ghumao aur power ko vault lock tak pahunchao!",
  timeLimitMs: (band) => [24000, 26000, 28000][band - 1],
  build(rng, band) {
    for (let t = 0; t < 40; t++) {
      const r = buildOnce(rng, band);
      if (r) return r;
    }
    return null;
  },
  validate(round, key) {
    const n = round.rows * round.cols;
    if (round.types.length !== n || round.rot.length !== n || key.solution.length !== n) return { ok: false, reason: "size mismatch" };
    if (round.source < 0 || round.source >= round.rows || round.core < 0 || round.core >= round.rows) return { ok: false, reason: "bad endpoints" };
    if (!coreReached(round, key.solution)) return { ok: false, reason: "hidden route does not reach the lock" };
    if (coreReached(round, round.rot)) return { ok: false, reason: "already solved at the start" };
    return { ok: true };
  },
  parsePick(raw, round) {
    const r = z.object({ rot: z.array(z.number().int().min(0).max(3)).nullable() }).safeParse(raw);
    if (!r.success || (r.data.rot !== null && r.data.rot.length !== round.rows * round.cols)) return null;
    return r.data;
  },
  judge(key, pick, round) {
    return { correct: pick.rot !== null && coreReached(round, pick.rot), reveal: { path: key.path } };
  },
  solve,
  fingerprintInput: (round) => JSON.stringify([round.rows, round.cols, round.types.join(""), round.source, round.core]),
};
