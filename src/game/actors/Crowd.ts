import * as THREE from "three";
import { BLOCK, getCity, HALF, type CityBlock } from "@/lib/shared/city";
import { clamp, damp, mulberry, turnToward } from "../mathx";
import type { Bubbles } from "../fx/Bubbles";
import type { NoiseListener, World } from "../World";
import { CrowdMeshes, type PedPose } from "./Humanoid";
import type { Vehicles } from "./Vehicles";

/*
 * The people of Neon City. They stroll around the sidewalks, run when robots start
 * shooting, cower when a robot gets close, dive out of the way of the player's car
 * (nobody is ever hurt) and cheer when the city is saved. Only a few dozen exist;
 * people far from the camera are quietly moved to blocks nearby.
 */

type PedState = "walk" | "idle" | "flee" | "cower" | "cheer";

interface Ped extends PedPose {
  block: CityBlock;
  s: number;
  dir: 1 | -1;
  inset: number;
  base: number;
  state: PedState;
  t: number;
  vx: number;
  vz: number;
  fromX: number;
  fromZ: number;
  saidAt: number;
}

const LINES = {
  flee: ["Bhaago! Robot aaye!", "Arre baap re!", "Help! NULL ke robots!", "Mummyyy!", "Chhupo chhupo!"],
  dive: ["Arey dhyan se!", "Gaadi dheere chalao!", "Oye! Main bhi hoon yahan!", "Bhai sahab!"],
  eject: ["Meri gaadi!!", "Arre bhai, meri cab!", "Le jao, bas robot hatao!"],
  cheer: ["Wah operator!", "Shabash!", "City wapas aa gayi!", "Operator zindabad!"],
  kill: ["Ek aur maaro!", "Wah! Kya shot tha!", "Tod do NULL ko!"],
  idle: ["Operator, NULL ko roko!", "Mera WiFi bhi NULL le gaya...", "Vaults ka darwaza neon wala hai.", "Sab robots se darte hain..."],
};

export class Crowd implements NoiseListener {
  group = new THREE.Group();
  peds: Ped[] = [];
  private meshes: CrowdMeshes;
  private rand = mulberry(4242);
  private blocks: CityBlock[];
  private tmp = new THREE.Vector3();
  cheering = false;
  /** Robots the crowd should be scared of. Filled by the game each frame. */
  threats: THREE.Vector3[] = [];

  constructor(private world: World, count: number, private vehicles: Vehicles, private bubbles: Bubbles) {
    this.meshes = new CrowdMeshes(count, this.rand);
    this.group.add(this.meshes.group);
    this.blocks = getCity().blocks;
    for (let i = 0; i < count; i++) {
      const block = this.blocks[Math.floor(this.rand() * this.blocks.length)];
      const p: Ped = {
        x: 0, y: 0, z: 0, yaw: 0, phase: this.rand() * 10, speed: 0, dive: 0, diveSide: 1, cower: 0, cheer: 0, visible: true,
        block, s: this.rand() * 8, dir: this.rand() < 0.5 ? 1 : -1, inset: 0.9 + this.rand() * 2.6, base: 1.1 + this.rand() * 0.5,
        state: this.rand() < 0.15 ? "idle" : "walk", t: this.rand() * 6, vx: 0, vz: 0, fromX: 0, fromZ: 0, saidAt: -99,
      };
      this.loopPoint(p, p.s, this.tmp);
      p.x = this.tmp.x;
      p.z = this.tmp.z;
      this.peds.push(p);
    }
    world.listeners.push(this);
  }

  /** Point on a block's sidewalk ring, s in [0, 8) going clockwise round the four sides. */
  private loopPoint(p: Ped, s: number, out: THREE.Vector3): THREE.Vector3 {
    const h = BLOCK / 2 - p.inset;
    const u = ((s % 8) + 8) % 8;
    const side = Math.floor(u / 2), f = (u % 2) / 2 * 2 - 1;
    const b = p.block;
    if (side === 0) out.set(b.x + f * h, 0, b.z - h);
    else if (side === 1) out.set(b.x + h, 0, b.z + f * h);
    else if (side === 2) out.set(b.x - f * h, 0, b.z + h);
    else out.set(b.x - h, 0, b.z - f * h);
    return out;
  }

