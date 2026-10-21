import * as THREE from "three";
import { ROBOT_STATS, type Pt, type RobotKind, type Spawn } from "@/lib/shared/mission";
import { clamp, headingTo, rayCapsule, raySphere, segSegDist, turnToward, wrapAngle } from "../mathx";
import { panFor, type NoiseListener, type RobotTarget, type World } from "../World";
import { createRobotVisual, DroneVisual, TurretVisual, type RobotTemplate, type RobotVisual } from "./RobotModel";

/*
 * NULL's robot army. Walkers and brutes march and shoot, drones circle overhead,
 * turrets hold street corners. Robots only ever target the player (never the crowd),
 * fire slow glowing bolts that can be dodged, and can be shot, EMP-stunned or run
 * over. The Director decides WHEN robots exist (server release keys); this file
 * decides how they behave.
 */

const HEIGHT: Record<RobotKind, number> = { walker: 2.3, brute: 3.5, drone: 1, turret: 3, titan: 6.2, courier: 2.8 };
const RADIUS: Record<RobotKind, number> = { walker: 0.6, brute: 1.0, drone: 0.95, turret: 1.3, titan: 1.8, courier: 2.4 };
const BOLT_SPEED: Record<RobotKind, number> = { walker: 30, brute: 26, drone: 32, turret: 36, titan: 28, courier: 34 };
/** How the player hurt a robot (decides effects, quips and whether the crowd cheers). */
export type HitBy = "gun" | "scatter" | "blade" | "bomb" | "slap" | "car" | "emp";
const AI_RANGE = 170;
const SPAWN_TIME = 1.3;

export type RobotState = "spawning" | "active" | "stunned" | "dying" | "dead";

export class Robot implements RobotTarget {
  stats: (typeof ROBOT_STATS)[RobotKind];
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  hp: number;
  state: RobotState = "spawning";
  alert = false;
  t = 0;
  fireCd = 1 + Math.random() * 1.5;
  burst = 0;
  seeT = Math.random() * 0.3;
  canSee = false;
  lastSeen = new THREE.Vector3();
  stunUntil = 0;
  strafe = Math.random() < 0.5 ? -1 : 1;
  stuckT = 0;
  sideStepT = 0;
  checkPos = new THREE.Vector3();
  patrolIdx = 1;
  hover: number;
  flash = 0;
  launched = false;
  spin = new THREE.Vector3();
  reported = false;
  idleTurnT = Math.random() * 4;
  maxHp: number;
  /** Titan: next ground-stomp shockwave allowed at this game time. */
  stompAt = 0;
  roared = false;

  constructor(public id: string, public kind: RobotKind, public visual: RobotVisual, public home: THREE.Vector3, public patrol: Pt[] | null, public group: string) {
    this.stats = ROBOT_STATS[kind];
    this.hp = this.stats.hp;
    this.maxHp = this.hp;
    this.pos.copy(home);
    this.hover = kind === "drone" ? Math.max(6, home.y || 9) : 0;
    if (kind === "drone") this.pos.y = this.hover;
    this.checkPos.copy(this.pos);
  }

  get alive(): boolean {
    return this.state === "spawning" || this.state === "active" || this.state === "stunned";
  }

  /** Centre of mass, for aiming, markers and explosions. */
  centre(out: THREE.Vector3): THREE.Vector3 {
    if (this.kind === "drone") return out.copy(this.pos);
    return out.set(this.pos.x, this.pos.y + HEIGHT[this.kind] * (this.kind === "turret" ? 0.8 : 0.55), this.pos.z);
  }
}

// ---------------------------------------------------------------- bolts

interface Bolt { pos: THREE.Vector3; prev: THREE.Vector3; vel: THREE.Vector3; life: number; dmg: number; on: boolean; color: THREE.Color; size: number }
const MAX_BOLTS = 96;

class Bolts {
  mesh: THREE.InstancedMesh;
  list: Bolt[] = [];
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private fwd = new THREE.Vector3(0, 0, 1);
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();

