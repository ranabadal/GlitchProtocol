import type { Side } from "./city";

/*
 * The public half of a mission: everything the browser needs to build and run it.
 * Hack puzzles and their answers are NOT in here; the server hands out each hack
 * puzzle only when the player starts that hack, and keeps the answers to itself.
 */

export type HackType = "glitch" | "power" | "imposter";
export type RobotKind = "walker" | "drone" | "brute" | "turret";

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
}

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
};

export function releaseKeysFor(vaults: { id: string }[]): string[] {
  return ["start", ...vaults.flatMap((v) => [1, 2, 3].map((n) => `alarm:${v.id}:${n}`)), "uplink:1", "uplink:2"];
}