  /** Move far-away people to a block near the camera. */
  private relocate(p: Ped, cx: number, cz: number): void {
    const cand = this.blocks.filter((b) => { const d = Math.hypot(b.x - cx, b.z - cz); return d > 20 && d < 125; });
    if (!cand.length) return;
    p.block = cand[Math.floor(this.rand() * cand.length)];
    p.s = this.rand() * 8;
    this.loopPoint(p, p.s, this.tmp);
    p.x = this.tmp.x;
    p.z = this.tmp.z;
    p.state = "walk";
    p.cower = 0;
    p.dive = 0;
  }

  nearestBlock(x: number, z: number): CityBlock {
    let best = this.blocks[0], bd = Infinity;
    for (const b of this.blocks) { const d = Math.hypot(b.x - x, b.z - z); if (d < bd) { bd = d; best = b; } }
    return best;
  }

  /** An AI driver jumps out of a hijacked car and runs. */
  ejectDriver(x: number, z: number, awayX: number, awayZ: number): void {
    const L = this.world.listenerPos;
    let p = this.peds[0], bd = -1;
    for (const q of this.peds) { const d = Math.hypot(q.x - L.x, q.z - L.z); if (d > bd) { bd = d; p = q; } }
    p.block = this.nearestBlock(x, z);
    p.x = x; p.z = z;
    p.state = "flee";
    p.t = 6;
    p.fromX = x - awayX * 5;
    p.fromZ = z - awayZ * 5;
    p.vx = awayX * 4;
    p.vz = awayZ * 4;
    p.dive = 0;
    this.say(p, LINES.eject, "alarm", true);
  }

  private say(p: Ped, lines: string[], tone: "normal" | "alarm" | "cheer", force = false): void {
    const now = this.world.time;
    if (!force && (now - p.saidAt < 8 || Math.random() > 0.35)) return;
    const d = Math.hypot(p.x - this.world.listenerPos.x, p.z - this.world.listenerPos.z);
    if (d > 32) return;
    p.saidAt = now;
    this.bubbles.say(lines[Math.floor(Math.random() * lines.length)], () => (p.visible ? this.tmp.set(p.x, p.y, p.z) : null), now, 2.4, tone);
  }

