import {
  accessNodes, blockAt, doorInfo, getCity, isBlocked, lobbyLayout, nodeId, pointOnEdge, roadDistance, roadPos, shortestPath,
  type Building, type Edge, GRID, PITCH, ROAD,
} from "../../shared/city";
import { CITY_VERSION } from "../../shared/city";
import {
  courierPos, loopLength, releaseKeysFor, UPLINK_RADIUS,
  type CourierPublic, type HackType, type Hurdle, type MissionOp, type MissionPublic, type Pt, type ShardPublic, type Spawn, type SpawnGroup, type VaultPublic,
} from "../../shared/mission";
import { HACK_TYPES, HACKS, type HackBand } from "../hacks";
import type { Rng } from "../rng";
import { sha256 } from "../rng";
import type { Band, GeneratedMission, GenInputs, MissionTemplate, Validation } from "../types";

/*
 * CITY HEIST — the 3D mission.
 * NULL has locked data cores inside vault lobbies around Neon City. Reach each vault,
 * fight past the guards, hack the terminal, grab the core, then carry every core to an
 * uplink tower and hold the zone while the upload runs.
 *
 * Everything that changes between players comes from the seed: the operation type
 * (Vault Run, Titan Hunt, Data Truck Chase or Blitz), the safehouse you start at, which
 * buildings are vaults, the uplink, barricaded roads, laser fences, turrets, robot
 * squads, the Titan boss, the data truck's route, bonus data shards and the hack
 * puzzles. The validator re-checks that every vault, the truck's loop and the uplink are
 * reachable around the barricades, that the route fits the timer, and that every hack
 * puzzle has exactly one answer.
 */

export interface HackAttempt { type: HackType; round: unknown; key: unknown; tag: string; explain: string }
export interface HeistKey { hacks: Record<string, HackAttempt[]> }
export type Heist = GeneratedMission<MissionPublic, HeistKey>;

const CORES: Record<Band, number> = { 1: 2, 2: 3, 3: 3, 4: 4, 5: 4 };
const TIME: Record<Band, number> = { 1: 240, 2: 300, 3: 300, 4: 330, 5: 330 };
const UPLOAD: Record<Band, number> = { 1: 10, 2: 12, 3: 14, 4: 15, 5: 16 };
const BARRICADES: Record<Band, number> = { 1: 2, 2: 3, 3: 4, 4: 5, 5: 6 };
const FENCES: Record<Band, number> = { 1: 1, 2: 2, 3: 3, 4: 3, 5: 4 };
const TURRETS: Record<Band, number> = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4 };
const GUARDS_OUT: Record<Band, number> = { 1: 2, 2: 2, 3: 3, 4: 3, 5: 4 };
const GUARDS_IN: Record<Band, number> = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 2 };
const BRUTES_AT_VAULT: Record<Band, number> = { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 };
const DRONE_PATROLS: Record<Band, number> = { 1: 0, 2: 2, 3: 3, 4: 4, 5: 5 };
const ALARM_WALKERS: Record<Band, number> = { 1: 2, 2: 3, 3: 3, 4: 4, 5: 4 };
const ALARM_DRONES: Record<Band, number> = { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2 };
const WAVE1: Record<Band, number> = { 1: 3, 2: 4, 3: 5, 4: 6, 5: 7 };
const WAVE2_DRONES: Record<Band, number> = { 1: 1, 2: 2, 3: 2, 4: 3, 5: 3 };
const WAVE2_BRUTES: Record<Band, number> = { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2 };
export const HACK_BAND: Record<Band, HackBand> = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 3 };
const BRUTE_FORCE_SEC = 10;
const COURIER_SPEED: Record<Band, number> = { 1: 10, 2: 11.5, 3: 13, 4: 14.5, 5: 16 };
const COURIER_EXTRA_SEC = 50;
const TITAN_EXTRA_SEC = 20;
const SHARDS = 6;
/** Operation odds per band: more bosses and trucks at higher threat levels. */
const OP_WEIGHTS: Record<Band, [MissionOp, number][]> = {
  1: [["classic", 3], ["courier", 3], ["titan", 2]],
  2: [["classic", 2], ["courier", 3], ["titan", 3]],
  3: [["classic", 2], ["courier", 3], ["titan", 3], ["blitz", 1]],
  4: [["classic", 1], ["courier", 3], ["titan", 3], ["blitz", 3]],
  5: [["classic", 1], ["courier", 2], ["titan", 3], ["blitz", 4]],
};
const TRUCK_NAMES = ["NULL Hauler X9", "Data Truck ZERO", "Black Box 404", "Byte Bandit"];

