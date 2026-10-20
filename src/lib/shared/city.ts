import { Prng } from "./prng";

/*
 * NEON CITY — the fixed map every mission takes place in.
 *
 * Generated from a constant seed, so the browser (which draws it and runs collisions)
 * and the server (which places mission objectives and checks travel times) always
 * agree on every road, building and plaza. Bump CITY_VERSION if the layout changes.
 *
 * Coordinates are metres. x runs east, z runs south, y is up. The map is a 7 x 7
 * grid of blocks with roads between them and a ring road around the edge.
 */

export const CITY_VERSION = 1;
const CITY_SEED = "neon-city-v1";

export const GRID = 7;
export const ROAD = 18;
export const SIDEWALK = 4;
export const BLOCK = 66;
export const PITCH = BLOCK + ROAD;
export const SIZE = GRID * PITCH + ROAD;
export const HALF = SIZE / 2;
export const FLOOR_H = 3.5;
export const LOBBY_H = 7;
/** Lane centre offsets from the road centre line (two lanes each way). */
export const LANES = [3, 7];

export type Side = "px" | "nx" | "pz" | "nz";
export const SIDE_NORMAL: Record<Side, [number, number]> = { px: [1, 0], nx: [-1, 0], pz: [0, 1], nz: [0, -1] };

export interface Building {
  id: string;
  block: [number, number];
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  style: number;
  /** Street-facing side used for the entrance, if any. */
  door: Side | null;
  /** Big enough to have an enterable ground-floor lobby (vault candidates). */
  lobby: boolean;
  name: string;
  antenna: boolean;
}

export type BlockKind = "buildings" | "spire" | "safehouse" | "plaza" | "park";

export interface CityBlock {
  j: number;
  l: number;
  kind: BlockKind;
  x: number;
  z: number;
}

export interface Tree { x: number; z: number; r: number; h: number }

export interface Edge {
  id: string;
  a: number;
  b: number;
  horizontal: boolean;
  /** Road centre line from node a to node b. */
  x0: number; z0: number; x1: number; z1: number;
}

export interface City {
  version: number;
  buildings: Building[];
  blocks: CityBlock[];
  trees: Tree[];
  nodes: { id: number; i: number; k: number; x: number; z: number }[];
  edges: Edge[];
  /** Edge ids touching each node. */
  adjacency: string[][];
  edgeById: Map<string, Edge>;
  buildingById: Map<string, Building>;
}

export function roadPos(i: number): number {
  return -HALF + ROAD / 2 + i * PITCH;
}

export function blockCenter(j: number): number {
  return roadPos(j) + PITCH / 2;
}

export function nodeId(i: number, k: number): number {
  return i + k * (GRID + 1);
}

const SPECIAL: Record<string, BlockKind> = {
  "3,3": "spire",
  "0,0": "safehouse", "6,0": "safehouse", "0,6": "safehouse", "6,6": "safehouse",
  "3,0": "plaza", "0,3": "plaza", "6,3": "plaza", "3,6": "plaza", "1,5": "plaza", "5,1": "plaza",
  "2,4": "park", "4,2": "park",
};

const NAME_A = ["Neon", "Quantum", "Pixel", "Cyber", "Holo", "Byte", "Nano", "Laser", "Turbo", "Astra", "Vector", "Chrome", "Orbit", "Sonic", "Matrix", "Volt"];
const NAME_B = ["Bank", "Tower", "Mall", "Labs", "Hub", "Archive", "Exchange", "Studios", "Server Farm", "Plaza", "Clinic", "Bazaar", "Arcade", "Data Centre", "Metro House", "Dhaba"];