  constructor() {
    const g = new THREE.SphereGeometry(0.5, 8, 6);
    this.mesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), MAX_BOLTS);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < MAX_BOLTS; i++) {
      this.list.push({ pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, dmg: 0, on: false, color: new THREE.Color(), size: 1 });
      this.mesh.setMatrixAt(i, this.m4.makeScale(0, 0, 0));
      this.mesh.setColorAt(i, new THREE.Color(0, 0, 0));
    }
  }

  fire(from: THREE.Vector3, vel: THREE.Vector3, dmg: number, color: THREE.Color, size: number): void {
    const b = this.list.find((x) => !x.on) ?? this.list[0];
    b.pos.copy(from);
    b.prev.copy(from);
    b.vel.copy(vel);
    b.life = 2.2;
    b.dmg = dmg;
    b.on = true;
    b.color.copy(color);
    b.size = size;
  }

  clear(): void {
    for (const b of this.list) b.on = false;
  }

  update(dt: number, world: World): void {
    const p = world.player;
    for (let i = 0; i < this.list.length; i++) {
      const b = this.list[i];
      if (!b.on) { this.mesh.setMatrixAt(i, this.m4.makeScale(0, 0, 0)); continue; }
      b.life -= dt;
      b.prev.copy(b.pos);
      b.pos.addScaledVector(b.vel, dt);
      let dead = b.life <= 0;
      // Player hit (capsule on foot, bigger capsule around a car).
      if (!dead && p && p.alive && !p.shielded) {
        const car = p.car;
        let hit = false;
        if (car) {
          this.a.set(car.pos.x - Math.sin(car.heading) * 1.6, 0.9, car.pos.z - Math.cos(car.heading) * 1.6);
          this.b.set(car.pos.x + Math.sin(car.heading) * 1.6, 0.9, car.pos.z + Math.cos(car.heading) * 1.6);
          hit = segSegDist(b.prev, b.pos, this.a, this.b) < 1.15;
        } else {
          this.a.set(p.pos.x, p.pos.y + 0.35, p.pos.z);
          this.b.set(p.pos.x, p.pos.y + 1.55, p.pos.z);
          hit = segSegDist(b.prev, b.pos, this.a, this.b) < 0.5;
        }
        if (hit) {
          if (car) car.takeDamage(b.dmg * 0.8, b.prev);
          else p.takeDamage(b.dmg, b.prev);
          world.fx.sparks(b.pos, null, b.color, 8, 6);
          dead = true;
        }
      }
      if (!dead) {
        const len = b.vel.length() * dt;
        this.dir.copy(b.vel).normalize();
        const h = world.colliders.raycast(b.prev.x, b.prev.y, b.prev.z, this.dir.x, this.dir.y, this.dir.z, len);
        if (h) {
          world.fx.sparks(new THREE.Vector3(h.x, h.y, h.z), new THREE.Vector3(h.nx, h.ny, h.nz), b.color, 6, 5);
          dead = true;
        }
      }
      if (dead) { b.on = false; this.mesh.setMatrixAt(i, this.m4.makeScale(0, 0, 0)); continue; }
      this.dir.copy(b.vel).normalize();
      this.q.setFromUnitVectors(this.fwd, this.dir);
      this.s.set(0.32 * b.size, 0.32 * b.size, 2.2 * b.size);
      this.m4.compose(b.pos, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m4);
      this.mesh.setColorAt(i, b.color);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- manager

const RED = new THREE.Color(3, 0.25, 0.4);
const ORANGE = new THREE.Color(3, 1.1, 0.15);
const MAGENTA = new THREE.Color(3, 0.3, 2.6);

export class Robots implements NoiseListener {
  group = new THREE.Group();
  list: Robot[] = [];
  byId = new Map<string, Robot>();
  /** Called once per robot destroyed by the player. */
  onKilled: ((r: Robot, by: HitBy) => void) | null = null;
  /** Robots stop shooting (attract mode, mission over). */
  passive = false;
  private bolts = new Bolts();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private aim = new THREE.Vector3();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();

  constructor(private world: World, private template: RobotTemplate | null) {
    this.group.add(this.bolts.mesh);
    world.listeners.push(this);
  }

  spawn(s: Spawn, opts: { materialize?: boolean; alert?: boolean; group?: string; hp?: number } = {}): Robot | null {
    if (this.byId.has(s.id)) return this.byId.get(s.id)!;
    const uTime = this.world.uTime;
    const visual: RobotVisual = s.kind === "drone" ? new DroneVisual(uTime) : s.kind === "turret" ? new TurretVisual(uTime) : createRobotVisual(this.template, s.kind === "titan" ? "titan" : s.kind === "brute" ? "brute" : "walker", uTime);
    const r = new Robot(s.id, s.kind, visual, new THREE.Vector3(s.x, s.y ?? 0, s.z), s.patrol ?? null, opts.group ?? "");
    if (opts.hp) { r.hp = opts.hp; r.maxHp = opts.hp; }
    r.yaw = Math.random() * Math.PI * 2;
    r.alert = !!opts.alert;
    if (opts.alert && this.world.player) r.lastSeen.copy(this.world.player.pos);
    if (opts.materialize) {
      r.state = "spawning";
      r.visual.fx.uDissolve.value = 1;
      this.world.fx.materialize(r.pos.clone().setY(0));
    } else {
      r.state = "active";
      r.visual.fx.uDissolve.value = 0;
    }
    this.list.push(r);
    this.byId.set(r.id, r);
    this.group.add(r.visual.object);
    this.place(r);
    return r;
  }

  private place(r: Robot): void {
    const o = r.visual.object;
    o.position.copy(r.pos);
    if (r.kind === "turret") {
      (r.visual as TurretVisual).head.rotation.y = r.yaw;
    } else {
      o.rotation.y = r.yaw;
    }
  }

  remove(r: Robot): void {
    r.state = "dead";
    this.group.remove(r.visual.object);
    r.visual.dispose();
    this.byId.delete(r.id);
    const i = this.list.indexOf(r);
    if (i >= 0) this.list.splice(i, 1);
  }

  clearAll(): void {
    for (const r of [...this.list]) this.remove(r);
    this.bolts.clear();
  }

  aliveList(): Robot[] {
    return this.list.filter((r) => r.alive);
  }

  onNoise(x: number, z: number, radius: number): void {
    for (const r of this.list) {
      if (!r.alive || r.alert) continue;
      if (Math.hypot(r.pos.x - x, r.pos.z - z) < radius) {
        r.alert = true;
        r.lastSeen.set(x, 0, z);
      }
    }
  }

  // ------------------------------------------------------------ damage

  damage(r: Robot, amount: number, at: THREE.Vector3 | null, by: HitBy): boolean {
    if (!r.alive) return false;
    // The Titan's armour shrugs off part of every hit except bombs.
    if (r.kind === "titan" && by !== "bomb") amount *= by === "emp" ? 0.5 : 0.8;
    r.hp -= amount;
    r.flash = 1;
    r.alert = true;
    if (this.world.player) r.lastSeen.copy(this.world.player.pos);
    if (at) this.world.fx.sparks(at, null, new THREE.Color(1, 0.6, 0.3), 6, 7);
    if (!this.passive && by !== "emp" && amount >= 1) {
      const c = r.centre(this.tmp2).clone();
      c.y += HEIGHT[r.kind] * 0.45 + 0.3;
      this.world.fx.number(c, Math.round(Math.min(amount, r.hp + amount)), r.hp <= 0 ? "#ffd84a" : by === "slap" ? "#ff8ad8" : "#ffffff");
    }
    if (r.hp <= 0) {
      this.kill(r, by);
      return true;
    }
    return false;
  }

  private kill(r: Robot, by: HitBy): void {
    r.state = "dying";
    r.t = 0;
    r.hp = 0;
    if (r.kind === "walker" || r.kind === "brute" || r.kind === "titan") r.visual.play("die", r.kind === "titan" ? 0.9 : 1.6);
    if (r.kind === "turret") {
      const c = r.centre(this.tmp).clone();
      this.world.fx.explosion(c, 1.1);
      const sp = panFor(this.world, c.x, c.z);
      this.world.sound.explosion(sp.vol, sp.pan);
      this.world.shake(0.35 * sp.vol);
      this.world.noise(c.x, c.z, 40, "explosion");
    }
    if (!r.reported) {
      r.reported = true;
      this.onKilled?.(r, by);
    }
  }

  /** Stun every robot in range; drones short-circuit and fall. */
  emp(center: THREE.Vector3, radius: number): number {
    let n = 0;
    for (const r of this.list) {
      if (!r.alive) continue;
      const d = r.centre(this.tmp).distanceTo(center);
      if (d > radius) continue;
      n++;
      if (r.kind === "drone") this.damage(r, 999, null, "emp");
      else {
        this.damage(r, r.kind === "brute" ? 40 : r.kind === "titan" ? 80 : 30, null, "emp");
        if (r.alive) { r.state = "stunned"; r.stunUntil = this.world.time + (r.kind === "titan" ? 1.5 : 4); r.visual.play("idle", 0.2); }
      }
    }
    return n;
  }

  /** Plasma bomb: damage falls off with distance; everything caught is knocked back. Returns kills. */
  blast(center: THREE.Vector3, radius: number, maxDamage: number): number {
    let kills = 0;
    for (const r of [...this.list]) {
      if (!r.alive) continue;
      const c = r.centre(this.tmp);
      const d = c.distanceTo(center);
      if (d > radius + RADIUS[r.kind]) continue;
      const k = Math.max(0.25, 1 - d / (radius + RADIUS[r.kind]));
      const dir = this.tmp2.copy(c).sub(center).setY(0);
      if (dir.lengthSq() < 1e-4) dir.set(1, 0, 0);
      dir.normalize();
      if (r.kind === "walker" || r.kind === "drone") { r.vel.set(dir.x * 9 * k, 6 * k, dir.z * 9 * k); }
      if (this.damage(r, maxDamage * k, null, "bomb")) kills++;
      if (r.alive && r.kind === "walker" && k > 0.5) { r.launched = true; r.spin.set(Math.random() * 6 - 3, 0, Math.random() * 6 - 3); }
    }
    return kills;
  }

  /** Slap: a little damage, a big shove, and a moment of seeing stars. */
  slap(r: Robot, dirX: number, dirZ: number, damage: number): boolean {
    if (!r.alive) return false;
    const heavy = r.kind === "brute" || r.kind === "titan" || r.kind === "turret";
    const killed = this.damage(r, damage, null, "slap");
    if (!killed && r.kind !== "turret") {
      r.vel.set(dirX * (heavy ? 2 : 11), heavy ? 0.5 : 5.5, dirZ * (heavy ? 2 : 11));
      if (!heavy && r.kind !== "drone") { r.launched = true; r.spin.set(0, 14 * (Math.random() < 0.5 ? -1 : 1), 3); }
      if (r.kind !== "titan") { r.state = "stunned"; r.stunUntil = this.world.time + (heavy ? 0.8 : 1.6); r.visual.play("idle", 0.2); }
    } else if (killed && r.kind === "walker") {
      r.vel.set(dirX * 12, 6, dirZ * 12);
      r.launched = true;
      r.spin.set(Math.random() * 8 - 4, 14, Math.random() * 8 - 4);
    }
    return killed;
  }

  /** Lets other enemies (the data truck's roof gun) fire the same dodgeable bolts. */
  fireBolt(from: THREE.Vector3, vel: THREE.Vector3, dmg: number, color: THREE.Color, size = 1): void {
    this.bolts.fire(from, vel, dmg, color, size);
  }

  /** Ray against every live robot. */
  hitScan(o: THREE.Vector3, d: THREE.Vector3, maxT: number): { robot: Robot; t: number } | null {
    let best: { robot: Robot; t: number } | null = null;
    for (const r of this.list) {
      if (!r.alive) continue;
      let t: number | null;
      if (r.kind === "drone") t = raySphere(o, d, r.pos.x, r.pos.y, r.pos.z, RADIUS.drone, maxT);
      else {
        const h = HEIGHT[r.kind];
        this.a.set(r.pos.x, r.pos.y + RADIUS[r.kind] * 0.8, r.pos.z);
        this.b.set(r.pos.x, r.pos.y + h - RADIUS[r.kind] * 0.6, r.pos.z);
        t = rayCapsule(o, d, this.a, this.b, RADIUS[r.kind], maxT);
      }
      if (t !== null && (!best || t < best.t)) best = { robot: r, t };
    }
    return best;
  }

  /** Aim assist: the live robot closest to the aim ray within a small cone. */
  assist(o: THREE.Vector3, d: THREE.Vector3, maxT: number, cone: number): Robot | null {
    let best: Robot | null = null;
    let bestA = cone;
    for (const r of this.list) {
      if (!r.alive || r.state === "spawning") continue;
      const c = r.centre(this.tmp).sub(o);
      const dist = c.length();
      if (dist > maxT || dist < 1) continue;
      const ang = Math.acos(clamp(c.dot(d) / dist, -1, 1));
      const allowed = cone + Math.atan2(RADIUS[r.kind], dist);
      if (ang < allowed && ang - Math.atan2(RADIUS[r.kind], dist) < bestA) { bestA = ang; best = r; }
    }
    return best;
  }

  /** Car hits: called by the vehicle system for the player's car. Returns damage to the car. */
  carImpact(pos: THREE.Vector3, heading: number, vel: THREE.Vector3): { hit: boolean; carDamage: number; slow: number } {
    const speed = vel.length();
    let carDamage = 0, slow = 0, hit = false;
    const fx = Math.sin(heading), fz = Math.cos(heading);
    for (const r of this.list) {
      if (!r.alive || r.kind === "drone" || r.kind === "turret") continue;
      if (r.launched) continue;
      if (r.kind === "titan") {
        // Like hitting a wall: the car bounces off and takes the damage.
        let near = false;
        for (const k of [-1.3, 0, 1.3]) if (Math.hypot(r.pos.x - (pos.x + fx * k), r.pos.z - (pos.z + fz * k)) < 1.2 + RADIUS.titan) near = true;
        if (!near) continue;
        hit = true;
        if (speed > 5) { this.damage(r, speed * 2.5, null, "car"); carDamage += 22; slow += 0.9; this.world.sound.crash(1); this.world.shake(0.4); }
        continue;
      }
      // Car as two circles along its length.
      let touching = false;
      for (const k of [-1.3, 0, 1.3]) {
        const cx = pos.x + fx * k, cz = pos.z + fz * k;
        if (Math.hypot(r.pos.x - cx, r.pos.z - cz) < 1.2 + RADIUS[r.kind]) { touching = true; break; }
      }
      if (!touching) continue;
      hit = true;
      if (speed > 5) {
        const dmg = speed * (r.kind === "brute" ? 4 : 8);
        r.vel.copy(vel).multiplyScalar(r.kind === "brute" ? 0.3 : 0.8).setY(r.kind === "brute" ? 2 : 7);
        const killed = this.damage(r, dmg, null, "car");
        if (killed || r.kind === "walker") {
          r.launched = true;
          r.spin.set(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4);
        }
        carDamage += r.kind === "brute" ? 14 : 5;
        slow += r.kind === "brute" ? 0.6 : 0.15;
        const sp = panFor(this.world, r.pos.x, r.pos.z);
        this.world.sound.crash(0.6 * sp.vol + 0.3);
      } else {
        // Slow push: shove the robot aside.
        const dx = r.pos.x - pos.x, dz = r.pos.z - pos.z, d = Math.hypot(dx, dz) || 1;
        r.pos.x += (dx / d) * 0.2;
        r.pos.z += (dz / d) * 0.2;
      }
    }
    return { hit, carDamage, slow: Math.min(0.9, slow) };
  }

  // ------------------------------------------------------------ update

  update(dt: number): void {
    const w = this.world;
    const p = w.player;
    const target = p && p.alive ? p.aimPoint(this.aim) : null;
    const targetable = !!target && !p!.shielded && !this.passive;

    for (const r of [...this.list]) {
      r.flash = Math.max(0, r.flash - dt * 6);
      r.visual.fx.uFlash.value = r.flash;
      const distToListener = Math.hypot(r.pos.x - w.listenerPos.x, r.pos.z - w.listenerPos.z);
      const near = distToListener < AI_RANGE;

      switch (r.state) {
        case "spawning": {
          r.t += dt;
          r.visual.fx.uDissolve.value = Math.max(0, 1 - r.t / SPAWN_TIME);
          if (r.t >= SPAWN_TIME) { r.state = "active"; r.t = 0; }
          break;
        }
        case "stunned": {
          if (Math.random() < dt * 6) w.fx.sparks(r.centre(this.tmp), null, new THREE.Color(0.4, 0.8, 1), 3, 4);
          if (w.time >= r.stunUntil) { r.state = "active"; r.visual.play("idle"); }
          break;
        }
        case "dying": {
          this.updateDying(r, dt);
          break;
        }
        case "active": {
          if (near) this.think(r, dt, targetable ? target : null);
          break;
        }
      }
      if (r.launched && r.state !== "dead") this.updateLaunched(r, dt);
      if (r.state === "dead") continue;
      if (near || r.state === "dying") r.visual.update(dt);
      this.place(r);
    }
    this.separate();
    this.bolts.update(dt, w);
  }

  private updateLaunched(r: Robot, dt: number): void {
    r.vel.y -= 22 * dt;
    r.pos.addScaledVector(r.vel, dt);
    const o = r.visual.object;
    o.rotation.x += r.spin.x * dt;
    o.rotation.z += r.spin.z * dt;
    const res = this.world.colliders.resolveCircle(r.pos.x, r.pos.z, RADIUS[r.kind], r.pos.y, 1.5);
    if (res.hit) { r.pos.x = res.x; r.pos.z = res.z; r.vel.x *= -0.3; r.vel.z *= -0.3; }
    if (r.pos.y <= 0 && r.vel.y < 0) {
      r.pos.y = 0;
      if (r.state === "dying") {
        r.launched = false;
        r.t = Math.max(r.t, 0.88);
      } else {
        r.vel.set(0, 0, 0);
        r.launched = false;
        o.rotation.x = 0;
        o.rotation.z = 0;
      }
    }
  }

  private updateDying(r: Robot, dt: number): void {
    const w = this.world;
    r.t += dt;
    if (r.kind === "drone") {
      r.vel.y -= 18 * dt;
      r.pos.addScaledVector(r.vel, dt);
      r.visual.object.rotation.z += dt * 6;
      r.visual.object.rotation.x += dt * 3;
      if (Math.random() < dt * 30) w.fx.smokePuff(r.pos.clone(), 0.05);
      if (r.pos.y <= 0.4) {
        const c = r.pos.clone().setY(0.6);
        w.fx.explosion(c, 0.9);
        const sp = panFor(w, c.x, c.z);
        w.sound.explosion(0.8 * sp.vol, sp.pan);
        w.shake(0.25 * sp.vol);
        w.noise(c.x, c.z, 35, "explosion");
        this.remove(r);
      }
      return;
    }
    if (r.kind === "turret") {
      r.visual.fx.uDissolve.value = Math.min(1, r.t / 1.2);
      if (Math.random() < dt * 20) w.fx.smokePuff(r.centre(this.tmp).clone(), 0.04);
      if (r.t > 1.3) this.remove(r);
      return;
    }
    // Titan: a chain of explosions while it topples.
    if (r.kind === "titan") {
      if (Math.random() < dt * 9 && r.t < 2.2) {
        const c = r.centre(this.tmp).clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.3) * 3, (Math.random() - 0.5) * 3));
        w.fx.explosion(c, 0.9);
        const sp = panFor(w, c.x, c.z);
        w.sound.explosion(0.7 * sp.vol, sp.pan);
      }
      if (r.t >= 2.2 && r.t - dt < 2.2) {
        const c = r.centre(this.tmp).clone();
        w.fx.explosion(c, 2.6, new THREE.Color(1, 0.25, 0.9));
        const sp = panFor(w, c.x, c.z);
        w.sound.bigBoom(Math.max(0.5, sp.vol), sp.pan);
        w.shake(0.9 * Math.max(0.4, sp.vol));
        w.noise(c.x, c.z, 60, "explosion");
      }
      if (r.t > 2.2) r.visual.fx.uDissolve.value = Math.min(1, (r.t - 2.2) / 1.4);
      if (r.t > 3.7) this.remove(r);
      return;
    }
    // Walker / brute: fall, then blow up and dissolve into code.
    if (r.t >= 0.9 && r.t - dt < 0.9) {
      const c = r.centre(this.tmp).clone();
      w.fx.explosion(c, r.kind === "brute" ? 1.4 : 0.85);
      const sp = panFor(w, c.x, c.z);
      w.sound.explosion((r.kind === "brute" ? 1 : 0.7) * sp.vol, sp.pan);
      w.shake((r.kind === "brute" ? 0.5 : 0.25) * sp.vol);
      w.noise(c.x, c.z, 35, "explosion");
    }
    if (r.t > 0.9) r.visual.fx.uDissolve.value = Math.min(1, (r.t - 0.9) / 1.1);
    if (r.t > 2.1) this.remove(r);
  }

  private think(r: Robot, dt: number, target: THREE.Vector3 | null): void {
    const w = this.world;
    if (r.kind === "drone") this.droneAi(r, dt, target);
    else if (r.kind === "turret") this.turretAi(r, dt, target);
    else this.walkerAi(r, dt, target);
    if (!target) return;
    // Firing.
    r.fireCd -= dt;
    if (!r.canSee || r.fireCd > 0) return;
    const dist = r.centre(this.tmp).distanceTo(target);
    if (dist > r.stats.range) return;
    const facing = Math.abs(wrapAngle(headingTo(r.pos.x, r.pos.z, target.x, target.z) - r.yaw));
    if (r.kind !== "drone" && facing > 0.45) return;
    const from = r.visual.muzzle(this.tmp2);
    if (r.kind === "walker" || r.kind === "brute") {
      // Hand position is low; lift a little so bolts clear the robot's own body.
      from.y = Math.max(from.y, r.pos.y + HEIGHT[r.kind] * 0.55);
      from.x += Math.sin(r.yaw) * 0.6;
      from.z += Math.cos(r.yaw) * 0.6;
    }
    const speed = BOLT_SPEED[r.kind];
    const p = w.player!;
    // Lead the target a little and add spread so bolts can be dodged.
    const lead = dist / speed;
    const aimAt = this.tmp.copy(target).addScaledVector(p.car ? new THREE.Vector3(Math.sin(p.car.heading) * p.car.speed, 0, Math.cos(p.car.heading) * p.car.speed) : p.vel, lead * 0.5);
    const spread = 0.035 + (r.kind === "drone" ? 0.03 : 0) + (p.car ? 0.02 : 0);
    const dir = aimAt.sub(from).normalize();
    dir.x += (Math.random() - 0.5) * spread * 2;
    dir.y += (Math.random() - 0.5) * spread;
    dir.z += (Math.random() - 0.5) * spread * 2;
    dir.normalize();
    const color = r.kind === "brute" ? ORANGE : r.kind === "titan" ? MAGENTA : RED;
    this.bolts.fire(from, dir.multiplyScalar(speed), r.stats.damage, color, r.kind === "brute" ? 1.6 : r.kind === "titan" ? 2.2 : 1);
    if (r.kind === "titan" && r.burst < 3) { r.burst++; r.fireCd = 0.16; }
    else if (r.kind === "brute" && r.burst < 2) { r.burst++; r.fireCd = 0.18; }
    else { r.burst = 0; r.fireCd = r.stats.fireEvery * (0.8 + Math.random() * 0.5); }
    r.visual.play("fire", 1.6);
    w.fx.muzzle(from, color);
    const sp = panFor(w, from.x, from.z);
    w.sound.enemyShot(sp.pan, Math.max(0.15, sp.vol));
  }

  private lookCheck(r: Robot, dt: number, target: THREE.Vector3 | null, eyeY: number): void {
    r.seeT -= dt;
    if (r.seeT > 0) return;
    r.seeT = 0.22 + Math.random() * 0.12;
    if (!target) { r.canSee = false; return; }
    const d = Math.hypot(target.x - r.pos.x, target.z - r.pos.z);
    const detect = r.alert ? r.stats.range * 1.4 : r.stats.range * 0.75;
    r.canSee = d < detect && this.world.colliders.lineOfSight(r.pos.x, eyeY, r.pos.z, target.x, target.y, target.z);
    if (r.canSee) { r.alert = true; r.lastSeen.copy(target); }
  }

  /** Titan extras: a roar when it spots you, a ground-stomp shockwave up close, and it guards its vault. */
  private titanExtras(r: Robot, target: THREE.Vector3 | null): void {
    const w = this.world;
    if (!target || !w.player) return;
    const d = Math.hypot(target.x - r.pos.x, target.z - r.pos.z);
    if (r.alert && !r.roared) {
      r.roared = true;
      w.sound.titanRoar();
      w.shake(0.35);
    }
    if (d < 10 && w.time >= r.stompAt) {
      r.stompAt = w.time + 4.5;
      const c = r.pos.clone().setY(0.3);
      w.fx.ring(c, 11, new THREE.Color(1, 0.2, 0.9), 0.6);
      w.fx.ring(c, 7, new THREE.Color(1, 0.6, 1), 0.45);
      for (let i = 0; i < 6; i++) w.fx.smokePuff(c.clone().add(new THREE.Vector3((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6)), 0.18);
      const sp = panFor(w, c.x, c.z);
      w.sound.stomp(Math.max(0.5, sp.vol), sp.pan);
      w.shake(0.55);
      const p = w.player;
      if (p.alive && !p.car && p.pos.y < 0.8 && d < 10) p.takeDamage(18 * (1 - d / 12), c);
    }
  }

  private walkerAi(r: Robot, dt: number, target: THREE.Vector3 | null): void {
    const w = this.world;
    const h = HEIGHT[r.kind];
    this.lookCheck(r, dt, target, r.pos.y + h * 0.85);
    if (r.launched) return;
    if (r.kind === "titan") {
      this.titanExtras(r, target);
      // Guard the vault: never wander more than 30 m from it.
      if (Math.hypot(r.pos.x - r.home.x, r.pos.z - r.home.z) > 30) r.lastSeen.copy(r.home);
    }
    let mx = 0, mz = 0, speed = 0;
    if (r.alert && target) {
      const dist = Math.hypot(target.x - r.pos.x, target.z - r.pos.z);
      const goal = r.canSee ? target : r.lastSeen;
      const gx = goal.x - r.pos.x, gz = goal.z - r.pos.z, gd = Math.hypot(gx, gz) || 1;
      if (!r.canSee || dist > r.stats.range * 0.7) {
        mx = gx / gd; mz = gz / gd; speed = r.stats.speed * (r.canSee ? 1 : 1.25);
      } else if (dist < r.stats.range * 0.3) {
        mx = -gx / gd; mz = -gz / gd; speed = r.stats.speed * 0.6;
      } else {
        // Hold position and strafe sideways a little.
        mx = (-gz / gd) * r.strafe; mz = (gx / gd) * r.strafe; speed = r.stats.speed * 0.35;
        if (Math.random() < dt * 0.4) r.strafe *= -1;
      }
      if (r.canSee) r.yaw = turnToward(r.yaw, headingTo(r.pos.x, r.pos.z, target.x, target.z), dt * 5);
      else if (speed > 0) r.yaw = turnToward(r.yaw, Math.atan2(mx, mz), dt * 6);
      if (!r.canSee && gd < 2) { r.lastSeen.copy(target); }
    } else if (r.patrol && r.patrol.length > 1) {
      // Street patrol (welcome-screen flyover and patrol squads).
      const pt = r.patrol[r.patrolIdx % r.patrol.length];
      const dx = pt.x - r.pos.x, dz = pt.z - r.pos.z, d = Math.hypot(dx, dz);
      if (d < 1.5) r.patrolIdx++;
      else { mx = dx / d; mz = dz / d; speed = r.stats.speed * 0.55; r.yaw = turnToward(r.yaw, Math.atan2(mx, mz), dt * 3); }
    } else {
      // Guard duty: look around now and then.
      r.idleTurnT -= dt;
      if (r.idleTurnT < 0) { r.idleTurnT = 2 + Math.random() * 4; r.lastSeen.set(r.pos.x + Math.random() - 0.5, 0, r.pos.z + Math.random() - 0.5); }
      r.yaw = turnToward(r.yaw, headingTo(r.pos.x, r.pos.z, r.lastSeen.x, r.lastSeen.z), dt * 1.5);
      const hx = r.home.x - r.pos.x, hz = r.home.z - r.pos.z, hd = Math.hypot(hx, hz);
      if (hd > 2) { mx = hx / hd; mz = hz / hd; speed = r.stats.speed * 0.6; r.yaw = turnToward(r.yaw, Math.atan2(mx, mz), dt * 4); }
    }
    // Unstick: if pushing but not moving, step sideways for a moment.
    if (r.sideStepT > 0) {
      r.sideStepT -= dt;
      const sx = -mz * r.strafe, sz = mx * r.strafe;
      mx = sx; mz = sz;
    }
    r.stuckT += dt;
    if (r.stuckT > 1.2) {
      if (speed > 0.5 && r.checkPos.distanceTo(r.pos) < 0.5) { r.sideStepT = 0.9; r.strafe *= -1; }
      r.stuckT = 0;
      r.checkPos.copy(r.pos);
    }
    r.pos.x += mx * speed * dt;
    r.pos.z += mz * speed * dt;
    const res = w.colliders.resolveCircle(r.pos.x, r.pos.z, RADIUS[r.kind], 0, h);
    r.pos.x = res.x;
    r.pos.z = res.z;
    // Never walk through the player.
    const p = w.player;
    if (p && !p.car) {
      const dx = r.pos.x - p.pos.x, dz = r.pos.z - p.pos.z, d = Math.hypot(dx, dz);
      const min = RADIUS[r.kind] + 0.5;
      if (d < min && d > 1e-3) { r.pos.x = p.pos.x + (dx / d) * min; r.pos.z = p.pos.z + (dz / d) * min; }
    }
    const anim = r.kind === "titan" ? 0.5 : r.kind === "brute" ? 0.7 : 1;
    if (speed > r.stats.speed * 0.9) r.visual.play("run", anim);
    else if (speed > 0.3) r.visual.play("walk", anim);
    else r.visual.play("idle");
  }

  private droneAi(r: Robot, dt: number, target: THREE.Vector3 | null): void {
    const w = this.world;
    this.lookCheck(r, dt, target, r.pos.y);
    let gx: number, gz: number, gy = r.hover + Math.sin(w.time * 1.7 + r.home.x) * 0.8;
    let speed = r.stats.speed;
    if (r.alert && target) {
      // Orbit the player at a comfortable firing distance.
      const ang = Math.atan2(r.pos.x - target.x, r.pos.z - target.z) + r.strafe * 0.6;
      gx = target.x + Math.sin(ang) * 16;
      gz = target.z + Math.cos(ang) * 16;
      if (Math.random() < dt * 0.25) r.strafe *= -1;
      r.yaw = turnToward(r.yaw, headingTo(r.pos.x, r.pos.z, target.x, target.z), dt * 4);
    } else if (r.patrol && r.patrol.length > 1) {
      const pt = r.patrol[r.patrolIdx % r.patrol.length];
      gx = pt.x; gz = pt.z;
      speed *= 0.5;
      if (Math.hypot(gx - r.pos.x, gz - r.pos.z) < 3) r.patrolIdx++;
      r.yaw = turnToward(r.yaw, headingTo(r.pos.x, r.pos.z, gx, gz), dt * 2);
    } else {
      gx = r.home.x + Math.sin(w.time * 0.4 + r.home.z) * 4;
      gz = r.home.z + Math.cos(w.time * 0.4 + r.home.x) * 4;
      speed *= 0.3;
    }
    const dx = gx - r.pos.x, dz = gz - r.pos.z, d = Math.hypot(dx, dz);
    const want = this.tmp.set(d > 0.5 ? (dx / d) * speed : 0, (gy - r.pos.y) * 2, d > 0.5 ? (dz / d) * speed : 0);
    r.vel.lerp(want, 1 - Math.exp(-3 * dt));
    r.pos.addScaledVector(r.vel, dt);
    const res = w.colliders.resolveCircle(r.pos.x, r.pos.z, RADIUS.drone, r.pos.y - 0.5, 1);
    r.pos.x = res.x;
    r.pos.z = res.z;
    const o = r.visual.object;
    o.rotation.z = clamp(-r.vel.x * 0.04, -0.4, 0.4);
    o.rotation.x = clamp(r.vel.z * 0.04, -0.4, 0.4);
  }

  private turretAi(r: Robot, dt: number, target: THREE.Vector3 | null): void {
    this.lookCheck(r, dt, target, r.pos.y + 2.6);
    if (target && r.canSee) r.yaw = turnToward(r.yaw, headingTo(r.pos.x, r.pos.z, target.x, target.z), dt * 2.2);
    else r.yaw += dt * 0.4;
  }

  private separate(): void {
    const l = this.list;
    for (let i = 0; i < l.length; i++) {
      const a = l[i];
      if (!a.alive || a.kind === "turret" || a.launched) continue;
      for (let j = i + 1; j < l.length; j++) {
        const b = l[j];
        if (!b.alive || b.kind === "turret" || b.launched || (a.kind === "drone") !== (b.kind === "drone")) continue;
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const min = RADIUS[a.kind] + RADIUS[b.kind];
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min || d2 < 1e-6) continue;
        const d = Math.sqrt(d2), push = (min - d) / 2;
        a.pos.x -= (dx / d) * push; a.pos.z -= (dz / d) * push;
        b.pos.x += (dx / d) * push; b.pos.z += (dz / d) * push;
      }
    }
  }
}