const MIN_VAULT_FROM_START = 110;
const MIN_VAULT_FROM_UPLINK = 90;
const MIN_VAULT_SPACING = 130;
const MIN_UPLINK_FROM_START = 220;
/** Average speed assumed for the time check: driving with turns and traffic. */
const PLAN_SPEED = 16;
/** Per-vault allowance: park, fight in, hack, grab the core. */
const PER_VAULT_SEC = 28;
/** Extra allowance for beating a Titan and for catching the data truck. */
const TITAN_FIGHT_SEC = 30;
const CHASE_SEC = 40;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.z - b.z);

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((p) => [x, ...p]));
}

/** Shortest road route start -> all vaults (any order) -> uplink, in metres. */
export function bestRouteLength(start: Pt, vaults: Pt[], uplink: Pt, blocked: ReadonlySet<string>): number {
  let best = Infinity;
  for (const order of permutations(vaults)) {
    let total = 0;
    let at = start;
    for (const v of order) { total += roadDistance(at.x, at.z, v.x, v.z, blocked); at = v; }
    total += roadDistance(at.x, at.z, uplink.x, uplink.z, blocked);
    best = Math.min(best, total);
  }
  return best;
}

/** True if every target point can be reached from the start by road with these edges blocked. */
export function allReachable(start: Pt, targets: Pt[], blocked: ReadonlySet<string>): boolean {
  const from = accessNodes(start.x, start.z);
  return targets.every((t) => accessNodes(t.x, t.z).some((to) => from.some((f) => shortestPath(f, to, blocked) !== null)));
}

function uplinkEdges(block: [number, number]): string[] {
  const [j, l] = block;
  return [`h${j}_${l}`, `h${j}_${l + 1}`, `v${j}_${l}`, `v${j + 1}_${l}`];
}

function placeSpawn(rng: Rng, base: Pt, spread: number, tries = 12): Pt | null {
  for (let t = 0; t < tries; t++) {
    const p = { x: base.x + rng.range(-spread, spread), z: base.z + rng.range(-spread, spread) };
    if (!isBlocked(p.x, p.z, 1)) return p;
  }
  return isBlocked(base.x, base.z, 1) ? null : base;
}

/** The closed road loop around a 2 x 2 group of blocks with corner node (i, k), as points and edge ids. */
export function loopAround(i: number, k: number, clockwise: boolean): { pts: Pt[]; edges: string[] } {
  const nodes: [number, number][] = [[i, k], [i + 1, k], [i + 2, k], [i + 2, k + 1], [i + 2, k + 2], [i + 1, k + 2], [i, k + 2], [i, k + 1]];
  const order = clockwise ? nodes : [nodes[0], ...nodes.slice(1).reverse()];
  const pts = order.map(([a, b]) => ({ x: roadPos(a), z: roadPos(b) }));
  const edges = order.map(([a, b], n) => {
    const [c, d] = order[(n + 1) % order.length];
    return b === d ? `h${Math.min(a, c)}_${b}` : `v${a}_${Math.min(b, d)}`;
  });
  return { pts, edges };
}

/** Edge id of the road segment between two loop points, or null if they aren't neighbours on one road. */
function edgeBetween(a: Pt, b: Pt): string | null {
  const city = getCity();
  const na = city.nodes.find((n) => Math.abs(n.x - a.x) < 0.01 && Math.abs(n.z - a.z) < 0.01);
  const nb = city.nodes.find((n) => Math.abs(n.x - b.x) < 0.01 && Math.abs(n.z - b.z) < 0.01);
  if (!na || !nb) return null;
  return city.adjacency[na.id].find((e) => city.adjacency[nb.id].includes(e)) ?? null;
}

