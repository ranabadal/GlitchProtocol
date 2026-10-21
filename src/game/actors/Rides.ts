import * as THREE from "three";
import { blockCenter, roadPos, PITCH, ROAD } from "@/lib/shared/city";
import type { Colliders } from "../Colliders";
import { clamp, damp, dampAngle } from "../mathx";
import type { World } from "../World";

/*
 * Ways to get around besides cars:
 *   Helicopter - two "Sky Hopper" choppers parked on helipads in plazas. F to board,
 *                W/S forward/back, A/D sideways, Space up, Shift/C down, mouse steers.
 *                Left click fires the nose blaster. Land on the street and F to get out.
 *   Skyline Metro - an elevated train looping around the city on pillars, with four
 *                stations. Stand on a station's glowing pad and press F; press F again
 *                at another station to get off.
 * Both are slower than a sports car, so the server's travel-time checks stay valid.
 */

// ---------------------------------------------------------------- helicopter

export const HELI_MAX_SPEED = 30;
const HELI_MAX_ALT = 110;

export class Heli {
  group = new THREE.Group();
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  heading = 0;
  /** 0..1 rotor spin (spins up before it can lift). */
  spin = 0;
  occupied = false;
  ground = 0;
  private rotor = new THREE.Group();
  private tail = new THREE.Group();
  private tilt = new THREE.Group();
  readonly pad: THREE.Vector3;