function buildCity(): City {
  const rng = new Prng(CITY_SEED);
  const buildings: Building[] = [];
  const blocks: CityBlock[] = [];
  const trees: Tree[] = [];
  const usedNames = new Set<string>();
  const inner = BLOCK - 2 * SIDEWALK;

  const nameFor = () => {
    for (let t = 0; t < 50; t++) {
      const n = `${rng.pick(NAME_A)} ${rng.pick(NAME_B)}`;
      if (!usedNames.has(n)) { usedNames.add(n); return n; }
    }
    const n = `Tower ${usedNames.size + 1}`;
    usedNames.add(n);
    return n;
  };

  for (let l = 0; l < GRID; l++) {
    for (let j = 0; j < GRID; j++) {
      const cx = blockCenter(j), cz = blockCenter(l);
      const kind = SPECIAL[`${j},${l}`] ?? "buildings";
      blocks.push({ j, l, kind, x: cx, z: cz });
      const ix0 = cx - inner / 2, iz0 = cz - inner / 2;

      if (kind === "park") {
        for (let t = 0; t < 14; t++) trees.push({ x: rng.range(ix0 + 4, ix0 + inner - 4), z: rng.range(iz0 + 4, iz0 + inner - 4), r: 0.5, h: rng.range(5, 9) });
        continue;
      }
      if (kind !== "buildings") continue;

      const dist = Math.hypot(cx, cz) / HALF;
      const tall = Math.max(0, 1 - dist);
      const pattern = rng.pick(["single", "halvesX", "halvesZ", "quads", "quads", "three"] as const);
      const lots: [number, number, number, number][] = []; // x0, z0, w, d inside the block
      const half = inner / 2;
      if (pattern === "single") lots.push([0, 0, inner, inner]);
      else if (pattern === "halvesX") lots.push([0, 0, half, inner], [half, 0, half, inner]);
      else if (pattern === "halvesZ") lots.push([0, 0, inner, half], [0, half, inner, half]);
      else if (pattern === "quads") lots.push([0, 0, half, half], [half, 0, half, half], [0, half, half, half], [half, half, half, half]);
      else lots.push([0, 0, half, inner], [half, 0, half, half], [half, half, half, half]);

      lots.forEach(([lx, lz, lw, ld], k) => {
        const gap = 2.5;
        const x0 = ix0 + lx + (lx > 0 ? gap : 1);
        const z0 = iz0 + lz + (lz > 0 ? gap : 1);
        const x1 = ix0 + lx + lw - (lx + lw < inner ? gap : 1);
        const z1 = iz0 + lz + ld - (lz + ld < inner ? gap : 1);
        const w = x1 - x0, d = z1 - z0;
        const small = w * d < 900;
        const base = 18 + 135 * Math.pow(tall, 1.25);
        let h = base * rng.range(0.55, 1.2) * (small ? 0.75 : 1);
        h = Math.max(14, Math.round(h / FLOOR_H) * FLOOR_H);
        const sides: Side[] = [];
        if (lx === 0) sides.push("nx");
        if (lx + lw >= inner) sides.push("px");
        if (lz === 0) sides.push("nz");
        if (lz + ld >= inner) sides.push("pz");
        const door = sides.length ? rng.pick(sides) : null;
        const lobby = !!door && w >= 20 && d >= 20 && h >= 21;
        buildings.push({
          id: `b${j}${l}${k}`,
          block: [j, l],
          x: (x0 + x1) / 2,
          z: (z0 + z1) / 2,
          w, d, h,
          style: rng.int(0, 4),
          door,
          lobby,
          name: lobby ? nameFor() : "",
          antenna: h > 60 && rng.chance(0.6),
        });
      });
    }
  }

  // Safehouse garages: low building facing the city centre.
  for (const b of blocks.filter((x) => x.kind === "safehouse")) {
    const toCx: Side = b.x < 0 ? "px" : "nx";
    const w = 26, d = 22;
    const off = (BLOCK / 2 - SIDEWALK - w / 2 - 6) * (toCx === "px" ? -1 : 1);
    buildings.push({ id: `safe${b.j}${b.l}`, block: [b.j, b.l], x: b.x + off, z: b.z, w, d, h: 10.5, style: 1, door: toCx, lobby: false, name: "Safehouse", antenna: true });
  }

  // Road graph.
  const nodes: City["nodes"] = [];
  for (let k = 0; k <= GRID; k++) for (let i = 0; i <= GRID; i++) nodes.push({ id: nodeId(i, k), i, k, x: roadPos(i), z: roadPos(k) });
  const edges: Edge[] = [];
  for (let k = 0; k <= GRID; k++) {
    for (let i = 0; i <= GRID; i++) {
      if (i < GRID) edges.push({ id: `h${i}_${k}`, a: nodeId(i, k), b: nodeId(i + 1, k), horizontal: true, x0: roadPos(i), z0: roadPos(k), x1: roadPos(i + 1), z1: roadPos(k) });
      if (k < GRID) edges.push({ id: `v${i}_${k}`, a: nodeId(i, k), b: nodeId(i, k + 1), horizontal: false, x0: roadPos(i), z0: roadPos(k), x1: roadPos(i), z1: roadPos(k + 1) });
    }
  }
  const adjacency: string[][] = nodes.map(() => []);
  for (const e of edges) { adjacency[e.a].push(e.id); adjacency[e.b].push(e.id); }

  return {
    version: CITY_VERSION,
    buildings,
    blocks,
    trees,
    nodes,
    edges,
    adjacency,
    edgeById: new Map(edges.map((e) => [e.id, e])),
    buildingById: new Map(buildings.map((b) => [b.id, b])),
  };
}