function generateCandidate(rng: Rng, inputs: GenInputs): Heist | null {
  const band = inputs.band;
  const city = getCity();
  const focus = inputs.focusTags;

  // 1. Start at one of the four safehouses.
  const safe = rng.pick(city.buildings.filter((b) => b.name === "Safehouse"));
  const sd = doorInfo(safe);
  const start = { x: sd.outside.x + sd.normal[0] * 2, z: sd.outside.z + sd.normal[1] * 2, heading: Math.atan2(sd.normal[0], sd.normal[1]) };
  // Car parked in the near lane of the road the safehouse faces, pointing with traffic.
  const roadX = sd.edge.horizontal ? null : sd.edge.x0;
  const roadZ = sd.edge.horizontal ? sd.edge.z0 : null;
  const startCar = roadX !== null
    ? { x: roadX - sd.normal[0] * 7, z: start.z + 6, heading: sd.normal[0] > 0 ? Math.PI : 0, variant: rng.int(0, 2) }
    : { x: start.x + 6, z: (roadZ as number) - sd.normal[1] * 7, heading: sd.normal[1] > 0 ? Math.PI / 2 : -Math.PI / 2, variant: rng.int(0, 2) };

  // 2. Uplink plaza, far from the start.
  const plazas = city.blocks.filter((b) => b.kind === "plaza" && dist(b, start) >= MIN_UPLINK_FROM_START);
  if (!plazas.length) return null;
  const plaza = rng.pick(plazas);
  const uplink = { x: plaza.x, z: plaza.z, radius: UPLINK_RADIUS, name: `Uplink ${String.fromCharCode(65 + city.blocks.filter((b) => b.kind === "plaza").indexOf(plaza))}`, block: [plaza.j, plaza.l] as [number, number] };

  // 3. Vault buildings, spread out.
  const want = CORES[band];
  const candidates = rng.shuffle(city.buildings.filter((b) => b.lobby && blockAt(b.block[0], b.block[1])?.kind === "buildings"));
  const chosen: { b: Building; door: Pt }[] = [];
  for (const b of candidates) {
    if (chosen.length >= want) break;
    const di = doorInfo(b);
    const door = di.door;
    if (dist(door, start) < MIN_VAULT_FROM_START || dist(door, uplink) < MIN_VAULT_FROM_UPLINK) continue;
    if (chosen.some((c) => dist(c.door, door) < MIN_VAULT_SPACING || (c.b.block[0] === b.block[0] && c.b.block[1] === b.block[1]))) continue;
    chosen.push({ b, door });
  }
  if (chosen.length < want) return null;

  // 4. Operation type. A Titan takes the place of one vault's hack; a data truck adds a core.
  const op = rng.weighted(OP_WEIGHTS[band].map(([item, weight]) => ({ item, weight })));
  const titanAt = op === "titan" || op === "blitz" ? rng.int(0, want - 1) : -1;
  const hasCourier = op === "courier" || op === "blitz";

  // Hack types: every type appears before any repeats; practice focus leans the choice.
  const typeWeight = (t: HackType) => 1 + (focus.some((f) => f.startsWith(`hack:${t}`)) ? 2 : 0);
  const pool = [...HACK_TYPES];
  const types: HackType[] = [];
  while (types.length < want) {
    const src = pool.length ? pool : HACK_TYPES;
    const t = rng.weighted(src.map((x) => ({ item: x, weight: typeWeight(x) })));
    types.push(t);
    const i = pool.indexOf(t);
    if (i >= 0) pool.splice(i, 1);
  }

  const vaults: VaultPublic[] = chosen.map(({ b, door }, i) => {
    const lay = lobbyLayout(b);
    const hb = HACK_BAND[band];
    return {
      id: `v${i}`, buildingId: b.id, name: b.name, side: b.door!, door,
      terminal: lay.terminal, core: lay.core, hackType: types[i], hackTimeMs: HACKS[types[i]].timeLimitMs(hb),
      ...(i === titanAt ? { lock: "titan" as const } : {}),
    };
  });

  // 4b. The data truck's loop: a ring of roads around 2 x 2 blocks, away from the start.
  let courier: CourierPublic | null = null;
  let courierEdges: string[] = [];
  if (hasCourier) {
    for (let t = 0; t < 20 && !courier; t++) {
      const i0 = rng.int(0, GRID - 2), k0 = rng.int(0, GRID - 2);
      const lp = loopAround(i0, k0, rng.chance(0.5));
      const cx = lp.pts.reduce((n, p) => n + p.x, 0) / lp.pts.length, cz = lp.pts.reduce((n, p) => n + p.z, 0) / lp.pts.length;
      if (dist({ x: cx, z: cz }, start) < 170) continue;
      const total = loopLength(lp.pts);
      const c: CourierPublic = { id: "k0", name: rng.pick(TRUCK_NAMES), loop: lp.pts, speed: COURIER_SPEED[band], offset: +rng.range(0, total).toFixed(1), hp: 300 + band * 40 };
      if (dist(courierPos(c, 0), start) < 140) continue;
      courier = c;
      courierEdges = lp.edges;
    }
    if (!courier) return null;
  }

  // 5. Barricades on random roads, never cutting off a vault, the uplink or the start.
  const protectedEdges = new Set<string>([sd.edge.id, ...chosen.map((c) => doorInfo(c.b).edge.id), ...uplinkEdges(uplink.block), ...courierEdges]);
  const blocked = new Set<string>();
  const targets: Pt[] = [...vaults.map((v) => v.door), uplink, ...(courier ? courier.loop : [])];
  for (const e of rng.shuffle(city.edges)) {
    if (blocked.size >= BARRICADES[band]) break;
    if (protectedEdges.has(e.id)) continue;
    blocked.add(e.id);
    if (!allReachable(start, targets, blocked)) blocked.delete(e.id);
  }
  if (blocked.size < BARRICADES[band]) return null;
  const hurdleAt = (e: Edge, id: string, span: number): Hurdle => {
    const p = pointOnEdge(e, 0.5);
    return { id, edge: e.id, x: p.x, z: p.z, horizontal: e.horizontal, span };
  };
  const barricades = [...blocked].map((id, i) => hurdleAt(city.edgeById.get(id)!, `bar${i}`, 26));

  // 6. Laser fences on roads the player is likely to use.
  const onRoute = new Set<string>();
  const legs: [Pt, Pt][] = [[start, vaults[0].door], ...vaults.slice(1).map((v, i) => [vaults[i].door, v.door] as [Pt, Pt]), [vaults[vaults.length - 1].door, uplink]];
  for (const [a, b] of legs) {
    const from = accessNodes(a.x, a.z)[0], to = accessNodes(b.x, b.z)[0];
    const p = shortestPath(from, to, blocked);
    if (!p) continue;
    for (let i = 0; i + 1 < p.nodes.length; i++) {
      const eid = city.adjacency[p.nodes[i]].find((x) => { const e = city.edgeById.get(x)!; return (e.a === p.nodes[i] && e.b === p.nodes[i + 1]) || (e.b === p.nodes[i] && e.a === p.nodes[i + 1]); });
      if (eid && !protectedEdges.has(eid) && !blocked.has(eid)) onRoute.add(eid);
    }
  }
  const fenceEdges = rng.shuffle([...onRoute]).slice(0, FENCES[band]);
  if (fenceEdges.length < Math.min(FENCES[band], 1)) return null;
  const fences = fenceEdges.map((id, i) => hurdleAt(city.edgeById.get(id)!, `fence${i}`, 26));

  // 7. Turrets on street corners near vaults.
  const turrets: (Pt & { id: string })[] = [];
  for (let i = 0; i < TURRETS[band]; i++) {
    const v = vaults[i % vaults.length];
    const node = city.nodes[rng.pick(accessNodes(v.door.x, v.door.z))];
    let placed: Pt | null = null;
    for (const [sx, sz] of rng.shuffle([[1, 1], [1, -1], [-1, 1], [-1, -1]])) {
      const p = { x: node.x + sx * 11.5, z: node.z + sz * 11.5 };
      if (!isBlocked(p.x, p.z, 1) && !turrets.some((t) => dist(t, p) < 6)) { placed = p; break; }
    }
    if (!placed) continue;
    turrets.push({ id: `t${i}`, ...placed });
  }

  // 8. Robot squads.
  let rid = 0;
  const groups: SpawnGroup[] = [];
  const add = (id: string, release: string, spawns: Spawn[]) => { if (spawns.length) groups.push({ id, release, spawns }); };
  const mk = (kind: Spawn["kind"], p: Pt | null, extra: Partial<Spawn> = {}): Spawn[] => (p ? [{ id: `r${rid++}`, kind, x: +p.x.toFixed(2), z: +p.z.toFixed(2), ...extra }] : []);
  for (const [i, v] of vaults.entries()) {
    const di = doorInfo(chosen[i].b);
    const out: Spawn[] = [];
    const front = { x: di.door.x + di.normal[0] * 7, z: di.door.z + di.normal[1] * 7 };
    if (v.lock === "titan") {
      // The Titan stands guard on the street in front of its vault, with a couple of walkers.
      const boss = mk("titan", placeSpawn(rng, { x: di.door.x + di.normal[0] * 11, z: di.door.z + di.normal[1] * 11 }, 3));
      if (!boss.length) return null;
      v.guard = boss[0].id;
      add(`g-${v.id}-titan`, "start", boss);
      for (let g = 0; g < Math.max(1, GUARDS_OUT[band] - 1); g++) out.push(...mk("walker", placeSpawn(rng, front, 6)));
      add(`g-${v.id}-out`, "start", out);
      continue;
    }
    for (let g = 0; g < GUARDS_OUT[band]; g++) out.push(...mk("walker", placeSpawn(rng, front, 6)));
    for (let g = 0; g < BRUTES_AT_VAULT[band]; g++) out.push(...mk("brute", placeSpawn(rng, front, 5)));
    add(`g-${v.id}-out`, "start", out);
    const lay = lobbyLayout(chosen[i].b);
    add(`g-${v.id}-in`, "start", lay.guards.slice(0, GUARDS_IN[band]).flatMap((p) => mk("walker", p)));
    for (let n = 1; n <= 3; n++) {
      const road = pointOnEdge(di.edge, rng.range(0.3, 0.7));
      const alarm: Spawn[] = [];
      for (let g = 0; g < ALARM_WALKERS[band]; g++) alarm.push(...mk("walker", placeSpawn(rng, road, 7)));
      for (let g = 0; g < ALARM_DRONES[band]; g++) alarm.push(...mk("drone", placeSpawn(rng, road, 6), { y: 9 }));
      add(`g-${v.id}-a${n}`, `alarm:${v.id}:${n}`, alarm);
    }
  }
  const patrol: Spawn[] = [];
  for (let d = 0; d < DRONE_PATROLS[band]; d++) {
    const i = rng.int(1, GRID - 1), k = rng.int(1, GRID - 1);
    const a = city.nodes[nodeId(i, k)];
    const nb = city.nodes[rng.pick([nodeId(i + 1, k), nodeId(i, k + 1), nodeId(i - 1, k), nodeId(i, k - 1)])];
    patrol.push(...mk("drone", { x: a.x, z: a.z }, { y: 10, patrol: [{ x: a.x, z: a.z }, { x: nb.x, z: nb.z }] }));
  }
  add("g-patrol", "start", patrol);
  const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sz]) => ({ x: uplink.x + sx * 28, z: uplink.z + sz * 28 }));
  const w1: Spawn[] = [];
  for (let g = 0; g < WAVE1[band]; g++) w1.push(...mk("walker", placeSpawn(rng, corners[g % 4], 3)));
  add("g-up1", "uplink:1", w1);
  const w2: Spawn[] = [];
  for (let g = 0; g < WAVE2_DRONES[band]; g++) w2.push(...mk("drone", placeSpawn(rng, corners[(g + 1) % 4], 4), { y: 11 }));
  for (let g = 0; g < WAVE2_BRUTES[band]; g++) w2.push(...mk("brute", placeSpawn(rng, corners[(g + 2) % 4], 3)));
  add("g-up2", "uplink:2", w2);

  // 9. Bonus data shards on sidewalks, spread across the city.
  const shards: ShardPublic[] = [];
  for (let t = 0; t < 200 && shards.length < SHARDS; t++) {
    const e = rng.pick(city.edges);
    const p = pointOnEdge(e, rng.range(0.25, 0.75), (rng.chance(0.5) ? 1 : -1) * (ROAD / 2 + 2));
    if (isBlocked(p.x, p.z, 1)) continue;
    if (dist(p, start) < 30 || shards.some((s) => dist(s, p) < 70)) continue;
    shards.push({ id: `s${shards.length}`, x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
  }

  // 10. Hack puzzles: three attempts per hackable vault, each with exactly one answer.
  const hacks: Record<string, HackAttempt[]> = {};
  for (const v of vaults) {
    if (v.lock === "titan") continue;
    const mod = HACKS[v.hackType];
    hacks[v.id] = [];
    for (let a = 0; a < 3; a++) {
      const built = mod.build(rng, HACK_BAND[band], focus);
      if (!built) return null;
      hacks[v.id].push({ type: v.hackType, round: built.round, key: built.key, tag: built.tag, explain: built.explain });
    }
  }

  const timeLimitSec = TIME[band] + (courier ? COURIER_EXTRA_SEC : 0) + (titanAt >= 0 ? TITAN_EXTRA_SEC : 0);
  const mission: MissionPublic = {
    kind: "city-heist",
    cityVersion: CITY_VERSION,
    band,
    timeLimitSec,
    lives: 3,
    uploadSec: UPLOAD[band],
    bruteForceSec: BRUTE_FORCE_SEC,
    start: { x: +start.x.toFixed(2), z: +start.z.toFixed(2), heading: +start.heading.toFixed(4) },
    startCar: { ...startCar, x: +startCar.x.toFixed(2), z: +startCar.z.toFixed(2) },
    vaults,
    uplink,
    barricades,
    fences,
    turrets,
    groups,
    op,
    courier,
    shards,
  };
  const fp = {
    city: CITY_VERSION,
    band,
    op,
    courier: courier ? `${courierEdges.slice().sort().join(",")}@${Math.round(courier.offset / 50)}` : null,
    start: safe.id,
    uplink: uplink.block,
    vaults: vaults.map((v) => `${v.buildingId}:${v.lock === "titan" ? "titan" : v.hackType}`).sort(),
    barricades: [...blocked].sort(),
    fences: fenceEdges.slice().sort(),
    hacks: vaults.filter((v) => hacks[v.id]).map((v) => hacks[v.id].map((h) => sha256(HACKS[h.type].fingerprintInput(h.round)).slice(0, 12))).flat().sort(),
  };
  const hackTypes = vaults.filter((v) => v.lock !== "titan").map((v) => v.hackType);
  return {
    variant: `b${band}-${op}-${safe.id}-${uplink.block.join("")}`,
    tags: Array.from(new Set(["city", `op:${op}`, ...hackTypes.map((t) => `hack:${t}`)])),
    publicPuzzle: mission,
    answerKey: { hacks },
    fingerprint: sha256(`city-heist|${JSON.stringify(fp)}`),
    timeLimitSec,
  };
}

export function validateHeist(m: Heist): Validation {
  const p = m.publicPuzzle;
  const city = getCity();
  if (p.kind !== "city-heist" || p.cityVersion !== CITY_VERSION) return { ok: false, reason: "wrong city version" };
  if (p.vaults.length < 2) return { ok: false, reason: "too few vaults" };
  if (isBlocked(p.start.x, p.start.z, 0.3)) return { ok: false, reason: "start point is inside a building" };

  const seenBuildings = new Set<string>();
  for (const v of p.vaults) {
    const b = city.buildingById.get(v.buildingId);
    if (!b || !b.lobby) return { ok: false, reason: `vault ${v.id} is not a lobby building` };
    if (seenBuildings.has(b.id)) return { ok: false, reason: "two vaults share a building" };
    seenBuildings.add(b.id);
    if (dist(v.door, p.start) < MIN_VAULT_FROM_START) return { ok: false, reason: `vault ${v.id} too close to start` };
    if (dist(v.door, p.uplink) < MIN_VAULT_FROM_UPLINK) return { ok: false, reason: `vault ${v.id} too close to uplink` };
  }
  for (let i = 0; i < p.vaults.length; i++) for (let j = i + 1; j < p.vaults.length; j++) {
    if (dist(p.vaults[i].door, p.vaults[j].door) < MIN_VAULT_SPACING) return { ok: false, reason: "vaults too close together" };
  }

  const blocked = new Set(p.barricades.map((b) => b.edge));
  if ([...blocked].some((e) => !city.edgeById.has(e))) return { ok: false, reason: "barricade on unknown road" };
  if (!allReachable(p.start, [...p.vaults.map((v) => v.door), p.uplink], blocked)) return { ok: false, reason: "barricades cut off an objective" };

  // Data truck: a closed loop of real, open roads, at a speed a car can catch.
  const c = p.courier ?? null;
  if (c) {
    if (c.loop.length < 4) return { ok: false, reason: "truck loop too short" };
    if (!(c.speed > 0 && c.speed <= 20)) return { ok: false, reason: "truck too fast to catch" };
    if (!(c.hp > 0)) return { ok: false, reason: "truck has no armour value" };
    const fenced = new Set(p.fences.map((f) => f.edge));
    for (let i = 0; i < c.loop.length; i++) {
      const e = edgeBetween(c.loop[i], c.loop[(i + 1) % c.loop.length]);
      if (!e) return { ok: false, reason: "truck loop leaves the roads" };
      if (blocked.has(e) || fenced.has(e)) return { ok: false, reason: "truck loop is barricaded" };
    }
    if (!allReachable(p.start, c.loop, blocked)) return { ok: false, reason: "truck loop cut off" };
  }

  // Titan vaults: guarded by exactly one Titan that is there from the start.
  const startSpawns = new Map(p.groups.filter((g) => g.release === "start").flatMap((g) => g.spawns.map((s) => [s.id, s] as const)));
  for (const v of p.vaults) {
    if (v.lock !== "titan") continue;
    const boss = v.guard ? startSpawns.get(v.guard) : undefined;
    if (!boss || boss.kind !== "titan") return { ok: false, reason: `vault ${v.id} has no Titan guard` };
  }

  for (const s of p.shards ?? []) {
    if (isBlocked(s.x, s.z, 0.5)) return { ok: false, reason: `shard ${s.id} is inside a wall` };
  }
  if ((p.shards ?? []).length > 12) return { ok: false, reason: "too many shards" };

  const route = bestRouteLength(p.start, p.vaults.map((v) => v.door), p.uplink, blocked);
  const titans = p.vaults.filter((v) => v.lock === "titan").length;
  const chase = c ? Math.min(...c.loop.map((q) => roadDistance(p.start.x, p.start.z, q.x, q.z, blocked))) / PLAN_SPEED + CHASE_SEC : 0;
  const estimate = route / PLAN_SPEED + p.vaults.length * PER_VAULT_SEC + titans * TITAN_FIGHT_SEC + chase + p.uploadSec + 30;
  if (!(estimate <= p.timeLimitSec * 0.8)) return { ok: false, reason: `route too long for the timer (${Math.round(estimate)}s of ${p.timeLimitSec}s)` };

  const ids = new Set<string>();
  const releases = new Set(releaseKeysFor(p.vaults));
  for (const g of p.groups) {
    if (!releases.has(g.release)) return { ok: false, reason: `group ${g.id} has unknown release ${g.release}` };
    for (const s of g.spawns) {
      if (ids.has(s.id)) return { ok: false, reason: `duplicate robot id ${s.id}` };
      ids.add(s.id);
      if (s.kind !== "drone" && isBlocked(s.x, s.z, 0.5)) {
        // Inner guards stand inside a vault lobby, which is a building footprint by design.
        const inVault = p.vaults.some((v) => { const b = city.buildingById.get(v.buildingId)!; return Math.abs(s.x - b.x) < b.w / 2 - 0.5 && Math.abs(s.z - b.z) < b.d / 2 - 0.5; });
        if (!inVault) return { ok: false, reason: `robot ${s.id} spawns inside a wall` };
      }
    }
  }
  for (const t of p.turrets) {
    if (ids.has(t.id)) return { ok: false, reason: `duplicate id ${t.id}` };
    ids.add(t.id);
  }
  if (c && ids.has(c.id)) return { ok: false, reason: `duplicate id ${c.id}` };

  for (const v of p.vaults) {
    if (v.lock === "titan") continue;
    const attempts = m.answerKey.hacks[v.id];
    if (!attempts || attempts.length !== 3) return { ok: false, reason: `vault ${v.id} needs three hack puzzles` };
    for (const a of attempts) {
      if (a.type !== v.hackType) return { ok: false, reason: "hack type mismatch" };
      const r = HACKS[a.type].validate(a.round, a.key);
      if (!r.ok) return { ok: false, reason: `vault ${v.id} hack: ${r.reason}` };
    }
  }
  return { ok: true };
}

export const cityHeist: MissionTemplate<MissionPublic, HeistKey> = {
  id: "city-heist",
  version: 2,
  title: "Neon City Heist",
  generateCandidate,
  validate: validateHeist,
};

// Exposed for tests.
export const __heist = { roadPos, PITCH };
