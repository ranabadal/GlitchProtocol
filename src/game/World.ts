import type * as THREE from "three";
import type { Sound } from "./audio/Sound";
import type { Colliders } from "./Colliders";
import type { Effects } from "./fx/Effects";
import type { QualitySettings } from "./Quality";

/*
 * The shared context every game system receives. Systems talk to each other through
 * this object instead of importing each other, which keeps update order explicit in
 * Game.ts and lets the welcome-screen flyover run the same city without a player.
 */

export interface PlayerLike {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  alive: boolean;
  /** The car the player is driving, if any. */
  car: CarLike | null;
  /** Point robots aim at (chest on foot, cabin in a car). */
  aimPoint(out: THREE.Vector3): THREE.Vector3;
  takeDamage(amount: number, from: THREE.Vector3): void;
  /** True while invisible to robots (hacking cut-scene, respawn shield). */
  shielded: boolean;
}

export interface CarLike {
  id: number;
  pos: THREE.Vector3;
  heading: number;
  speed: number;
  health: number;
  takeDamage(amount: number, from: THREE.Vector3): void;
}

export interface RobotTarget {
  id: string;
  pos: THREE.Vector3;
  kind: string;
  alive: boolean;
}

export interface NoiseListener {
  onNoise(x: number, z: number, radius: number, kind: "gunfire" | "explosion" | "alarm"): void;
}

export interface World {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  colliders: Colliders;
  fx: Effects;
  sound: Sound;
  q: QualitySettings;
  uTime: { value: number };
  /** 0 = night, 0.5 = sunset, 1 = day (shared with the city shaders). */
  uDay?: { value: number };
  /** Game time in seconds (stops while paused, slows during hacks). */
  time: number;
  attract: boolean;
  player: PlayerLike | null;
  listeners: NoiseListener[];
  noise(x: number, z: number, radius: number, kind: "gunfire" | "explosion" | "alarm"): void;
  shake(amount: number): void;
  /** Distance from the camera, for sound volume and update LOD. */
  listenerPos: THREE.Vector3;
}

export function panFor(world: World, x: number, z: number): { pan: number; vol: number } {
  const cam = world.camera;
  const dx = x - cam.position.x, dz = z - cam.position.z;
  const d = Math.hypot(dx, dz);
  // Camera right vector (first matrix column) in the ground plane.
  const rx = cam.matrixWorld.elements[0], rz = cam.matrixWorld.elements[2];
  const len = Math.hypot(rx, rz) || 1;
  const pan = d > 0.01 ? (dx * rx + dz * rz) / (d * len) : 0;
  return { pan: Math.max(-1, Math.min(1, pan)), vol: Math.max(0, 1 - d / 90) };
}