let cached: City | null = null;
export function getCity(): City {
  if (!cached) cached = buildCity();
  return cached;
}

// ---------------------------------------------------------------- geometry helpers

export function blockAt(j: number, l: number): CityBlock | undefined {
  return getCity().blocks.find((b) => b.j === j && b.l === l);
}

/** The road edge a building side faces, and the point on the sidewalk in front of its centre. */
export function doorInfo(b: Building, side: Side = b.door ?? "px"): { edge: Edge; door: { x: number; z: number }; outside: { x: number; z: number }; normal: [number, number] } {
  const [nx, nz] = SIDE_NORMAL[side];
  const fx = b.x + nx * (b.w / 2), fz = b.z + nz * (b.d / 2);
  const [j, l] = b.block;
  const city = getCity();
  let edge: Edge;
  if (side === "px" || side === "nx") {
    const i = side === "px" ? j + 1 : j;
    edge = city.edgeById.get(`v${i}_${l}`)!;
  } else {
    const k = side === "pz" ? l + 1 : l;
    edge = city.edgeById.get(`h${j}_${k}`)!;
  }
  return { edge, door: { x: fx, z: fz }, outside: { x: fx + nx * 3, z: fz + nz * 3 }, normal: [nx, nz] };
}

export function nearestNode(x: number, z: number): number {
  const i = Math.max(0, Math.min(GRID, Math.round((x - roadPos(0)) / PITCH)));
  const k = Math.max(0, Math.min(GRID, Math.round((z - roadPos(0)) / PITCH)));
  return nodeId(i, k);
}

/** Nodes at both ends of the road a point is on (or the nearest node twice). */
export function accessNodes(x: number, z: number): number[] {
  const city = getCity();
  let best: Edge | null = null;
  let bestD = Infinity;
  for (const e of city.edges) {
    const d = distToSegment(x, z, e.x0, e.z0, e.x1, e.z1);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best ? [best.a, best.b] : [nearestNode(x, z)];
}

export function distToSegment(px: number, pz: number, x0: number, z0: number, x1: number, z1: number): number {
  const dx = x1 - x0, dz = z1 - z0;
  const len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / len2)) : 0;
  return Math.hypot(px - (x0 + t * dx), pz - (z0 + t * dz));
}

