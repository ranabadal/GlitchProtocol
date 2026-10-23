import * as THREE from "three";
import { HALF } from "@/lib/shared/city";
import type { Box } from "../Colliders";
import type { Input } from "../Input";
import { clamp, damp, dampAngle, wrapAngle } from "../mathx";
import { DEFAULT_SETTINGS, type GameSettings } from "../Settings";
import type { Fences } from "../world/MissionProps";
import { panFor, type PlayerLike, type World } from "../World";
import { makeRig, type CharacterRig, type SoldierTemplate } from "./Character";
import type { Heli, Metro, Station } from "./Rides";
import type { HitBy, Robot, Robots } from "./Robots";
import type { Car, Vehicles } from "./Vehicles";

/*
 * The operator.
 *   Move     WASD, mouse to look; Shift to run (uses stamina), Space to jump, C to dodge-roll
 *   Weapons  1 Blaster (heats up) · 2 Scatter gun · 3 Plasma bomb · 4 Energy blade,
 *            mouse wheel cycles; left click uses it, right click aims; V slaps anything
 *            in front of you (any weapon); Q fires the EMP blast
 *   Rides    F gets in/out of cars, the helicopters and the Skyline Metro
 * The camera sits over the right shoulder on foot and behind the vehicle when riding,
 * and never goes through walls.
 */

const RADIUS = 0.42;
const HEIGHT = 1.8;
const CAM_IGNORE: ReadonlySet<Box["kind"]> = new Set(["prop", "fence", "barricade"]);
const SHOT_IGNORE: ReadonlySet<Box["kind"]> = new Set(["fence"]);
export const EMP_COOLDOWN = 18;
export const EMP_RADIUS = 15;

export type WeaponId = "blaster" | "scatter" | "bomb" | "blade";
export const WEAPONS: { id: WeaponId; name: string; key: string }[] = [
  { id: "blaster", name: "Blaster", key: "1" },
  { id: "scatter", name: "Scatter", key: "2" },
  { id: "bomb", name: "Plasma Bomb", key: "3" },
  { id: "blade", name: "Energy Blade", key: "4" },
];
const BLASTER = { every: 0.11, damage: 22, heat: 0.065 };
const SCATTER = { every: 0.78, pellets: 8, damage: 12, spread: 0.065, range: 45, heat: 0.24 };
const BOMB = { max: 3, recharge: 9, fuse: 1.5, radius: 8, damage: 170, every: 0.7 };
const BLADE = { every: 0.34, damage: 55, finisher: 95, reach: 2.9, cone: 0.9 };
const SLAP = { every: 0.65, damage: 25, reach: 2.4 };
const STAMINA = { drain: 20, regen: 28, rollCost: 26 };
/** Sprint (Shift) and the normal running pace. */
const RUN_SPEED = 10.2, JOG_SPEED = 6.2;

/** Anything else the player's weapons can hit (the data truck). */
export interface HitTarget {
  alive: boolean;
  centre(out: THREE.Vector3): THREE.Vector3;
  radius: number;
  rayHit(o: THREE.Vector3, d: THREE.Vector3, maxT: number): number | null;
  hurt(amount: number, at: THREE.Vector3 | null, by: HitBy): void;
}

interface Bomb { mesh: THREE.Mesh; pos: THREE.Vector3; vel: THREE.Vector3; fuse: number; beepT: number }