  constructor(x: number, z: number, heading: number, color: THREE.Color, glow: THREE.Color) {
    this.pad = new THREE.Vector3(x, 0, z);
    this.pos.set(x, 0, z);
    this.heading = heading;
    const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1c2026, metalness: 0.7, roughness: 0.4 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0c1a24, metalness: 0.9, roughness: 0.08, emissive: 0x06202a });
    const neon = new THREE.MeshBasicMaterial({ color: glow.clone().multiplyScalar(2.2), toneMapped: false });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.15, 2.6, 6, 14).rotateX(Math.PI / 2).scale(1, 0.95, 1), paint);
    body.position.y = 1.55;
    const cockpit = new THREE.Mesh(new THREE.SphereGeometry(1.08, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55).rotateX(Math.PI * 0.42), glass);
    cockpit.position.set(0, 1.75, 1.35);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.42, 4.6, 10).rotateX(Math.PI / 2), paint);
    boom.position.set(0, 1.9, -3.7);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.3, 0.9), paint);
    fin.position.set(0, 2.5, -5.8);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.36, 0.08, 3.2), neon);
    stripe.position.set(0, 1.25, 0);
    this.tilt.add(body, cockpit, boom, fin, stripe);
    for (const sx of [-1, 1]) {
      const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.8, 6).rotateX(Math.PI / 2), dark);
      skid.position.set(sx * 1.05, 0.12, 0.2);
      const strut1 = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.7, 0.08), dark);
      strut1.position.set(sx * 0.95, 0.5, 1.0);
      const strut2 = strut1.clone();
      strut2.position.z = -0.6;
      this.tilt.add(skid, strut1, strut2);
    }
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.6, 8), dark);
    mast.position.y = 2.75;
    this.tilt.add(mast);
    for (let i = 0; i < 4; i++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.05, 5.4).translate(0, 0, 2.7), dark);
      blade.rotation.y = (i * Math.PI) / 2;
      this.rotor.add(blade);
    }
    const disc = new THREE.Mesh(new THREE.CircleGeometry(5.4, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x9ab, transparent: true, opacity: 0, depthWrite: false }));
    this.rotor.add(disc);
    this.rotor.position.y = 3.05;
    this.tilt.add(this.rotor);
    for (let i = 0; i < 2; i++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.3, 0.14), dark);
      b.rotation.x = i * Math.PI / 2;
      this.tail.add(b);
    }
    this.tail.position.set(0.18, 2.55, -5.9);
    this.tilt.add(this.tail);
    this.group.add(this.tilt);
    this.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    this.sync(0);
  }

  get speed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  /** Muzzle of the nose gun in world space. */
  nose(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos.x + Math.sin(this.heading) * 2.6, this.pos.y + 0.9, this.pos.z + Math.cos(this.heading) * 2.6);
  }

  fly(dt: number, c: { fwd: number; side: number; up: number; yawTo: number; on: boolean }, colliders: Colliders): void {
    this.spin = damp(this.spin, c.on ? 1 : 0, c.on ? 1.4 : 0.5, dt);
    const ready = this.spin > 0.85;
    // Turn toward where the camera looks, faster when moving.
    if (c.on) this.heading = dampAngle(this.heading, c.yawTo, 1.6 + this.speed * 0.05, dt);
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const rx = -fz, rz = fx;
    const ax = ready ? (fx * c.fwd + rx * c.side) * HELI_MAX_SPEED : 0;
    const az = ready ? (fz * c.fwd + rz * c.side) * HELI_MAX_SPEED : 0;
    this.vel.x = damp(this.vel.x, ax, 1.1, dt);
    this.vel.z = damp(this.vel.z, az, 1.1, dt);
    const vy = ready ? c.up * 9 : -4;
    this.vel.y = damp(this.vel.y, vy, 2.5, dt);
    // Gentle hover bob.
    if (ready && this.pos.y > this.ground + 0.5 && Math.abs(c.up) < 0.1) this.vel.y += Math.sin(performance.now() / 600) * 0.15;
    const sp = this.speed;
    if (sp > HELI_MAX_SPEED) { this.vel.x *= HELI_MAX_SPEED / sp; this.vel.z *= HELI_MAX_SPEED / sp; }
    this.pos.addScaledVector(this.vel, dt);
    // Buildings: push out sideways, and treat roofs as ground.
    const res = colliders.resolveCircle(this.pos.x, this.pos.z, 2.4, this.pos.y + 0.3, 2.6);
    if (res.hit) {
      this.pos.x = res.x;
      this.pos.z = res.z;
      this.vel.x *= 0.3;
      this.vel.z *= 0.3;
    }
    this.ground = 0;
    for (const b of colliders.query(this.pos.x - 1, this.pos.z - 1, this.pos.x + 1, this.pos.z + 1)) {
      if (!b.enabled || b.kind === "fence") continue;
      if (this.pos.x > b.minX && this.pos.x < b.maxX && this.pos.z > b.minZ && this.pos.z < b.maxZ && b.maxY <= this.pos.y + 1.5) this.ground = Math.max(this.ground, b.maxY);
    }
    if (this.pos.y < this.ground) { this.pos.y = this.ground; this.vel.y = Math.max(0, this.vel.y); this.vel.x *= 0.9; this.vel.z *= 0.9; }
    this.pos.y = Math.min(this.pos.y, HELI_MAX_ALT);
    this.sync(dt, c.fwd, c.side);
  }

  /** Parked: settle on the ground and wind the rotor down. */
  idle(dt: number): void {
    this.spin = damp(this.spin, 0, 0.5, dt);
    if (this.pos.y > this.ground) { this.pos.y = Math.max(this.ground, this.pos.y - dt * 6); }
    this.vel.multiplyScalar(Math.max(0, 1 - dt * 2));
    this.sync(dt);
  }

  private sync(dt: number, fwd = 0, side = 0): void {
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.heading;
    this.tilt.rotation.x = damp(this.tilt.rotation.x, fwd * 0.22, 3, dt || 1);
    this.tilt.rotation.z = damp(this.tilt.rotation.z, -side * 0.2, 3, dt || 1);
    this.rotor.rotation.y += dt * this.spin * 40;
    this.tail.rotation.x += dt * this.spin * 60;
    const disc = this.rotor.children[this.rotor.children.length - 1] as THREE.Mesh;
    (disc.material as THREE.MeshBasicMaterial).opacity = this.spin * 0.12;
  }
}

// ---------------------------------------------------------------- metro

const TRACK_Y = 10.5;
const TRAIN_SPEED = 24;
const DWELL = 5;
const CARS = 3;
const CAR_LEN = 11;

export interface Station { id: number; name: string; s: number; track: THREE.Vector3; pad: THREE.Vector3 }

export class Metro {
  group = new THREE.Group();
  stations: Station[] = [];
  trains: { group: THREE.Group; cars: THREE.Group[]; offset: number }[] = [];
  private corners: THREE.Vector2[];
  private length: number;
  private sideLen: number;
  private padMats: THREE.MeshBasicMaterial[] = [];