  onNoise(x: number, z: number, radius: number, kind: "gunfire" | "explosion" | "alarm"): void {
    if (this.cheering) return;
    for (const p of this.peds) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d > radius * (kind === "gunfire" ? 0.8 : 1)) continue;
      if (p.state !== "flee") this.say(p, LINES.flee, "alarm");
      p.state = "flee";
      p.t = 5 + Math.random() * 4;
      p.fromX = x;
      p.fromZ = z;
    }
  }

  cheerKill(x: number, z: number): void {
    for (const p of this.peds) {
      if (Math.hypot(p.x - x, p.z - z) < 30 && Math.random() < 0.3) { this.say(p, LINES.kill, "cheer"); break; }
    }
  }

  startCheering(): void {
    this.cheering = true;
    for (const p of this.peds) { p.state = "cheer"; p.t = 0; }
    const near = this.peds.filter((p) => Math.hypot(p.x - this.world.listenerPos.x, p.z - this.world.listenerPos.z) < 30).slice(0, 3);
    near.forEach((p) => this.say(p, LINES.cheer, "cheer", true));
  }

  update(dt: number): void {
    const w = this.world;
    const L = w.listenerPos;
    const player = w.player;
    const pc = player?.car ?? null;
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      const dl = Math.hypot(p.x - L.x, p.z - L.z);
      if (dl > 150) { this.relocate(p, L.x, L.z); if (!w.attract) continue; }
      p.visible = dl < w.q.farClip * 0.55;
      p.t -= dt;

      // Danger from the player's speeding car: dive aside.
      if (pc && Math.abs(pc.speed) > 4 && p.dive <= 0) {
        const fx = Math.sin(pc.heading), fz = Math.cos(pc.heading);
        const rx = p.x - pc.pos.x, rz = p.z - pc.pos.z;
        const along = rx * fx + rz * fz;
        const lat = rx * fz - rz * fx;
        if (along > -1 && along < 2.8 + Math.abs(pc.speed) * 0.7 && Math.abs(lat) < 2.4) {
          p.dive = 0.001;
          p.diveSide = lat >= 0 ? 1 : -1;
          const push = 7.5;
          p.vx = fz * p.diveSide * push;
          p.vz = -fx * p.diveSide * push;
          p.yaw = pc.heading + Math.PI;
          this.say(p, LINES.dive, "alarm");
        }
      }

      // Robots close by: cower, then run.
      let threat: THREE.Vector3 | null = null;
      if (!this.cheering) for (const t of this.threats) if (Math.hypot(t.x - p.x, t.z - p.z) < 9) { threat = t; break; }

      let mvx = 0, mvz = 0, speed = 0;
      if (p.dive > 0) {
        p.dive = Math.min(1.6, p.dive + dt * 2.2);
        p.x += p.vx * dt;
        p.z += p.vz * dt;
        p.vx = damp(p.vx, 0, 5, dt);
        p.vz = damp(p.vz, 0, 5, dt);
        if (p.dive >= 1.6) { p.dive = 0; p.state = this.cheering ? "cheer" : "flee"; p.t = 3; p.fromX = p.x - p.vx; p.fromZ = p.z - p.vz; }
      } else if (p.state === "cheer") {
        p.cheer = Math.min(1, p.cheer + dt * 3);
        if (player) p.yaw = turnToward(p.yaw, Math.atan2(player.pos.x - p.x, player.pos.z - p.z), dt * 3);
        p.phase += dt * 4;
      } else if (threat && p.state !== "flee") {
        p.state = "cower";
        p.t = 1.5;
        p.fromX = threat.x;
        p.fromZ = threat.z;
      } else if (p.state === "cower") {
        p.cower = Math.min(1, p.cower + dt * 4);
        if (p.t <= 0) { p.state = "flee"; p.t = 5; this.say(p, LINES.flee, "alarm"); }
      } else {
        p.cower = Math.max(0, p.cower - dt * 3);
        if (p.state === "flee" && p.t <= 0) p.state = "walk";
        if (p.state === "idle" && p.t <= 0) { p.state = "walk"; p.t = 6 + this.rand() * 10; }
        if (p.state === "walk" && p.t <= 0 && this.rand() < 0.2) { p.state = "idle"; p.t = 2 + this.rand() * 4; }
        if (p.state === "flee") {
          // Run along the loop in whichever direction leads away from the danger.
          const ahead = this.loopPoint(p, p.s + 0.2, this.tmp);
          const awayAhead = Math.hypot(ahead.x - p.fromX, ahead.z - p.fromZ);
          if (awayAhead < Math.hypot(p.x - p.fromX, p.z - p.fromZ)) p.dir = -1;
          else p.dir = 1;
        }
        if (p.state !== "idle") {
          const pace = p.state === "flee" ? 4.6 : p.base;
          p.s += (p.dir * pace * dt) / (BLOCK - 2 * p.inset) * 2;
          const tgt = this.loopPoint(p, p.s + p.dir * 0.05, this.tmp);
          const dx = tgt.x - p.x, dz = tgt.z - p.z, d = Math.hypot(dx, dz);
          if (d > 0.05) { mvx = dx / d; mvz = dz / d; speed = Math.min(pace * 1.3, d * 4); }
        } else if (player && Math.hypot(player.pos.x - p.x, player.pos.z - p.z) < 6 && !player.car) {
          p.yaw = turnToward(p.yaw, Math.atan2(player.pos.x - p.x, player.pos.z - p.z), dt * 3);
          this.say(p, LINES.idle, "normal");
        }
        // Leftover push from a dive or an ejection.
        p.x += p.vx * dt;
        p.z += p.vz * dt;
        p.vx = damp(p.vx, 0, 3, dt);
        p.vz = damp(p.vz, 0, 3, dt);
      }
      p.x += mvx * speed * dt;
      p.z += mvz * speed * dt;
      if (speed > 0.1 && p.dive <= 0) p.yaw = turnToward(p.yaw, Math.atan2(mvx, mvz), dt * 8);
      p.speed = damp(p.speed, speed, 8, dt);
      if (p.state !== "cheer") p.phase += dt * (2.2 + p.speed * 2.3);

      // Never inside buildings or cars, never off the map.
      if (p.visible) {
        const res = w.colliders.resolveCircle(p.x, p.z, 0.3, 0, 1.7);
        p.x = res.x;
        p.z = res.z;
        this.tmp.set(p.x, 0, p.z);
        if (this.vehicles.pushOut(this.tmp, 0.35)) { p.x = this.tmp.x; p.z = this.tmp.z; }
      }
      p.x = clamp(p.x, -HALF + 3, HALF - 3);
      p.z = clamp(p.z, -HALF + 3, HALF - 3);
      this.meshes.setPose(i, p);
    }
    this.meshes.commit();
  }
}