export class Player implements PlayerLike {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  camYaw = 0;
  camPitch = -0.12;
  grounded = true;
  health = 100;
  alive = true;
  shielded = false;
  shieldUntil = 0;
  car: Car | null = null;
  heli: Heli | null = null;
  train: { metro: Metro; k: number; from: Station } | null = null;
  heat = 0;
  overheated = false;
  fireCd = 0;
  empCd = 0;
  recoil = 0;
  hurt = 0;
  aimBlend = 0;
  aiming = false;
  lastDamageAt = -99;
  damageDir: number | null = null;
  hitMarkerAt = -99;
  lastHurtAt = -99;
  frozen = false;
  hacking = false;
  rig: CharacterRig;
  glow: THREE.Color;
  settings: GameSettings = { ...DEFAULT_SETTINGS };
  weapon: WeaponId = "blaster";
  bombs = BOMB.max;
  bombCharge = 0;
  stamina = 100;
  running = false;
  rollT = -1;
  /** Shown above the HUD prompt by the Director (rides etc). */
  ridePrompt: string | null = null;
  /** Set when the player is waiting on a station pad for the train. */
  waitingAt: Station | null = null;
  /** Called once when health hits zero. */
  onDeath: (() => void) | null = null;
  onKillShot: ((robotId: string) => void) | null = null;
  /** Called when the player gets into a ride (for quips and notices). */
  onRide: ((kind: "car" | "heli" | "train") => void) | null = null;
  extraTargets: HitTarget[] = [];
  private zapAt = -99;
  private camDist = 3.6;
  private carOrbitIdle = 0;
  private carCamYaw = 0;
  private shake = 0;
  private fov = 70;
  private v = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private pivot = new THREE.Vector3();
  private noiseAt = -99;
  private deathT = 0;
  private swingT = -1;
  private swingSide = 1;
  private comboN = 0;
  private comboAt = -99;
  private throwT = -1;
  private thrown = false;
  private slapT = -1;
  private slapCd = 0;
  private rollCd = 0;
  private rollDir = new THREE.Vector3();
  private wasGrounded = true;
  private staminaLockUntil = 0;
  private bombsLive: Bomb[] = [];
  private bombGeo = new THREE.IcosahedronGeometry(0.16, 1);
  private bombMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 2.8, 2.3), toneMapped: false });
  carEnteredAt = -99;
  /** True while Shift-sprinting this frame. */
  sprinting = false;
  private stepPhase = 0;

  /** Laser fences the blaster can hit (set by the game once the mission is built). */
  fences: Fences | null = null;

  constructor(private world: World, private vehicles: Vehicles, private robots: Robots, hue: number, private rides: { helis: Heli[]; metro: Metro | null } = { helis: [], metro: null }, character: SoldierTemplate | null = null) {
    this.rig = makeRig(character, hue);
    this.glow = new THREE.Color().setHSL(hue / 360, 1, 0.6);
    world.scene.add(this.rig.root);
  }

  spawn(x: number, z: number, heading: number): void {
    this.pos.set(x, 0, z);
    this.vel.set(0, 0, 0);
    this.yaw = heading;
    this.camYaw = heading;
    this.camPitch = -0.12;
    this.health = 100;
    this.alive = true;
    this.car = null;
    this.heli = null;
    this.train = null;
    this.heat = 0;
    this.overheated = false;
    this.stamina = 100;
    this.shielded = true;
    this.shieldUntil = this.world.time + 3;
    this.rig.root.visible = true;
    this.deathT = 0;
    this.rollT = -1;
  }

  get riding(): "car" | "heli" | "train" | null {
    return this.car ? "car" : this.heli ? "heli" : this.train ? "train" : null;
  }

  aimPoint(out: THREE.Vector3): THREE.Vector3 {
    if (this.car) return out.set(this.car.pos.x, 1.0, this.car.pos.z);
    if (this.heli) return out.set(this.heli.pos.x, this.heli.pos.y + 1.5, this.heli.pos.z);
    return out.set(this.pos.x, this.pos.y + 1.25, this.pos.z);
  }

  /** Test-only invulnerability (debug builds). */
  god = false;

  takeDamage(amount: number, from: THREE.Vector3): void {
    if (!this.alive || this.shielded || this.god || this.train) return;
    // Rolling through fire: most of it misses.
    if (this.rollT >= 0 && this.rollT < 0.7) amount *= 0.25;
    this.health = Math.max(0, this.health - amount);
    this.hurt = 1;
    this.lastHurtAt = this.world.time;
    this.lastDamageAt = this.world.time;
    this.damageDir = wrapAngle(Math.atan2(from.x - this.pos.x, from.z - this.pos.z) - this.camYaw);
    this.world.sound.hurt();
    this.world.shake(0.15);
    if (this.health <= 0) this.die();
  }

  private die(): void {
    if (!this.alive) return;
    this.alive = false;
    this.deathT = 0;
    if (this.car) this.exitCar(true);
    if (this.heli) this.exitHeli(true);
    if (this.train) this.exitTrain(true);
    this.world.sound.down();
    this.onDeath?.();
  }

  // ------------------------------------------------------------ frame

  update(dt: number, input: Input, controls: boolean): void {
    const w = this.world;
    if (this.shielded && w.time > this.shieldUntil && !this.hacking) this.shielded = false;
    this.hurt = Math.max(0, this.hurt - dt * 3);
    this.recoil = Math.max(0, this.recoil - dt * 10);
    this.empCd = Math.max(0, this.empCd - dt);
    this.fireCd -= dt;
    this.slapCd -= dt;
    this.rollCd -= dt;
    this.ridePrompt = null;
    // Health regenerates after a few quiet seconds; plasma bombs recharge one at a time.
    if (this.alive && w.time - this.lastHurtAt > 3.5) this.health = Math.min(100, this.health + dt * 12);
    if (this.bombs < BOMB.max) {
      this.bombCharge += dt / BOMB.recharge;
      if (this.bombCharge >= 1) { this.bombCharge = 0; this.bombs++; }
    }

    const sens = (this.aiming ? 0.0013 : 0.0022) * this.settings.sensitivity;
    if (controls && !this.frozen) {
      this.camYaw -= input.mouseDX * sens;
      this.camPitch = clamp(this.camPitch - input.mouseDY * sens * (this.settings.invertY ? -1 : 1), -1.1, 0.75);
      if ((this.car || this.heli) && (input.mouseDX !== 0 || input.mouseDY !== 0)) this.carOrbitIdle = 0;
      this.switchWeapon(input);
    }

    this.updateBombs(dt);

    if (!this.alive) {
      this.deathT += dt;
      this.rig.update(dt, { speed: 0, grounded: true, aim: 0, pitch: 0, recoil: 0, hack: false, dead: true, hurt: 0 });
      this.deathCamera(dt);
      return;
    }

    if (this.car) this.driving(dt, input, controls);
    else if (this.heli) this.flying(dt, input, controls);
    else if (this.train) this.riding_(dt, input, controls);
    else this.onFoot(dt, input, controls);

    // Heat cools when not firing.
    if (!(controls && input.fire && this.weapon === "blaster") || this.overheated || this.car) {
      this.heat = Math.max(0, this.heat - dt * (this.overheated ? 0.42 : 0.65));
      if (this.overheated && this.heat < 0.25) this.overheated = false;
    }
  }

  private switchWeapon(input: Input): void {
    let next: WeaponId | null = null;
    WEAPONS.forEach((wp) => { if (input.hit(`Digit${wp.key}`) || input.hit(`Numpad${wp.key}`)) next = wp.id; });
    if (input.wheel !== 0) {
      const i = WEAPONS.findIndex((x) => x.id === this.weapon);
      next = WEAPONS[(i + (input.wheel > 0 ? 1 : -1) + WEAPONS.length) % WEAPONS.length].id;
    }
    if (next && next !== this.weapon) {
      this.weapon = next;
      this.fireCd = Math.max(this.fireCd, 0.15);
      this.swingT = -1;
      this.world.sound.weaponSwitch();
    }
  }

  private onFoot(dt: number, input: Input, controls: boolean): void {
    const w = this.world;
    const c = controls && !this.frozen;
    const fwdIn = c ? input.axis(["KeyS", "ArrowDown"], ["KeyW", "ArrowUp"]) : 0;
    const sideIn = c ? input.axis(["KeyA", "ArrowLeft"], ["KeyD", "ArrowRight"]) : 0;
    this.aiming = c && input.aim && this.weapon !== "blade";
    const shift = input.down("ShiftLeft") || input.down("ShiftRight");
    if (this.settings.toggleRun) { if (c && (input.hit("ShiftLeft") || input.hit("ShiftRight"))) this.running = !this.running; }
    else this.running = shift;
    const moving = Math.abs(fwdIn) + Math.abs(sideIn) > 0;
    const canRun = this.stamina > 0 && w.time >= this.staminaLockUntil;
    const sprint = c && this.running && !this.aiming && moving && canRun && fwdIn >= 0;
    if (sprint) {
      this.stamina = Math.max(0, this.stamina - STAMINA.drain * dt);
      if (this.stamina <= 0) { this.staminaLockUntil = w.time + 1.2; this.running = this.settings.toggleRun ? false : this.running; }
    } else if (this.rollT < 0) {
      this.stamina = Math.min(100, this.stamina + STAMINA.regen * dt * (moving ? 0.7 : 1));
    }
    const fx = Math.sin(this.camYaw), fz = Math.cos(this.camYaw);
    const rx = -fz, rz = fx;
    let mx = fx * fwdIn + rx * sideIn, mz = fz * fwdIn + rz * sideIn;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }

    // Dodge roll: a quick burst in the movement direction with brief cover from bolts.
    if (c && input.hit("KeyC") && this.rollT < 0 && this.rollCd <= 0 && this.grounded && this.stamina >= 10) {
      this.rollT = 0;
      this.rollCd = 0.9;
      this.stamina = Math.max(0, this.stamina - STAMINA.rollCost);
      if (ml > 0.1) this.rollDir.set(mx, 0, mz).normalize();
      else this.rollDir.set(fx, 0, fz);
      this.yaw = Math.atan2(this.rollDir.x, this.rollDir.z);
      w.sound.roll();
      w.fx.dust(this.pos, 5);
    }
    if (this.rollT >= 0) {
      this.rollT += dt / 0.55;
      const sp = 11.5 * (1 - this.rollT * 0.5);
      this.vel.x = this.rollDir.x * sp;
      this.vel.z = this.rollDir.z * sp;
      if (this.rollT >= 1) this.rollT = -1;
    } else {
      const speed = this.aiming ? 3.6 : sprint ? RUN_SPEED : JOG_SPEED;
      const rate = this.grounded ? 14 : 3;
      this.vel.x = damp(this.vel.x, mx * speed, rate, dt);
      this.vel.z = damp(this.vel.z, mz * speed, rate, dt);
      if (c && input.hit("Space") && this.grounded) { this.vel.y = 7.4; this.grounded = false; }
    }
    this.vel.y -= 21 * dt;
    this.pos.addScaledVector(this.vel, dt);
    if (this.pos.y <= 0) { this.pos.y = 0; this.vel.y = 0; this.grounded = true; }
    if (this.grounded && !this.wasGrounded) { w.sound.land(); w.fx.dust(this.pos, 4); }
    this.wasGrounded = this.grounded;
    // Footsteps (and dust kicked up when sprinting), in time with the stride.
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (this.grounded && hs > 1.5 && this.rollT < 0) {
      this.stepPhase += dt * (hs > 7.5 ? 3.0 : hs > 2.5 ? 2.7 : 1.9);
      if (this.stepPhase >= 1) {
        this.stepPhase -= 1;
        w.sound.step(sprint);
        if (sprint) w.fx.dust(this.pos, 1);
      }
    }
    this.sprinting = sprint;

    // Collisions: world, then cars.
    const res = w.colliders.resolveCircle(this.pos.x, this.pos.z, RADIUS, this.pos.y, HEIGHT);
    this.pos.x = res.x;
    this.pos.z = res.z;
    if (res.hit && res.box?.kind === "fence" && w.time - this.zapAt > 0.6) {
      this.zapAt = w.time;
      this.takeDamage(12, this.v.set(this.pos.x - res.nx, 1, this.pos.z - res.nz));
      this.vel.x = res.nx * 9;
      this.vel.z = res.nz * 9;
      this.vel.y = 3;
      w.fx.sparks(this.v.set(this.pos.x - res.nx * 0.5, 1.2, this.pos.z - res.nz * 0.5), new THREE.Vector3(res.nx, 0, res.nz), new THREE.Color(1, 0.2, 0.3), 16, 8);
      w.sound.overheat();
    }
    this.vehicles.pushOut(this.pos, RADIUS);
    for (const h of this.rides.helis) {
      const dx = this.pos.x - h.pos.x, dz = this.pos.z - h.pos.z, d = Math.hypot(dx, dz);
      if (d < 2.2 && d > 1e-3 && this.pos.y < h.pos.y + 2.5) { this.pos.x = h.pos.x + (dx / d) * 2.2; this.pos.z = h.pos.z + (dz / d) * 2.2; }
    }
    this.pos.x = clamp(this.pos.x, -HALF + 1, HALF - 1);
    this.pos.z = clamp(this.pos.z, -HALF + 1, HALF - 1);

    // Facing: toward the camera while aiming/attacking, else toward movement.
    const attacking = c && input.fire;
    if (this.rollT >= 0) { /* keep the roll direction */ }
    else if (this.aiming || attacking || this.world.time - this.lastShotAt < 0.6 || this.swingT >= 0 || this.slapT >= 0) {
      this.yaw = dampAngle(this.yaw, this.camYaw, 18, dt);
      this.aimBlend = Math.min(1, this.aimBlend + dt * 8);
    } else {
      this.aimBlend = Math.max(0, this.aimBlend - dt * 4);
      if (ml > 0.1) this.yaw = dampAngle(this.yaw, Math.atan2(mx, mz), 12, dt);
    }

    if (c && this.rollT < 0) {
      if (input.fire) this.useWeapon(input.firePressed);
      if (input.hit("KeyV")) this.trySlap();
      if (input.hit("KeyQ")) this.emp();
      if (input.hit("KeyF")) this.tryBoard();
    }
    this.updateMelee(dt);
    this.updateRidePrompts();

    const hspeed = Math.hypot(this.vel.x, this.vel.z);
    this.rig.root.position.copy(this.pos);
    this.rig.root.rotation.y = this.yaw;
    // Getting into a car / helicopter / train happens earlier in this same step: stay hidden then.
    this.rig.root.visible = !this.riding;
    const gunUp = this.weapon === "blaster" || this.weapon === "scatter" ? this.aimBlend : this.aimBlend * 0.3;
    this.rig.update(dt, {
      speed: hspeed, grounded: this.grounded, aim: this.hacking ? 0 : gunUp, pitch: this.camPitch, recoil: this.recoil, hack: this.hacking, dead: false, hurt: this.hurt,
      weapon: this.weapon, swing: this.swingT, swingSide: this.swingSide, throwT: this.throwT, slapT: this.slapT, roll: this.rollT,
    });
    this.footCamera(dt, sprint);
  }

  // ------------------------------------------------------------ weapons

  private lastShotAt = -99;

  private useWeapon(pressed: boolean): void {
    if (this.frozen || this.fireCd > 0) return;
    switch (this.weapon) {
      case "blaster": this.fireBlaster(); break;
      case "scatter": this.fireScatter(); break;
      case "bomb": if (pressed || this.throwT < 0) this.throwBomb(); break;
      case "blade": this.slash(); break;
    }
  }

  /** Camera ray with a gentle aim assist toward a robot right next to the crosshair. */
  private aimRay(maxT: number): { o: THREE.Vector3; d: THREE.Vector3; minT: number } {
    const cam = this.world.camera;
    const o = cam.position.clone();
    const d = cam.getWorldDirection(this.dir).clone();
    const minT = this.heli ? 0 : o.distanceTo(this.pivot) * 0.9;
    if (!this.robots.hitScan(o, d, maxT)) {
      const a = this.robots.assist(o, d, maxT, this.aiming ? 0.02 : 0.035);
      if (a) d.copy(a.centre(this.v)).sub(o).normalize();
    }
    return { o, d, minT };
  }

  /** One hitscan shot along (o, d); returns what it hit. */
  private shoot(o: THREE.Vector3, d: THREE.Vector3, minT: number, maxT: number, damage: number, by: HitBy, muzzle: THREE.Vector3, tracer: boolean): "robot" | "other" | "none" {
    const w = this.world;
    const rh = this.robots.hitScan(o, d, maxT);
    const fh = this.fences?.hitScan(o, d, maxT) ?? null;
    const wh = w.colliders.raycast(o.x, o.y, o.z, d.x, d.y, d.z, maxT, SHOT_IGNORE);
    let t = maxT;
    let kind: "robot" | "pylon" | "world" | "extra" | "none" = "none";
    let extra: HitTarget | null = null;
    if (wh && wh.t > minT) { t = wh.t; kind = "world"; }
    if (rh && rh.t > minT && rh.t < t) { t = rh.t; kind = "robot"; }
    if (fh && fh.t > minT && fh.t < t) { t = fh.t; kind = "pylon"; }
    for (const x of this.extraTargets) {
      if (!x.alive) continue;
      const xt = x.rayHit(o, d, maxT);
      if (xt !== null && xt > minT && xt < t) { t = xt; kind = "extra"; extra = x; }
    }
    const hit = o.clone().addScaledVector(d, t);
    if (tracer) w.fx.tracer(muzzle, hit, by === "scatter" ? new THREE.Color(1, 0.6, 0.2) : this.glow, by === "scatter" ? 0.04 : 0.07, by === "scatter" ? 0.06 : 0.08);
    if (kind === "robot" && rh) {
      const killed = this.robots.damage(rh.robot, damage, hit, by);
      this.hitMarkerAt = w.time;
      if (killed) this.onKillShot?.(rh.robot.id);
      return "robot";
    } else if (kind === "extra" && extra) {
      extra.hurt(damage, hit, by);
      this.hitMarkerAt = w.time;
      return "robot";
    } else if (kind === "pylon" && fh && this.fences) {
      this.fences.damage(fh.fence, fh.pylon, by === "scatter" ? 12 : 30);
      this.hitMarkerAt = w.time;
      w.fx.sparks(hit, null, new THREE.Color(1, 0.3, 0.3), 10, 8);
      return "other";
    } else if (kind === "world" && wh) {
      w.fx.sparks(hit, new THREE.Vector3(wh.nx, wh.ny, wh.nz), this.glow, 6, 6);
      if (Math.random() < 0.3) w.sound.ricochet();
    }
    return "none";
  }

  private fireBlaster(muzzleOverride?: THREE.Vector3): void {
    const w = this.world;
    if (this.overheated) { w.sound.empty(); return; }
    this.fireCd = BLASTER.every;
    this.lastShotAt = w.time;
    this.heat = Math.min(1, this.heat + BLASTER.heat);
    if (this.heat >= 1) { this.overheated = true; w.sound.overheat(); }
    this.recoil = 1;
    const { o, d, minT } = this.aimRay(170);
    const muzzle = muzzleOverride ?? this.rig.muzzle.getWorldPosition(new THREE.Vector3());
    if (this.shoot(o, d, minT, 170, BLASTER.damage, "gun", muzzle, true) === "robot") w.sound.hitMarker();
    w.fx.muzzle(muzzle, this.glow);
    w.sound.blaster();
    this.makeNoise(45, "gunfire");
  }

  private fireScatter(): void {
    const w = this.world;
    if (this.overheated) { w.sound.empty(); return; }
    this.fireCd = SCATTER.every;
    this.lastShotAt = w.time;
    this.heat = Math.min(1, this.heat + SCATTER.heat);
    if (this.heat >= 1) { this.overheated = true; w.sound.overheat(); }
    this.recoil = 1;
    const { o, d, minT } = this.aimRay(SCATTER.range);
    const muzzle = this.rig.scatterMuzzle.getWorldPosition(new THREE.Vector3());
    let hits = 0;
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(d, up).normalize();
    const realUp = new THREE.Vector3().crossVectors(right, d).normalize();
    for (let i = 0; i < SCATTER.pellets; i++) {
      const a = (i / SCATTER.pellets) * Math.PI * 2 + Math.random() * 0.5;
      const r = SCATTER.spread * (0.35 + Math.random() * 0.65);
      const pd = d.clone().addScaledVector(right, Math.cos(a) * r).addScaledVector(realUp, Math.sin(a) * r).normalize();
      if (this.shoot(o, pd, minT, SCATTER.range, SCATTER.damage, "scatter", muzzle, i % 2 === 0) === "robot") hits++;
    }
    if (hits) w.sound.hitMarker();
    for (let i = 0; i < 3; i++) w.fx.muzzle(muzzle, new THREE.Color(1, 0.55, 0.15));
    w.sound.scatter();
    w.shake(0.12);
    this.makeNoise(55, "gunfire");
  }

  private throwBomb(): void {
    const w = this.world;
    if (this.throwT >= 0) return;
    if (this.bombs <= 0) { w.sound.empty(); this.fireCd = 0.3; return; }
    this.throwT = 0;
    this.thrown = false;
    this.fireCd = BOMB.every;
  }

  private launchBomb(): void {
    const w = this.world;
    this.bombs--;
    const cam = w.camera;
    const d = cam.getWorldDirection(this.dir).clone();
    const start = new THREE.Vector3(this.pos.x + Math.sin(this.yaw) * 0.5, this.pos.y + 1.7, this.pos.z + Math.cos(this.yaw) * 0.5);
    const vel = d.multiplyScalar(19).add(new THREE.Vector3(0, 4.5, 0)).add(new THREE.Vector3(this.vel.x * 0.5, 0, this.vel.z * 0.5));
    const mesh = new THREE.Mesh(this.bombGeo, this.bombMat);
    mesh.position.copy(start);
    w.scene.add(mesh);
    this.bombsLive.push({ mesh, pos: start, vel, fuse: BOMB.fuse, beepT: 0 });
    w.sound.throwWhoosh();
  }

  private updateBombs(dt: number): void {
    const w = this.world;
    for (const b of [...this.bombsLive]) {
      b.fuse -= dt;
      b.beepT -= dt;
      if (b.beepT <= 0) { b.beepT = Math.max(0.08, b.fuse * 0.25); w.sound.bombBeep(); }
      b.vel.y -= 20 * dt;
      const step = b.vel.length() * dt;
      const dn = b.vel.clone().normalize();
      const hit = w.colliders.raycast(b.pos.x, b.pos.y, b.pos.z, dn.x, dn.y, dn.z, step + 0.15);
      if (hit) {
        // Bounce off walls.
        const n = new THREE.Vector3(hit.nx, hit.ny, hit.nz);
        b.vel.reflect(n).multiplyScalar(0.45);
        b.pos.set(hit.x + n.x * 0.2, hit.y + n.y * 0.2, hit.z + n.z * 0.2);
      } else b.pos.addScaledVector(b.vel, dt);
      if (b.pos.y < 0.16) { b.pos.y = 0.16; b.vel.y = Math.abs(b.vel.y) * 0.35; b.vel.x *= 0.7; b.vel.z *= 0.7; }
      // Sticks to robots it touches.
      let stuck = false;
      for (const r of this.robots.list) {
        if (!r.alive) continue;
        if (r.centre(this.v).distanceTo(b.pos) < 1.4 + (r.kind === "titan" ? 1.2 : 0)) { stuck = true; break; }
      }
      for (const x of this.extraTargets) if (x.alive && x.centre(this.v).distanceTo(b.pos) < x.radius + 0.6) stuck = true;
      if (stuck) b.fuse = Math.min(b.fuse, 0.12);
      b.mesh.position.copy(b.pos);
      b.mesh.rotation.x += dt * 9;
      (b.mesh.material as THREE.MeshBasicMaterial).color.setRGB(0.5, 2.8, 2.3).multiplyScalar(b.fuse < 0.5 && Math.sin(b.fuse * 60) > 0 ? 2 : 1);
      if (b.fuse <= 0) this.explodeBomb(b);
    }
  }

  private explodeBomb(b: Bomb): void {
    const w = this.world;
    w.scene.remove(b.mesh);
    this.bombsLive.splice(this.bombsLive.indexOf(b), 1);
    const c = b.pos.clone().setY(Math.max(0.6, b.pos.y));
    w.fx.explosion(c, 1.8, new THREE.Color(0.4, 1, 0.9));
    w.fx.ring(c, BOMB.radius, new THREE.Color(0.3, 1, 0.9), 0.6);
    const sp = panFor(w, c.x, c.z);
    w.sound.bigBoom(Math.max(0.5, sp.vol), sp.pan);
    w.shake(0.6 * Math.max(0.4, sp.vol));
    const kills = this.robots.blast(c, BOMB.radius, BOMB.damage);
    for (const x of this.extraTargets) {
      if (!x.alive) continue;
      const d = x.centre(this.v).distanceTo(c);
      if (d < BOMB.radius + x.radius) x.hurt(BOMB.damage * Math.max(0.3, 1 - d / (BOMB.radius + x.radius)), null, "bomb");
    }
    if (kills > 0) this.hitMarkerAt = w.time;
    for (const f of this.fences?.list ?? []) {
      if (!f.active) continue;
      f.pylons.forEach((pyl, i) => { if (pyl.hp > 0 && pyl.pos.distanceTo(c) < BOMB.radius) this.fences!.damage(f, i, 60); });
    }
    // Too close to your own bomb hurts a little.
    const self = Math.hypot(this.pos.x - c.x, this.pos.z - c.z);
    if (self < 3.5 && !this.car && !this.heli) this.takeDamage(16 * (1 - self / 3.5), c);
    w.noise(c.x, c.z, 60, "explosion");
  }

  /** Energy blade: a quick slash at whatever is in front; every third hit is a finisher. */
  private slash(): void {
    const w = this.world;
    this.fireCd = BLADE.every;
    this.swingT = 0;
    this.swingSide = -this.swingSide;
    const finisher = w.time - this.comboAt < 0.9 && this.comboN >= 2;
    this.comboN = finisher ? 0 : (w.time - this.comboAt < 0.9 ? this.comboN + 1 : 1);
    this.comboAt = w.time;
    w.sound.swish();
    // Lunge toward the nearest robot in reach.
    const fx = Math.sin(this.camYaw), fz = Math.cos(this.camYaw);
    let hitAny = false;
    const reach = BLADE.reach + (finisher ? 0.6 : 0);
    for (const r of [...this.robots.list]) {
      if (!r.alive || r.kind === "drone" && r.pos.y > 4) continue;
      if (!this.inFront(r.pos, reach + (r.kind === "titan" ? 1.6 : r.kind === "brute" ? 0.6 : 0), BLADE.cone, fx, fz)) continue;
      const at = r.centre(this.v).clone();
      this.robots.damage(r, finisher ? BLADE.finisher : BLADE.damage, at, "blade");
      hitAny = true;
    }
    for (const x of this.extraTargets) if (x.alive && this.inFront(x.centre(this.v), reach + x.radius, BLADE.cone, fx, fz)) { x.hurt(finisher ? BLADE.finisher : BLADE.damage, null, "blade"); hitAny = true; }
    if (hitAny) {
      this.hitMarkerAt = w.time;
      w.sound.bladeHit();
      if (finisher) { w.shake(0.2); w.fx.word(this.pos.clone().setY(2.6).add(new THREE.Vector3(fx * 1.5, 0, fz * 1.5)), "COMBO!", "#7dfcff", 1.1); }
    }
    this.vel.x += fx * (hitAny ? 2 : 4);
    this.vel.z += fz * (hitAny ? 2 : 4);
    this.makeNoise(20, "gunfire");
  }

  /** Slap with the free hand: works with any weapon equipped. */
  private trySlap(): void {
    const w = this.world;
    if (this.slapCd > 0 || this.slapT >= 0) return;
    this.slapCd = SLAP.every;
    this.slapT = 0;
    const fx = Math.sin(this.camYaw), fz = Math.cos(this.camYaw);
    let target: Robot | null = null, best = Infinity;
    for (const r of this.robots.list) {
      if (!r.alive || (r.kind === "drone" && r.pos.y > 3.5)) continue;
      const reach = SLAP.reach + (r.kind === "titan" ? 1.6 : r.kind === "brute" || r.kind === "turret" ? 0.6 : 0);
      if (!this.inFront(r.pos, reach, 1.0, fx, fz)) continue;
      const d = Math.hypot(r.pos.x - this.pos.x, r.pos.z - this.pos.z);
      if (d < best) { best = d; target = r; }
    }
    const extra = this.extraTargets.find((x) => x.alive && this.inFront(x.centre(this.v), SLAP.reach + x.radius, 1.0, fx, fz));
    if (target) {
      const killed = this.robots.slap(target, fx, fz, SLAP.damage);
      const at = target.centre(this.v).clone();
      w.fx.stars(at);
      w.fx.word(at.clone().setY(at.y + 1.4), "CHATAAK!", "#ff8ad8", 1.4);
      w.sound.slap();
      w.shake(0.18);
      this.hitMarkerAt = w.time;
      if (killed) this.onKillShot?.(target.id);
      this.makeNoise(25, "gunfire");
    } else if (extra) {
      extra.hurt(SLAP.damage, null, "slap");
      const at = extra.centre(this.v).clone();
      w.fx.word(at.setY(at.y + 2), "CHATAAK!", "#ff8ad8", 1.4);
      w.sound.slap();
    } else {
      w.sound.slapMiss();
    }
  }

  private inFront(p: THREE.Vector3, reach: number, cone: number, fx: number, fz: number): boolean {
    const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > reach) return false;
    if (d < 0.8) return true;
    return (dx * fx + dz * fz) / d > Math.cos(cone);
  }

  private updateMelee(dt: number): void {
    if (this.swingT >= 0) {
      const prev = this.swingT;
      this.swingT += dt / 0.26;
      if (prev < 0.5 && this.swingT >= 0.5) {
        const tip = this.rig.bladeTip.getWorldPosition(new THREE.Vector3());
        const base = this.pos.clone().setY(this.pos.y + 1.3);
        this.world.fx.slash(base, tip, this.glow);
      }
      if (this.swingT >= 1) this.swingT = -1;
    }
    if (this.throwT >= 0) {
      this.throwT += dt / 0.5;
      if (!this.thrown && this.throwT >= 0.45) { this.thrown = true; this.launchBomb(); }
      if (this.throwT >= 1) this.throwT = -1;
    }
    if (this.slapT >= 0) {
      this.slapT += dt / 0.3;
      if (this.slapT >= 1) this.slapT = -1;
    }
  }

  private makeNoise(r: number, kind: "gunfire" | "explosion"): void {
    const w = this.world;
    if (w.time - this.noiseAt > 0.5) { this.noiseAt = w.time; w.noise(this.pos.x, this.pos.z, r, kind); }
  }

  emp(): boolean {
    const w = this.world;
    if (this.empCd > 0 || this.frozen || !this.alive) return false;
    this.empCd = EMP_COOLDOWN;
    const c = this.aimPoint(this.v).clone();
    const n = this.robots.emp(c, EMP_RADIUS);
    for (const x of this.extraTargets) if (x.alive && x.centre(this.v).distanceTo(c) < EMP_RADIUS + x.radius) x.hurt(40, null, "emp");
    w.fx.ring(c.clone().setY(0.6), EMP_RADIUS, new THREE.Color(0.3, 0.9, 1), 0.7);
    w.fx.ring(c.clone().setY(1.6), EMP_RADIUS * 0.7, new THREE.Color(0.6, 0.95, 1), 0.5);
    w.fx.sparks(c, null, new THREE.Color(0.4, 0.9, 1), 40, 14);
    w.sound.emp();
    w.shake(0.4);
    w.noise(c.x, c.z, 40, "explosion");
    return n > 0;
  }

  // ------------------------------------------------------------ rides

  /** What F would do right now, for the HUD prompt. */
  private updateRidePrompts(): void {
    const heli = this.nearestHeli();
    if (heli) { this.ridePrompt = "F · Helicopter udao"; return; }
    const metro = this.rides.metro;
    const st = metro?.stationNear(this.pos, 3.2) ?? null;
    if (metro && st) {
      const next = metro.nextAt(st, this.world.time);
      this.ridePrompt = this.waitingAt === st
        ? (next.wait < 0.5 ? "Metro aa gayi! Board ho rahe ho..." : `Metro ${Math.ceil(next.wait)}s mein aa rahi hai · pad pe raho`)
        : next.wait < 0.5 ? `F · Skyline Metro mein baitho (${st.name})` : `F · Metro ka wait karo (${Math.ceil(next.wait)}s)`;
      if (this.waitingAt === st && next.wait < 0.5) this.boardTrain(st, next.train);
    } else this.waitingAt = null;
  }

  private nearestHeli(): Heli | null {
    for (const h of this.rides.helis) if (!h.occupied && Math.hypot(this.pos.x - h.pos.x, this.pos.z - h.pos.z) < 4 && Math.abs(this.pos.y - h.pos.y) < 2) return h;
    return null;
  }

  private tryBoard(): void {
    const heli = this.nearestHeli();
    if (heli) { this.enterHeli(heli); return; }
    const metro = this.rides.metro;
    const st = metro?.stationNear(this.pos, 3.2);
    if (metro && st) {
      const next = metro.nextAt(st, this.world.time);
      if (next.wait < 0.5) this.boardTrain(st, next.train);
      else this.waitingAt = st;
      return;
    }
    this.tryEnterCar();
  }

  private enterHeli(h: Heli): void {
    this.heli = h;
    h.occupied = true;
    this.carEnteredAt = this.world.time;
    this.carOrbitIdle = 0;
    this.camYaw = h.heading;
    this.rig.root.visible = false;
    this.world.sound.door();
    this.onRide?.("heli");
  }

  exitHeli(force = false): boolean {
    const h = this.heli;
    if (!h) return false;
    if (!force && (h.pos.y > h.ground + 1.2 || h.ground > 0.5)) return false;
    const side = new THREE.Vector3(-Math.cos(h.heading), 0, Math.sin(h.heading));
    this.pos.set(h.pos.x + side.x * 2.8, Math.max(0, h.ground), h.pos.z + side.z * 2.8);
    if (force && h.pos.y > 2) this.vel.set(0, -2, 0);
    this.grounded = this.pos.y <= 0;
    h.occupied = false;
    this.heli = null;
    this.rig.root.visible = true;
    this.world.sound.setRotor(false);
    this.world.sound.door();
    return true;
  }

  private flying(dt: number, input: Input, controls: boolean): void {
    const h = this.heli!;
    const c = controls && !this.frozen;
    const fwd = c ? input.axis(["KeyS", "ArrowDown"], ["KeyW", "ArrowUp"]) : 0;
    const side = c ? input.axis(["KeyA", "ArrowLeft"], ["KeyD", "ArrowRight"]) : 0;
    const up = c ? (input.down("Space") ? 1 : 0) - (input.down("ShiftLeft") || input.down("ShiftRight") || input.down("KeyC") ? 1 : 0) : 0;
    h.fly(dt, { fwd, side, up, yawTo: this.camYaw, on: true }, this.world.colliders);
    this.world.sound.setRotor(true, clamp((h.pos.y - h.ground) / 20 + Math.abs(up) * 0.3, 0, 1), h.speed / 30);
    this.pos.copy(h.pos);
    this.vel.copy(h.vel);
    if (c && input.fire && this.fireCd <= 0 && h.spin > 0.8) this.fireBlaster(h.nose(new THREE.Vector3()));
    if (c && input.hit("KeyQ")) this.emp();
    const low = h.pos.y <= h.ground + 1.2;
    if (low && h.ground <= 0.5) this.ridePrompt = "F · Helicopter se utro";
    else if (low) this.ridePrompt = "Roof pe utar nahi sakte: sadak pe land karo";
    else this.ridePrompt = "Space upar · Shift neeche · Click fire";
    if (c && input.hit("KeyF") && this.world.time - this.carEnteredAt > 0.4) {
      if (!this.exitHeli()) this.world.sound.empty();
    }
  }

  private boardTrain(st: Station, k: number): void {
    this.train = { metro: this.rides.metro!, k, from: st };
    this.waitingAt = null;
    this.carEnteredAt = this.world.time;
    this.rig.root.visible = false;
    this.world.sound.stationBell();
    this.onRide?.("train");
  }

  exitTrain(force = false): boolean {
    const t = this.train;
    if (!t) return false;
    const r = t.metro.trainS(t.k, this.world.time);
    if (!force && r.docked === null) return false;
    const st = r.docked !== null ? t.metro.stations[r.docked] : null;
    if (st) this.pos.set(st.pad.x, 0, st.pad.z);
    else { this.pos.set(this.pos.x + 3, 0, this.pos.z + 3); }
    this.vel.set(0, 0, 0);
    this.train = null;
    this.rig.root.visible = true;
    this.world.sound.setTrain(false);
    this.world.sound.stationBell();
    return true;
  }

  private riding_(dt: number, input: Input, controls: boolean): void {
    const t = this.train!;
    const r = t.metro.trainS(t.k, this.world.time);
    const p = new THREE.Vector3();
    const heading = t.metro.at(r.s - 12, p);
    this.pos.set(p.x, p.y + 1.5, p.z);
    this.vel.set(Math.sin(heading) * r.speed, 0, Math.cos(heading) * r.speed);
    this.world.sound.setTrain(true, Math.min(1, r.speed / 24), dt);
    if (r.docked !== null) {
      const st = t.metro.stations[r.docked];
      this.ridePrompt = st.id === t.from.id && this.world.time - this.carEnteredAt < 6 ? `${st.name} · train chalne wali hai` : `F · ${st.name} pe utro`;
    } else this.ridePrompt = "Skyline Metro · agle station pe F se utro";
    if (controls && !this.frozen && input.hit("KeyF") && this.world.time - this.carEnteredAt > 0.4) {
      if (!this.exitTrain()) this.world.sound.empty();
    }
    this.trainCamera(dt, heading);
  }

  private tryEnterCar(): void {
    const car = this.vehicles.nearestEnterable(this.pos, 3.0);
    if (!car) return;
    this.vehicles.takeControl(car);
    this.car = car;
    this.carEnteredAt = this.world.time;
    this.carCamYaw = car.heading;
    car.onDamage = (amount, from) => {
      this.lastDamageAt = this.world.time;
      this.damageDir = wrapAngle(Math.atan2(from.x - car.pos.x, from.z - car.pos.z) - this.camYaw);
      this.world.shake(Math.min(0.3, amount / 40));
    };
    this.rig.root.visible = false;
    this.world.sound.door();
    this.onRide?.("car");
  }

  exitCar(force = false): boolean {
    const car = this.car;
    if (!car) return false;
    if (!force && Math.abs(car.speed) > 14) return false;
    const h = car.heading;
    const spots = [[-Math.cos(h), Math.sin(h)], [Math.cos(h), -Math.sin(h)], [Math.sin(h), Math.cos(h)], [-Math.sin(h), -Math.cos(h)]];
    let placed = false;
    for (const [sx, sz] of spots) {
      const d = car.v.width / 2 + 1.0 + (Math.abs(sz) > 0.7 ? car.v.length / 2 - car.v.width / 2 : 0);
      const x = car.pos.x + sx * d, z = car.pos.z + sz * d;
      if (!this.world.colliders.overlaps(x, z, RADIUS, 0, HEIGHT)) { this.pos.set(x, 0, z); placed = true; break; }
    }
    if (!placed) this.pos.set(car.pos.x, 0, car.pos.z);
    this.vel.set(car.vel.x * 0.3, 0, car.vel.z * 0.3);
    this.yaw = h;
    this.camYaw = this.carCamYaw;
    car.onDamage = null;
    this.vehicles.release(car);
    this.world.sound.setEngine(false);
    this.car = null;
    this.rig.root.visible = true;
    this.world.sound.door();
    return true;
  }

  private driving(dt: number, input: Input, controls: boolean): void {
    const car = this.car!;
    const c = controls && !this.frozen;
    const throttle = c ? Math.max(0, input.axis(["KeyS", "ArrowDown"], ["KeyW", "ArrowUp"])) : 0;
    const brake = c && (input.down("KeyS") || input.down("ArrowDown")) ? 1 : 0;
    const steer = c ? -input.axis(["KeyA", "ArrowLeft"], ["KeyD", "ArrowRight"]) : 0;
    const boost = c && (input.down("ShiftLeft") || input.down("ShiftRight"));
    this.vehicles.drive(car, { throttle, brake, steer, handbrake: c && input.down("Space"), boost }, dt);
    this.world.sound.setEngine(true, clamp(Math.abs(car.speed) / car.v.maxSpeed, 0, 1), Math.max(throttle, boost ? 1 : 0));
    if (c && input.hit("KeyH")) this.world.sound.horn();
    if (c && input.hit("KeyQ")) this.emp();
    this.pos.set(car.pos.x, 0, car.pos.z);
    this.vel.copy(car.vel);
    // Drift smoke.
    if (Math.abs(car.speed) > 12 && c && input.down("Space") && Math.random() < 0.6) this.world.fx.dust(car.pos, 1);
    // The car blew up with us inside.
    if (car.dead) {
      this.exitCar(true);
      this.takeDamage(30, car.pos);
      this.vel.set(Math.random() * 6 - 3, 6, Math.random() * 6 - 3);
      this.grounded = false;
      return;
    }
    if (c && input.hit("KeyF") && this.world.time - this.carEnteredAt > 0.4) { this.exitCar(); return; }
  }

  /** Chase cameras run after the vehicle physics step, so they never lag a frame behind. */
  postUpdate(dt: number): void {
    if (!this.alive) return;
    if (this.car) this.carCamera(dt, this.car.pos, this.car.heading, this.car.speed, this.car.variant === 2 ? 1.5 : 0, 1.7 + (this.car.variant === 2 ? 0.8 : 0));
    else if (this.heli) this.carCamera(dt, this.heli.pos, this.heli.heading, this.heli.speed, 7, this.heli.pos.y + 2.4 - this.heli.pos.y);
  }

  // ------------------------------------------------------------ cameras

  addShake(a: number): void {
    this.shake = Math.min(1, this.shake + a);
  }

  private applyShake(dt: number): void {
    const cam = this.world.camera;
    if (this.shake > 0.001) {
      const s = this.shake * this.shake * 0.35;
      cam.position.x += (Math.random() - 0.5) * s;
      cam.position.y += (Math.random() - 0.5) * s;
      cam.position.z += (Math.random() - 0.5) * s;
      this.shake = Math.max(0, this.shake - dt * 2.2);
    }
  }

  private place(pivot: THREE.Vector3, want: THREE.Vector3, look: THREE.Vector3, dt: number, fov: number): void {
    const w = this.world;
    const cam = w.camera;
    const dx = want.x - pivot.x, dy = want.y - pivot.y, dz = want.z - pivot.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const hit = w.colliders.raycast(pivot.x, pivot.y, pivot.z, dx / len, dy / len, dz / len, len, CAM_IGNORE);
    const allowed = hit ? Math.max(0.3, hit.t - 0.35) : len;
    // Pull in instantly, ease back out.
    this.camDist = allowed < this.camDist ? allowed : damp(this.camDist, allowed, 4, dt);
    cam.position.set(pivot.x + (dx / len) * this.camDist, pivot.y + (dy / len) * this.camDist, pivot.z + (dz / len) * this.camDist);
    if (cam.position.y < 0.3) cam.position.y = 0.3;
    cam.lookAt(look);
    this.applyShake(dt);
    this.fov = damp(this.fov, fov, 8, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }

  private footCamera(dt: number, sprint = false): void {
    const aim = this.aiming ? 1 : 0;
    const shoulder = 0.7 + aim * 0.15;
    const back = 3.6 - aim * 1.5 + (sprint ? 0.35 : 0);
    const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
    const fx = Math.sin(this.camYaw) * cp, fy = sp, fz = Math.cos(this.camYaw) * cp;
    const rx = -Math.cos(this.camYaw), rz = Math.sin(this.camYaw);
    const bob = sprint && this.grounded ? Math.sin(this.world.time * 16) * 0.035 : 0;
    this.pivot.set(this.pos.x + rx * shoulder, this.pos.y + 1.62 + bob, this.pos.z + rz * shoulder);
    const want = this.v.set(this.pivot.x - fx * back, this.pivot.y - fy * back + 0.2, this.pivot.z - fz * back);
    const look = new THREE.Vector3(this.pivot.x + fx * 30, this.pivot.y + fy * 30, this.pivot.z + fz * 30);
    // Start the ray from the character's head so walls between camera and shoulder count.
    const head = new THREE.Vector3(this.pos.x, this.pos.y + 1.62, this.pos.z);
    const toPivot = this.pivot.clone().sub(head);
    const sideHit = this.world.colliders.raycast(head.x, head.y, head.z, toPivot.x / (toPivot.length() || 1), 0, toPivot.z / (toPivot.length() || 1), shoulder, CAM_IGNORE);
    if (sideHit) this.pivot.copy(head).addScaledVector(toPivot.normalize(), Math.max(0, sideHit.t - 0.3));
    this.place(this.pivot, want.set(this.pivot.x - fx * back, this.pivot.y - fy * back + 0.2, this.pivot.z - fz * back), look, dt, this.aiming ? 52 : sprint ? 78 : this.rollT >= 0 ? 76 : 70);
  }

  private carCamera(dt: number, pos: THREE.Vector3, heading: number, speedSigned: number, extraDist: number, pivotY: number): void {
    this.carOrbitIdle += dt;
    // Mouse orbits; after a moment the camera swings back behind the vehicle.
    if (this.carOrbitIdle > 1.4 && !this.heli) this.camYaw = dampAngle(this.camYaw, heading + (speedSigned < -1 ? Math.PI : 0), 3, dt);
    this.carCamYaw = this.camYaw;
    const speed = Math.abs(speedSigned);
    const dist = 7.6 + speed * 0.06 + extraDist;
    const pitch = clamp(this.camPitch, -0.6, 0.35) - (this.heli ? 0.25 : 0.1);
    const cp = Math.cos(pitch);
    const fx = Math.sin(this.camYaw) * cp, fy = Math.sin(pitch), fz = Math.cos(this.camYaw) * cp;
    this.pivot.set(pos.x, pos.y + pivotY, pos.z);
    const want = this.v.set(this.pivot.x - fx * dist, this.pivot.y - fy * dist + 1.0, this.pivot.z - fz * dist);
    const look = new THREE.Vector3(this.pivot.x + fx * 20, this.pivot.y + 0.4 + fy * 20, this.pivot.z + fz * 20);
    this.place(this.pivot, want, look, dt, 72 + clamp(speed / 40, 0, 1) * 14);
  }

  private trainCamera(dt: number, heading: number): void {
    // Orbit freely with the mouse; side-on view by default.
    const yaw = this.camYaw;
    const pitch = clamp(this.camPitch, -0.5, 0.3) - 0.15;
    const dist = 16;
    this.pivot.set(this.pos.x, this.pos.y + 1, this.pos.z);
    const want = this.v.set(this.pivot.x - Math.sin(yaw) * Math.cos(pitch) * dist, this.pivot.y - Math.sin(pitch) * dist + 2, this.pivot.z - Math.cos(yaw) * Math.cos(pitch) * dist);
    void heading;
    this.place(this.pivot, want, this.pivot.clone(), dt, 70);
  }

  private deathCamera(dt: number): void {
    this.camYaw += dt * 0.35;
    this.pivot.set(this.pos.x, this.pos.y + 0.8, this.pos.z);
    const d = 4 + Math.min(this.deathT, 3) * 1.5;
    const want = this.v.set(this.pivot.x - Math.sin(this.camYaw) * d, this.pivot.y + 2 + this.deathT, this.pivot.z - Math.cos(this.camYaw) * d);
    this.place(this.pivot, want, this.pivot.clone(), dt, 65);
  }

  /** Cinematic camera used by the intro swoop; t goes 0 -> 1. */
  introCamera(t: number): void {
    const cam = this.world.camera;
    const e = 1 - Math.pow(1 - t, 3);
    const fx = Math.sin(this.camYaw), fz = Math.cos(this.camYaw);
    const end = new THREE.Vector3(this.pos.x - fx * 3.6 - Math.cos(this.camYaw) * 0.7, 2.0, this.pos.z - fz * 3.6 + Math.sin(this.camYaw) * 0.7);
    const start = new THREE.Vector3(this.pos.x - fx * 40, 70, this.pos.z - fz * 40);
    cam.position.lerpVectors(start, end, e);
    const look = new THREE.Vector3(this.pos.x + fx * 30 * e, 1.6 + (1 - e) * -1, this.pos.z + fz * 30 * e);
    cam.lookAt(look);
    if (cam.fov !== 70) { cam.fov = 70; cam.updateProjectionMatrix(); }
    this.rig.root.position.copy(this.pos);
    this.rig.root.rotation.y = this.yaw;
    this.rig.update(1 / 60, { speed: 0, grounded: true, aim: 0, pitch: 0, recoil: 0, hack: false, dead: false, hurt: 0, weapon: this.weapon });
  }

  /** Sound pan helper for things the player does. */
  pan(x: number, z: number): number {
    return panFor(this.world, x, z).pan;
  }
}