  constructor(colliders: Colliders, uTime: { value: number }) {
    void uTime;
    const a = roadPos(1), b = roadPos(6);
    this.corners = [new THREE.Vector2(a, a), new THREE.Vector2(b, a), new THREE.Vector2(b, b), new THREE.Vector2(a, b)];
    this.sideLen = b - a;
    this.length = this.sideLen * 4;

    // Track beam and pillars along the four sides.
    const beamMat = new THREE.MeshStandardMaterial({ color: 0x8b9199, metalness: 0.4, roughness: 0.55 });
    const railMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 2.2, 1.6), toneMapped: false });
    for (let i = 0; i < 4; i++) {
      const p0 = this.corners[i], p1 = this.corners[(i + 1) % 4];
      const mid = p0.clone().add(p1).multiplyScalar(0.5);
      const horiz = Math.abs(p1.x - p0.x) > 1;
      const len = this.sideLen + 3;
      const beam = new THREE.Mesh(new THREE.BoxGeometry(horiz ? len : 3.2, 1.0, horiz ? 3.2 : len), beamMat);
      beam.position.set(mid.x, TRACK_Y - 0.5, mid.y);
      beam.castShadow = true;
      beam.receiveShadow = true;
      const rail = new THREE.Mesh(new THREE.BoxGeometry(horiz ? len : 0.12, 0.08, horiz ? 0.12 : len), railMat);
      rail.position.set(mid.x, TRACK_Y + 0.02, mid.y);
      this.group.add(beam, rail);
      // Pillars in the road's centre median, away from junctions and mid-road barricades.
      const n = Math.round(this.sideLen / PITCH);
      for (let k = 0; k < n; k++) for (const t of [0.28, 0.72]) {
        const f = (k + t) / n;
        const x = p0.x + (p1.x - p0.x) * f, z = p0.y + (p1.y - p0.y) * f;
        const pillar = new THREE.Mesh(new THREE.BoxGeometry(1.1, TRACK_Y - 1, 1.1), beamMat);
        pillar.position.set(x, (TRACK_Y - 1) / 2, z);
        pillar.castShadow = true;
        this.group.add(pillar);
        colliders.addRect(x, z, 1.1, 1.1, TRACK_Y - 1, "prop");
      }
    }

    // Stations: one per side, platform up top and a glowing boarding pad on the sidewalk below.
    const names = ["Neon Central", "Quantum Gate", "Pixel Bazaar", "Byte Junction"];
    for (let i = 0; i < 4; i++) {
      const p0 = this.corners[i], p1 = this.corners[(i + 1) % 4];
      // 56% along the side: between a junction and the mid-road barricade spot.
      const f = 0.56;
      const tx = p0.x + (p1.x - p0.x) * f, tz = p0.y + (p1.y - p0.y) * f;
      const dirx = Math.sign(p1.x - p0.x), dirz = Math.sign(p1.y - p0.y);
      // Outward normal (away from the loop's centre) for the pad on the sidewalk.
      const cx = (a + b) / 2;
      const nx = dirz !== 0 ? Math.sign(tx - cx) : 0, nz = dirx !== 0 ? Math.sign(tz - cx) : 0;
      const pad = new THREE.Vector3(tx + nx * (ROAD / 2 + 2), 0, tz + nz * (ROAD / 2 + 2));
      const st: Station = { id: i, name: names[i], s: i * this.sideLen + f * this.sideLen, track: new THREE.Vector3(tx, TRACK_Y, tz), pad };
      this.stations.push(st);
      const plat = new THREE.Mesh(new THREE.BoxGeometry(dirx ? 34 : 5, 0.5, dirx ? 5 : 34), beamMat);
      plat.position.set(tx + nx * 3.6, TRACK_Y - 0.6, tz + nz * 3.6);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(dirx ? 34 : 6, 0.3, dirx ? 6 : 34), new THREE.MeshStandardMaterial({ color: 0xdadfe4, metalness: 0.3, roughness: 0.4 }));
      roof.position.set(tx + nx * 3.2, TRACK_Y + 4.6, tz + nz * 3.2);
      const sign = new THREE.Mesh(new THREE.BoxGeometry(dirx ? 10 : 0.2, 1.2, dirx ? 0.2 : 10), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 1.6, 2.4), toneMapped: false }));
      sign.position.set(tx + nx * 6.2, TRACK_Y + 3.6, tz + nz * 6.2);
      const lift = new THREE.Mesh(new THREE.BoxGeometry(2.4, TRACK_Y, 2.4), new THREE.MeshStandardMaterial({ color: 0x2a3138, metalness: 0.6, roughness: 0.3, emissive: 0x0b2a33 }));
      lift.position.set(pad.x + nx * 2.6, TRACK_Y / 2, pad.z + nz * 2.6);
      const padMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 1.4, 2.2), transparent: true, opacity: 0.8, toneMapped: false, depthWrite: false });
      this.padMats.push(padMat);
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.1, 32).rotateX(-Math.PI / 2), padMat);
      ring.position.set(pad.x, 0.06, pad.z);
      const mark = new THREE.Mesh(new THREE.CircleGeometry(0.9, 6).rotateX(-Math.PI / 2), padMat);
      mark.position.set(pad.x, 0.05, pad.z);
      this.group.add(plat, roof, sign, lift, ring, mark);
    }

    // Two trains, half a lap apart.
    const body = new THREE.MeshStandardMaterial({ color: 0xe9edf1, metalness: 0.35, roughness: 0.3 });
    const win = new THREE.MeshStandardMaterial({ color: 0x0f1c26, metalness: 0.9, roughness: 0.1, emissive: 0x0d2633 });
    const stripe = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 2.0, 1.4), toneMapped: false });
    for (let k = 0; k < 2; k++) {
      const g = new THREE.Group();
      const cars: THREE.Group[] = [];
      for (let c = 0; c < CARS; c++) {
        const car = new THREE.Group();
        const shell = new THREE.Mesh(new THREE.CapsuleGeometry(1.35, CAR_LEN - 2.8, 4, 12).rotateX(Math.PI / 2).scale(1, 1.05, 1), body);
        shell.position.y = 1.5;
        const glass = new THREE.Mesh(new THREE.BoxGeometry(2.76, 0.7, CAR_LEN - 3), win);
        glass.position.y = 1.85;
        const band = new THREE.Mesh(new THREE.BoxGeometry(2.78, 0.12, CAR_LEN - 2.4), stripe);
        band.position.y = 1.2;
        car.add(shell, glass, band);
        car.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
        g.add(car);
        cars.push(car);
      }
      this.group.add(g);
      this.trains.push({ group: g, cars, offset: k * 0.5 });
    }
  }

  /** Lap time including the stops. */
  private get lap(): number {
    return 4 * (this.sideLen / TRAIN_SPEED + DWELL);
  }

  /** Distance along the loop of train k at time t, and whether it is standing at a station. */
  trainS(k: number, t: number): { s: number; docked: number | null; speed: number } {
    const lap = this.lap;
    const seg = this.sideLen / TRAIN_SPEED;
    let u = ((t / lap + this.trains[k].offset) % 1 + 1) % 1 * lap;
    const leg = Math.floor(u / (seg + DWELL));
    u -= leg * (seg + DWELL);
    const st = this.stations[leg % 4];
    if (u < DWELL) return { s: st.s, docked: st.id, speed: 0 };
    const f = (u - DWELL) / seg;
    const e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2; // ease in and out
    const speed = (f < 0.5 ? 4 * f : 4 * (1 - f)) * (this.sideLen / seg);
    return { s: (st.s + e * this.sideLen) % this.length, docked: null, speed };
  }

  /** Point and heading on the loop at distance s. */
  at(s: number, out: THREE.Vector3): number {
    const L = this.length;
    let d = ((s % L) + L) % L;
    const side = Math.min(3, Math.floor(d / this.sideLen));
    d -= side * this.sideLen;
    const p0 = this.corners[side], p1 = this.corners[(side + 1) % 4];
    const f = d / this.sideLen;
    out.set(p0.x + (p1.x - p0.x) * f, TRACK_Y, p0.y + (p1.y - p0.y) * f);
    return Math.atan2(p1.x - p0.x, p1.y - p0.y);
  }

  stationNear(p: THREE.Vector3, r = 3): Station | null {
    for (const st of this.stations) if (Math.hypot(p.x - st.pad.x, p.z - st.pad.z) < r) return st;
    return null;
  }

  /** Seconds until a train next stands at this station (0 if one is there now), and which. */
  nextAt(st: Station, t: number): { wait: number; train: number } {
    let best = { wait: Infinity, train: 0 };
    for (let k = 0; k < this.trains.length; k++) {
      for (let dt = 0; dt < this.lap; dt += 0.5) {
        const r = this.trainS(k, t + dt);
        if (r.docked === st.id) { if (dt < best.wait) best = { wait: dt, train: k }; break; }
      }
    }
    return best;
  }

  update(t: number): void {
    const tmp = new THREE.Vector3();
    this.trains.forEach((tr, k) => {
      const { s } = this.trainS(k, t);
      tr.cars.forEach((car, c) => {
        const h = this.at(s - c * (CAR_LEN + 0.6), tmp);
        car.position.copy(tmp);
        car.rotation.y = h;
      });
    });
    for (const m of this.padMats) m.opacity = 0.55 + 0.3 * Math.sin(t * 3);
  }
}

/** Two helipads on plazas (north-east and south-west), clear of the uplink towers. */
export function helipads(): { x: number; z: number; heading: number }[] {
  return [
    { x: blockCenter(5) + 17, z: blockCenter(1) + 17, heading: Math.PI },
    { x: blockCenter(1) + 17, z: blockCenter(5) + 17, heading: 0 },
  ];
}

export { clamp };
