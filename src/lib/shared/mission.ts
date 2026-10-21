import type { Side } from "./city";

/*
 * The public half of a mission: everything the browser needs to build and run it.
 * Hack puzzles and their answers are NOT in here; the server hands out each hack
 * puzzle only when the player starts that hack, and keeps the answers to itself.
 */

export type HackType = "glitch" | "power" | "imposter";
export type RobotKind = "walker" | "drone" | "brute" | "turret" | "titan" | "courier";

export interface Pt { x: number; z: number }

export interface Spawn {
  id: string;
  kind: RobotKind;
  x: number;
  z: number;
  y?: number;
  patrol?: Pt[];
}

/**
 * Robots appear in groups. A group's release key says when it becomes active:
 *   "start"            - when the mission begins
 *   "alarm:<vault>:<n>" - after the n-th failed hack at that vault
 *   "uplink:1" / "uplink:2" - when the upload starts
 */
export interface SpawnGroup {
  id: string;
  release: string;
  spawns: Spawn[];
}

export interface VaultPublic {
  id: string;
  buildingId: string;
  name: string;
  side: Side;
  door: Pt;
  terminal: Pt;
  core: Pt;
  hackType: HackType;
  hackTimeMs: number;
  /** "titan": no hack here; a Titan robot holds the lock and the core frees when it falls. */
  lock?: "hack" | "titan";
  /** Robot id of the Titan guarding this vault (lock "titan"). */
  guard?: string;
}

/**
 * NULL's armoured data truck. It drives a fixed loop of roads at a fixed speed, so the
 * browser and the server always agree where it is. Destroy it and its core drops.
 */
export interface CourierPublic {
  id: string;
  name: string;
  /** Closed loop of road points (centre line), driven in order. */
  loop: Pt[];
  speed: number;
  /** Metres along the loop at mission time 0. */
  offset: number;
  hp: number;
}

/** Optional bonus pickups scattered around the city. */
export interface ShardPublic { id: string; x: number; z: number }

export type MissionOp = "classic" | "titan" | "courier" | "blitz";

export const OP_INFO: Record<MissionOp, { title: string; blurb: string }> = {
  classic: { title: "Vault Run", blurb: "Vaults hack karo, cores lo, uplink tak pahuncho." },
  titan: { title: "Titan Hunt", blurb: "Ek vault ka lock TITAN robot ke paas hai. Use giraao, tabhi core milega!" },
  courier: { title: "Data Truck Chase", blurb: "NULL ka armoured truck ek core le ke shehar mein ghoom raha hai. Peecha karo aur use todo!" },
  blitz: { title: "Blitz", blurb: "Titan bhi, data truck bhi. Sabse mushkil operation!" },
};

export interface Hurdle {
  id: string;
  edge: string;
  x: number;
  z: number;
  /** True if the road runs along x (so the hurdle spans z). */
  horizontal: boolean;
  span: number;
}

export interface MissionPublic {
  kind: "city-heist";
  cityVersion: number;
  band: number;
  timeLimitSec: number;
  lives: number;
  uploadSec: number;
  bruteForceSec: number;
  start: Pt & { heading: number };
  startCar: Pt & { heading: number; variant: number };
  vaults: VaultPublic[];
  uplink: Pt & { radius: number; name: string; block: [number, number] };
  barricades: Hurdle[];
  fences: Hurdle[];
  turrets: (Pt & { id: string })[];
  groups: SpawnGroup[];
  /** Mission type (missing on missions made before v4: treat as "classic"). */
  op?: MissionOp;
  courier?: CourierPublic | null;
  shards?: ShardPublic[];
}

/** Every core the mission needs: one per vault plus the data truck's. */
export function coreIds(m: MissionPublic): string[] {
  return [...m.vaults.map((v) => v.id), ...(m.courier ? [m.courier.id] : [])];
}

export function loopLength(loop: Pt[]): number {
  let n = 0;
  for (let i = 0; i < loop.length; i++) { const a = loop[i], b = loop[(i + 1) % loop.length]; n += Math.hypot(b.x - a.x, b.z - a.z); }
  return n;
}

/** Where the data truck is (centre line) after `sec` seconds of mission time. */
export function courierPos(c: CourierPublic, sec: number): Pt & { heading: number } {
  const total = loopLength(c.loop);
  let d = (((c.offset + Math.max(0, sec) * c.speed) % total) + total) % total;
  for (let i = 0; i < c.loop.length; i++) {
    const a = c.loop[i], b = c.loop[(i + 1) % c.loop.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (d <= len || i === c.loop.length - 1) {
      const t = len ? Math.min(1, d / len) : 0;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, heading: Math.atan2(b.x - a.x, b.z - a.z) };
    }
    d -= len;
  }
  return { ...c.loop[0], heading: 0 };
}

/** Fastest anything can move across the map (car top speed is ~40 m/s). Used by the server's travel-time check. */
export const MAX_TRAVEL_SPEED = 52;
/** Slack added to every travel-time check, for respawns and network delay. */
export const TRAVEL_SLACK_MS = 2500;
/** Seconds of 3-2-1 countdown before the mission clock starts. */
export const COUNTDOWN_MS = 3000;
export const UPLINK_RADIUS = 14;

export const ROBOT_STATS: Record<RobotKind, { hp: number; speed: number; damage: number; range: number; fireEvery: number; label: string }> = {
  walker: { hp: 60, speed: 3.4, damage: 6, range: 38, fireEvery: 1.9, label: "Walker" },
  drone: { hp: 35, speed: 7, damage: 5, range: 34, fireEvery: 1.5, label: "Drone" },
  brute: { hp: 220, speed: 2.4, damage: 13, range: 30, fireEvery: 2.6, label: "Brute" },
  turret: { hp: 120, speed: 0, damage: 7, range: 46, fireEvery: 1.7, label: "Turret" },
  titan: { hp: 900, speed: 2.1, damage: 16, range: 44, fireEvery: 1.4, label: "Titan" },
  courier: { hp: 420, speed: 0, damage: 6, range: 36, fireEvery: 0.9, label: "Data Truck" },
};

export function releaseKeysFor(vaults: { id: string }[]): string[] {
  return ["start", ...vaults.flatMap((v) => [1, 2, 3].map((n) => `alarm:${v.id}:${n}`)), "uplink:1", "uplink:2"];
}
