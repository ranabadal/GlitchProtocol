import * as THREE from "three";
import { HALF } from "@/lib/shared/city";
import type { Box } from "../Colliders";
import type { Input } from "../Input";
import { clamp, damp, dampAngle, wrapAngle } from "../mathx";
import type { Fences } from "../world/MissionProps";
import { panFor, type PlayerLike, type World } from "../World";
import { OperatorRig } from "./Humanoid";
import type { Robots } from "./Robots";
import type { Car, Vehicles } from "./Vehicles";

/*
 * The operator. WASD to move, mouse to look, left click to fire the blaster (it heats
 * up: let it cool), right click to aim, Shift to sprint, Space to jump, Q for an EMP
 * blast, F to get in or out of a car. The camera sits over the right shoulder on foot
 * and behind the car when driving, and never goes through walls.
 */

const RADIUS = 0.42;
const HEIGHT = 1.8;
const CAM_IGNORE: ReadonlySet<Box["kind"]> = new Set(["prop", "fence", "barricade"]);
const SHOT_IGNORE: ReadonlySet<Box["kind"]> = new Set(["fence"]);
export const EMP_COOLDOWN = 18;
export const EMP_RADIUS = 15;
const FIRE_EVERY = 0.11;
const SHOT_DAMAGE = 22;

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
  rig: OperatorRig;
  glow: THREE.Color;
  /** Called once when health hits zero. */
  onDeath: (() => void) | null = null;
  onKillShot: ((robotId: string) => void) | null = null;
  private zapAt = -99;
  private camDist = 3.6;
  private carOrbit = 0;
  private carOrbitIdle = 0;
  private carCamYaw = 0;
  private shake = 0;
  private fov = 70;
  private v = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private pivot = new THREE.Vector3();
  private noiseAt = -99;
  private deathT = 0;
  carEnteredAt = -99;

  /** Laser fences the blaster can hit (set by the game once the mission is built). */
  fences: Fences | null = null;

  constructor(private world: World, private vehicles: Vehicles, private robots: Robots, hue: number) {
    this.rig = new OperatorRig(hue);
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
    this.heat = 0;
    this.overheated = false;
    this.shielded = true;
    this.shieldUntil = this.world.time + 3;
    this.rig.root.visible = true;
    this.deathT = 0;
  }

  aimPoint(out: THREE.Vector3): THREE.Vector3 {
    if (this.car) return out.set(this.car.pos.x, 1.0, this.car.pos.z);
    return out.set(this.pos.x, this.pos.y + 1.25, this.pos.z);
  }

  /** Test-only invulnerability (debug builds). */
  god = false;

  takeDamage(amount: number, from: THREE.Vector3): void {
    if (!this.alive || this.shielded || this.god) return;
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
    // Health regenerates after a few quiet seconds.
    if (this.alive && w.time - this.lastHurtAt > 3.5) this.health = Math.min(100, this.health + dt * 12);

    const sens = (this.aiming ? 0.0013 : 0.0022);
    if (controls && !this.frozen) {
      this.camYaw -= input.mouseDX * sens;
      this.camPitch = clamp(this.camPitch - input.mouseDY * sens, -1.1, 0.75);
      if (this.car && (input.mouseDX !== 0 || input.mouseDY !== 0)) this.carOrbitIdle = 0;
    }

    if (!this.alive) {
      this.deathT += dt;
      this.rig.update(dt, { speed: 0, grounded: true, aim: 0, pitch: 0, recoil: 0, hack: false, dead: true, hurt: 0 });
      this.deathCamera(dt);
      return;
    }

    if (this.car) this.driving(dt, input, controls);
    else this.onFoot(dt, input, controls);

    // Heat cools when not firing.
    if (!(controls && input.fire) || this.overheated || this.car) {
      this.heat = Math.max(0, this.heat - dt * (this.overheated ? 0.42 : 0.65));
      if (this.overheated && this.heat < 0.25) this.overheated = false;
    }
  }

  private onFoot(dt: number, input: Input, controls: boolean): void {
    const w = this.world;
    const c = controls && !this.frozen;
    const fwdIn = c ? input.axis(["KeyS", "ArrowDown"], ["KeyW", "ArrowUp"]) : 0;
    const sideIn = c ? input.axis(["KeyA", "ArrowLeft"], ["KeyD", "ArrowRight"]) : 0;
    this.aiming = c && input.aim;
    const sprint = c && input.down("ShiftLeft") && !this.aiming && fwdIn > 0;
    const fx = Math.sin(this.camYaw), fz = Math.cos(this.camYaw);
    const rx = -fz, rz = fx;
    let mx = fx * fwdIn + rx * sideIn, mz = fz * fwdIn + rz * sideIn;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    const speed = this.aiming ? 3.6 : sprint ? 9.5 : 6.2;
    const rate = this.grounded ? 14 : 3;
    this.vel.x = damp(this.vel.x, mx * speed, rate, dt);
    this.vel.z = damp(this.vel.z, mz * speed, rate, dt);
    if (c && input.hit("Space") && this.grounded) { this.vel.y = 7.4; this.grounded = false; }
    this.vel.y -= 21 * dt;
    this.pos.addScaledVector(this.vel, dt);
    if (this.pos.y <= 0) { this.pos.y = 0; this.vel.y = 0; this.grounded = true; }

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
    this.pos.x = clamp(this.pos.x, -HALF + 1, HALF - 1);
    this.pos.z = clamp(this.pos.z, -HALF + 1, HALF - 1);

    // Facing: toward the camera while aiming/firing, else toward movement.
    const firing = c && input.fire;
    if (this.aiming || firing || this.world.time - this.lastShotAt < 0.6) {
      this.yaw = dampAngle(this.yaw, this.camYaw, 18, dt);
      this.aimBlend = Math.min(1, this.aimBlend + dt * 8);
    } else {
      this.aimBlend = Math.max(0, this.aimBlend - dt * 4);
      if (ml > 0.1) this.yaw = dampAngle(this.yaw, Math.atan2(mx, mz), 12, dt);
    }

    if (c && input.fire) this.tryFire();
    if (c && input.hit("KeyQ")) this.emp();
    if (c && input.hit("KeyF")) this.tryEnterCar();

    const hspeed = Math.hypot(this.vel.x, this.vel.z);
    this.rig.root.position.copy(this.pos);
    this.rig.root.rotation.y = this.yaw;
    this.rig.root.visible = true;
    this.rig.update(dt, { speed: hspeed, grounded: this.grounded, aim: this.hacking ? 0 : this.aimBlend, pitch: this.camPitch, recoil: this.recoil, hack: this.hacking, dead: false, hurt: this.hurt });
    this.footCamera(dt);
  }

  private lastShotAt = -99;

  private tryFire(): void {
    const w = this.world;
    if (this.overheated || this.fireCd > 0 || this.frozen) return;
    this.fireCd = FIRE_EVERY;
    this.lastShotAt = w.time;
    this.heat = Math.min(1, this.heat + 0.065);
    if (this.heat >= 1) { this.overheated = true; w.sound.overheat(); }
    this.recoil = 1;
    const cam = w.camera;
    const o = cam.position.clone();
    const d = cam.getWorldDirection(this.dir).clone();
    const minT = o.distanceTo(this.pivot) * 0.9;
    const maxT = 170;
    // Gentle aim assist toward a robot right next to the crosshair.
    if (!this.robots.hitScan(o, d, maxT)) {
      const a = this.robots.assist(o, d, maxT, this.aiming ? 0.02 : 0.035);
      if (a) d.copy(a.centre(this.v)).sub(o).normalize();
    }
    const rh = this.robots.hitScan(o, d, maxT);
    const fh = this.fences?.hitScan(o, d, maxT) ?? null;
    const wh = w.colliders.raycast(o.x, o.y, o.z, d.x, d.y, d.z, maxT, SHOT_IGNORE);
    let t = maxT;
    let kind: "robot" | "pylon" | "world" | "none" = "none";
    if (wh && wh.t > minT) { t = wh.t; kind = "world"; }
    if (rh && rh.t > minT && rh.t < t) { t = rh.t; kind = "robot"; }
    if (fh && fh.t > minT && fh.t < t) { t = fh.t; kind = "pylon"; }
    const hit = o.clone().addScaledVector(d, t);
    const muzzle = this.rig.muzzle.getWorldPosition(new THREE.Vector3());
    w.fx.tracer(muzzle, hit, this.glow, 0.07, 0.08);
    w.fx.muzzle(muzzle, this.glow);
    w.sound.blaster();
    if (kind === "robot" && rh) {
      const killed = this.robots.damage(rh.robot, SHOT_DAMAGE, hit, "gun");
      this.hitMarkerAt = w.time;
      w.sound.hitMarker();
      if (killed) this.onKillShot?.(rh.robot.id);
    } else if (kind === "pylon" && fh && this.fences) {
      this.fences.damage(fh.fence, fh.pylon, 30);
      this.hitMarkerAt = w.time;
      w.fx.sparks(hit, null, new THREE.Color(1, 0.3, 0.3), 10, 8);
      w.sound.hitMarker();
    } else if (kind === "world" && wh) {
      w.fx.sparks(hit, new THREE.Vector3(wh.nx, wh.ny, wh.nz), this.glow, 6, 6);
      if (Math.random() < 0.3) w.sound.ricochet();
    }
    if (w.time - this.noiseAt > 0.5) { this.noiseAt = w.time; w.noise(this.pos.x, this.pos.z, 45, "gunfire"); }
  }

  emp(): boolean {
    const w = this.world;
    if (this.empCd > 0 || this.frozen || !this.alive) return false;
    this.empCd = EMP_COOLDOWN;
    const c = this.aimPoint(this.v).clone();
    const n = this.robots.emp(c, EMP_RADIUS);
    w.fx.ring(c.clone().setY(0.6), EMP_RADIUS, new THREE.Color(0.3, 0.9, 1), 0.7);
    w.fx.ring(c.clone().setY(1.6), EMP_RADIUS * 0.7, new THREE.Color(0.6, 0.95, 1), 0.5);
    w.fx.sparks(c, null, new THREE.Color(0.4, 0.9, 1), 40, 14);
    w.sound.emp();
    w.shake(0.4);
    w.noise(c.x, c.z, 40, "explosion");
    return n > 0;
  }

  private tryEnterCar(): void {
    const car = this.vehicles.nearestEnterable(this.pos, 3.0);
    if (!car) return;
    this.vehicles.takeControl(car);
    this.car = car;
    this.carEnteredAt = this.world.time;
    this.carOrbit = 0;
    this.carCamYaw = car.heading;
    car.onDamage = (amount, from) => {
      this.lastDamageAt = this.world.time;
      this.damageDir = wrapAngle(Math.atan2(from.x - car.pos.x, from.z - car.pos.z) - this.camYaw);
      this.world.shake(Math.min(0.3, amount / 40));
    };
    this.rig.root.visible = false;
    this.world.sound.door();
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
    this.vehicles.drive(car, { throttle, brake, steer, handbrake: c && input.down("Space"), boost: c && input.down("ShiftLeft") }, dt);
    this.world.sound.setEngine(true, clamp(Math.abs(car.speed) / car.v.maxSpeed, 0, 1), throttle);
    if (c && input.hit("KeyH")) this.world.sound.horn();
    if (c && input.hit("KeyQ")) this.emp();
    this.pos.set(car.pos.x, 0, car.pos.z);
    this.vel.copy(car.vel);
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

  /** Chase camera runs after the car physics step, so it never lags a frame behind. */
  postUpdate(dt: number): void {
    if (this.alive && this.car) this.carCamera(dt, this.car);
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

  private footCamera(dt: number): void {
    const aim = this.aiming ? 1 : 0;
    const shoulder = 0.7 + aim * 0.15;
    const back = 3.6 - aim * 1.5;
    const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
    const fx = Math.sin(this.camYaw) * cp, fy = sp, fz = Math.cos(this.camYaw) * cp;
    const rx = -Math.cos(this.camYaw), rz = Math.sin(this.camYaw);
    this.pivot.set(this.pos.x + rx * shoulder, this.pos.y + 1.62, this.pos.z + rz * shoulder);
    const want = this.v.set(this.pivot.x - fx * back, this.pivot.y - fy * back + 0.2, this.pivot.z - fz * back);
    const look = new THREE.Vector3(this.pivot.x + fx * 30, this.pivot.y + fy * 30, this.pivot.z + fz * 30);
    // Start the ray from the character's head so walls between camera and shoulder count.
    const head = new THREE.Vector3(this.pos.x, this.pos.y + 1.62, this.pos.z);
    const toPivot = this.pivot.clone().sub(head);
    const sideHit = this.world.colliders.raycast(head.x, head.y, head.z, toPivot.x / (toPivot.length() || 1), 0, toPivot.z / (toPivot.length() || 1), shoulder, CAM_IGNORE);
    if (sideHit) this.pivot.copy(head).addScaledVector(toPivot.normalize(), Math.max(0, sideHit.t - 0.3));
    this.place(this.pivot, want.set(this.pivot.x - fx * back, this.pivot.y - fy * back + 0.2, this.pivot.z - fz * back), look, dt, this.aiming ? 52 : 70);
  }

  private carCamera(dt: number, car: Car): void {
    this.carOrbitIdle += dt;
    // Mouse orbits; after a moment the camera swings back behind the car.
    if (this.carOrbitIdle > 1.4) this.camYaw = dampAngle(this.camYaw, car.heading + (car.speed < -1 ? Math.PI : 0), 3, dt);
    this.carCamYaw = this.camYaw;
    const speed = Math.abs(car.speed);
    const dist = 7.6 + speed * 0.06 + (car.variant === 2 ? 1.5 : 0);
    const pitch = clamp(this.camPitch, -0.6, 0.35) - 0.1;
    const cp = Math.cos(pitch);
    const fx = Math.sin(this.camYaw) * cp, fy = Math.sin(pitch), fz = Math.cos(this.camYaw) * cp;
    this.pivot.set(car.pos.x, 1.7 + (car.variant === 2 ? 0.8 : 0), car.pos.z);
    const want = this.v.set(this.pivot.x - fx * dist, this.pivot.y - fy * dist + 1.0, this.pivot.z - fz * dist);
    const look = new THREE.Vector3(this.pivot.x + fx * 20, this.pivot.y + 0.4 + fy * 20, this.pivot.z + fz * 20);
    this.place(this.pivot, want, look, dt, 72 + clamp(speed / 40, 0, 1) * 14);
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
    this.rig.update(1 / 60, { speed: 0, grounded: true, aim: 0, pitch: 0, recoil: 0, hack: false, dead: false, hurt: 0 });
  }

  /** Sound pan helper for things the player does. */
  pan(x: number, z: number): number {
    return panFor(this.world, x, z).pan;
  }
}