/** Dijkstra over intersections, skipping blocked edges. Returns node ids and length in metres. */
export function shortestPath(from: number, to: number, blocked: ReadonlySet<string> = new Set()): { nodes: number[]; length: number } | null {
  const city = getCity();
  const dist = new Array(city.nodes.length).fill(Infinity);
  const prev = new Array<number>(city.nodes.length).fill(-1);
  const done = new Array(city.nodes.length).fill(false);
  dist[from] = 0;
  for (;;) {
    let u = -1;
    for (let n = 0; n < dist.length; n++) if (!done[n] && dist[n] < Infinity && (u < 0 || dist[n] < dist[u])) u = n;
    if (u < 0) break;
    if (u === to) break;
    done[u] = true;
    for (const eid of city.adjacency[u]) {
      if (blocked.has(eid)) continue;
      const e = city.edgeById.get(eid)!;
      const v = e.a === u ? e.b : e.a;
      const nd = dist[u] + PITCH;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; }
    }
  }
  if (dist[to] === Infinity) return null;
  const nodes: number[] = [];
  for (let n = to; n !== -1; n = prev[n]) nodes.unshift(n);
  return { nodes, length: dist[to] };
}

/** Road distance between two points, via their nearest road edges. */
export function roadDistance(ax: number, az: number, bx: number, bz: number, blocked: ReadonlySet<string> = new Set()): number {
  const city = getCity();
  let best = Infinity;
  for (const a of accessNodes(ax, az)) {
    for (const b of accessNodes(bx, bz)) {
      const p = shortestPath(a, b, blocked);
      if (!p) continue;
      const na = city.nodes[a], nb = city.nodes[b];
      best = Math.min(best, p.length + Math.hypot(ax - na.x, az - na.z) + Math.hypot(bx - nb.x, bz - nb.z));
    }
  }
  return best;
}

/** True if a point is inside a building footprint (grown by margin), the spire, or off the map. */
export function isBlocked(x: number, z: number, margin = 0): boolean {
  if (Math.abs(x) > HALF - 2 - margin || Math.abs(z) > HALF - 2 - margin) return true;
  const city = getCity();
  for (const b of city.buildings) {
    if (Math.abs(x - b.x) < b.w / 2 + margin && Math.abs(z - b.z) < b.d / 2 + margin) return true;
  }
  const spire = city.blocks.find((b) => b.kind === "spire")!;
  if (Math.abs(x - spire.x) < 17 + margin && Math.abs(z - spire.z) < 17 + margin) return true;
  for (const pz of city.blocks.filter((b) => b.kind === "plaza")) {
    if (Math.abs(x - pz.x) < 4 + margin && Math.abs(z - pz.z) < 4 + margin) return true;
  }
  return false;
}

/** Point on an edge's road at fraction t, offset sideways (positive = left of travel from a to b). */
export function pointOnEdge(e: Edge, t: number, side = 0): { x: number; z: number } {
  const dx = e.x1 - e.x0, dz = e.z1 - e.z0;
  const len = Math.hypot(dx, dz) || 1;
  // Left of the direction of travel: rotate (dx, dz) by -90 degrees in x-z.
  const lx = dz / len, lz = -dx / len;
  return { x: e.x0 + dx * t + lx * side, z: e.z0 + dz * t + lz * side };
}

/** Lobby interior points (for the terminal, core pedestal and guards), from the door inward. */
export function lobbyLayout(b: Building): { terminal: { x: number; z: number }; core: { x: number; z: number }; guards: { x: number; z: number }[]; inward: [number, number] } {
  const side = b.door ?? "px";
  const [nx, nz] = SIDE_NORMAL[side];
  const inward: [number, number] = [-nx, -nz];
  const depth = side === "px" || side === "nx" ? b.w : b.d;
  const across = side === "px" || side === "nx" ? b.d : b.w;
  const door = { x: b.x + nx * (b.w / 2), z: b.z + nz * (b.d / 2) };
  const at = (dIn: number, dSide: number) => ({
    x: door.x + inward[0] * dIn + (side === "px" || side === "nx" ? 0 : dSide),
    z: door.z + inward[1] * dIn + (side === "px" || side === "nx" ? dSide : 0),
  });
  return {
    terminal: at(Math.min(depth * 0.45, 9), 0),
    core: at(Math.min(depth - 4, 15), 0),
    guards: [at(Math.min(depth * 0.35, 7), across * 0.3), at(Math.min(depth * 0.6, 12), -across * 0.3)],
    inward,
  };
}
