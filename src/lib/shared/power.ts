// Circuit-tile logic shared by the server (judging the Firewall Bypass hack) and the
// browser (live glow while playing). Pure functions with no Node imports.

export type TileType = "I" | "L" | "T" | "X";

/** Openings as bits: N=1, E=2, S=4, W=8. */
export const N = 1, E = 2, S = 4, W = 8;
export const BASE: Record<TileType, number> = { I: N | S, L: N | E, T: N | E | S, X: N | E | S | W };
export const DIRS = [
  { bit: N, dr: -1, dc: 0, opp: S },
  { bit: E, dr: 0, dc: 1, opp: W },
  { bit: S, dr: 1, dc: 0, opp: N },
  { bit: W, dr: 0, dc: -1, opp: E },
];

export interface Board {
  rows: number;
  cols: number;
  types: TileType[];
  source: number;
  core: number;
}

export function rotateMask(mask: number, r: number): number {
  const k = ((r % 4) + 4) % 4;
  return ((mask << k) | (mask >> (4 - k))) & 15;
}

export function openings(type: TileType, rot: number): number {
  return rotateMask(BASE[type], rot);
}

/** Cells that receive power from the source, given these rotations. */
export function powered(board: Board, rot: number[]): Set<number> {
  const { rows, cols, types, source } = board;
  const on = new Set<number>();
  const start = source * cols;
  if (!(openings(types[start], rot[start]) & W)) return on;
  const queue = [start];
  on.add(start);
  while (queue.length) {
    const cell = queue.shift()!;
    const r = Math.floor(cell / cols), c = cell % cols;
    const m = openings(types[cell], rot[cell]);
    for (const d of DIRS) {
      if (!(m & d.bit)) continue;
      const nr = r + d.dr, nc = c + d.dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const next = nr * cols + nc;
      if (on.has(next) || !(openings(types[next], rot[next]) & d.opp)) continue;
      on.add(next);
      queue.push(next);
    }
  }
  return on;
}

export function coreReached(board: Board, rot: number[]): boolean {
  const last = board.core * board.cols + board.cols - 1;
  return powered(board, rot).has(last) && (openings(board.types[last], rot[last]) & E) !== 0;
}
