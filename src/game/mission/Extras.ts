import * as THREE from "three";
import { courierPos, type CourierPublic, type ShardPublic } from "@/lib/shared/mission";
import type { HitTarget } from "../actors/Player";
import type { HitBy, Robots } from "../actors/Robots";
import { dampAngle, rayCapsule } from "../mathx";
import { panFor, type World } from "../World";

/*
 * Mission extras on the client:
 *   DataTruck - NULL's armoured truck on its fixed loop (same maths as the server), with
 *               a roof gun. Shoot it, bomb it, ram it; when it blows up its core drops.
 *   Shards    - optional golden data crystals around the city.
 */

const LANE = 5;

export class DataTruck implements HitTarget {
  group = new THREE.Group();
  pos = new THREE.Vector3();
  heading = 0;
  hp: number;
  maxHp: number;
  alive = true;
  radius = 2.6;
  /** Where its core lies after it was destroyed (null while driving or once collected). */
  dropped: THREE.Vector3 | null = null;
  collected = false;
  onDestroyed: (() => void) | null = null;
  private body = new THREE.Group();
  private gun = new THREE.Group();
  private core: THREE.Mesh;
  private flash = 0;
  private flashMats: THREE.MeshStandardMaterial[] = [];
  private fireCd = 2;
  private smokeT = 0;
  private wheels: THREE.Mesh[] = [];
  private tmp = new THREE.Vector3();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private smoothHeading: number | null = null;

  constructor(public c: CourierPublic, private world: World, private robots: Robots, band: number) {
    void band;
    this.maxHp = this.hp = c.hp;
    const armour = new THREE.MeshStandardMaterial({ color: 0x23252b, metalness: 0.75, roughness: 0.35 });
    const plate = new THREE.MeshStandardMaterial({ color: 0x3a1238, metalness: 0.6, roughness: 0.4 });
    this.flashMats.push(armour, plate);
    const neon = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.25, 2.4), toneMapped: false });
    const glass = new THREE.MeshStandardMaterial({ color: 0x080b10, metalness: 0.9, roughness: 0.1, emissive: 0x2a0622 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(2.7, 2.6, 5.2), armour);
    box.position.set(0, 1.9, -0.9);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.9, 1.9), plate);
    cab.position.set(0, 1.55, 2.4);
    const wind = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.8, 0.1), glass);
    wind.position.set(0, 2.0, 3.36);
    const stripeL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 5), neon);
    stripeL.position.set(1.37, 1.4, -0.9);
    const stripeR = stripeL.clone();
    stripeR.position.x = -1.37;
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.5, 0.4), armour);
    bumper.position.set(0, 0.7, 3.45);
    const lights = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.06), neon);
    lights.position.set(0, 1.0, 3.66);
    this.body.add(box, cab, wind, stripeL, stripeR, bumper, lights);
    for (const [x, z] of [[1.25, 2.3], [-1.25, 2.3], [1.25, -1.2], [-1.25, -1.2], [1.25, -2.6], [-1.25, -2.6]]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.45, 14).rotateZ(Math.PI / 2), armour);
      w.position.set(x, 0.55, z);
      this.wheels.push(w);
      this.body.add(w);
    }
    // Roof gun.
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.7, 0.4, 10), armour);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.4, 8).rotateX(Math.PI / 2).translate(0, 0.15, 0.75), armour);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6).translate(0, 0.25, 0.3), neon);
    this.gun.add(base, barrel, eye);
    this.gun.position.set(0, 3.4, -1.2);
    this.body.add(this.gun);
    this.body.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    this.group.add(this.body);
    this.core = new THREE.Mesh(new THREE.OctahedronGeometry(0.45, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 2.8, 1.6), toneMapped: false }));
    this.core.visible = false;
    this.group.add(this.core);
    this.place(0);
  }

  centre(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos.x, 1.7, this.pos.z);
  }

  rayHit(o: THREE.Vector3, d: THREE.Vector3, maxT: number): number | null {
    if (!this.alive) return null;
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    this.a.set(this.pos.x - fx * 2.6, 1.7, this.pos.z - fz * 2.6);
    this.b.set(this.pos.x + fx * 2.8, 1.7, this.pos.z + fz * 2.8);
    return rayCapsule(o, d, this.a, this.b, 1.45, maxT);
  }

  hurt(amount: number, at: THREE.Vector3 | null, by: HitBy): void {
    if (!this.alive) return;
    const dmg = by === "blade" || by === "slap" ? amount * 0.5 : by === "emp" ? 30 : amount;
    this.hp -= dmg;
    this.flash = 1;
    if (at) this.world.fx.sparks(at, null, new THREE.Color(1, 0.6, 0.3), 6, 7);
    const c = this.centre(this.tmp).clone().setY(3.6);
    this.world.fx.number(c, Math.round(dmg), this.hp <= 0 ? "#ffd84a" : "#ff9ae6");
    if (this.hp <= 0) this.destroy();
  }

  private destroy(): void {
    const w = this.world;
    this.alive = false;
    this.hp = 0;
    const c = this.centre(this.tmp).clone();
    w.fx.explosion(c, 2.4, new THREE.Color(1, 0.3, 0.9));
    const sp = panFor(w, c.x, c.z);
    w.sound.bigBoom(Math.max(0.5, sp.vol), sp.pan);
    w.shake(0.7 * Math.max(0.4, sp.vol));
    w.noise(c.x, c.z, 60, "explosion");
    this.dropAt(this.pos.x, this.pos.z);
    this.body.rotation.z = 0.25;
    for (const m of this.flashMats) m.color.multiplyScalar(0.35);
    this.onDestroyed?.();
  }

  /** Wreck and core where it fell (also used to restore after a page refresh). */
  dropAt(x: number, z: number): void {
    this.alive = false;
    this.pos.set(x, 0, z);
    this.dropped = new THREE.Vector3(x + Math.sin(this.heading + Math.PI / 2) * 3.5, 0, z + Math.cos(this.heading + Math.PI / 2) * 3.5);
    this.core.visible = !this.collected;
    this.group.position.set(0, 0, 0);
    this.body.position.copy(this.pos);
  }

  collect(): void {
    this.collected = true;
    this.core.visible = false;
  }

  private place(sec: number): void {
    const p = courierPos(this.c, sec);
    this.smoothHeading = this.smoothHeading === null ? p.heading : dampAngle(this.smoothHeading, p.heading, 5, 1 / 60);
    const h = this.smoothHeading;
    // Drive in the left lane (traffic keeps left in Neon City).
    const lx = Math.cos(h), lz = -Math.sin(h);
    this.pos.set(p.x + lx * LANE, 0, p.z + lz * LANE);
    this.heading = h;
    this.body.position.copy(this.pos);
    this.body.rotation.y = h;
  }

  update(dt: number, missionSec: number, player: { pos: THREE.Vector3; alive: boolean; shielded: boolean } | null): void {
    const w = this.world;
    this.flash = Math.max(0, this.flash - dt * 6);
    for (const m of this.flashMats) m.emissive.setRGB(this.flash * 1.2, this.flash * 0.9, this.flash * 0.9);
    if (!this.alive) {
      this.smokeT -= dt;
      if (this.smokeT <= 0) { this.smokeT = 0.15; w.fx.smokePuff(this.pos.clone().setY(2.5), 0.08); }
      if (this.dropped && this.core.visible) {
        this.core.position.set(this.dropped.x, 1.2 + Math.sin(w.time * 3) * 0.2, this.dropped.z);
        this.core.rotation.y += dt * 2;
      }
      return;
    }
    this.place(missionSec);
    for (const wh of this.wheels) wh.rotation.x += dt * this.c.speed / 0.55;
    // Roof gun: aims and fires dodgeable bolts at a player within range.
    if (player && player.alive && !player.shielded) {
      const d = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
      const yawTo = Math.atan2(player.pos.x - this.pos.x, player.pos.z - this.pos.z) - this.heading;
      this.gun.rotation.y = dampAngle(this.gun.rotation.y, yawTo, 4, dt);
      this.fireCd -= dt;
      if (d < 38 && this.fireCd <= 0 && w.colliders.lineOfSight(this.pos.x, 3.6, this.pos.z, player.pos.x, player.pos.y + 1.2, player.pos.z)) {
        this.fireCd = 0.85 + Math.random() * 0.4;
        const from = this.gun.getWorldPosition(new THREE.Vector3()).setY(3.7);
        const to = player.pos.clone().setY(player.pos.y + 1.1);
        const dir = to.sub(from).normalize();
        dir.x += (Math.random() - 0.5) * 0.08;
        dir.z += (Math.random() - 0.5) * 0.08;
        this.robots.fireBolt(from, dir.normalize().multiplyScalar(32), 6, new THREE.Color(3, 0.3, 2.4), 1.1);
        const sp = panFor(w, from.x, from.z);
        w.sound.enemyShot(sp.pan, Math.max(0.15, sp.vol));
      }
      if (d < 30) w.sound.truckHorn();
    }
  }

  /** Ramming with the player's car: returns damage to the car (0 if not touching). */
  ram(carPos: THREE.Vector3, carVel: THREE.Vector3): number {
    if (!this.alive) return 0;
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    let touch = false;
    for (const k of [-2.4, 0, 2.6]) if (Math.hypot(carPos.x - (this.pos.x + fx * k), carPos.z - (this.pos.z + fz * k)) < 2.9) touch = true;
    if (!touch) return 0;
    const speed = carVel.length();
    // Push the car out of the truck.
    const dx = carPos.x - this.pos.x, dz = carPos.z - this.pos.z, d = Math.hypot(dx, dz) || 1;
    carPos.x += (dx / d) * 0.4;
    carPos.z += (dz / d) * 0.4;
    if (speed < 7) return 0;
    this.hurt(speed * 2.2, carPos.clone().setY(1.2), "car");
    this.world.sound.crash(1);
    this.world.shake(0.4);
    return 8 + speed * 0.3;
  }
}

export class Shards {
  group = new THREE.Group();
  items: { s: ShardPublic; mesh: THREE.Group; taken: boolean; busy: boolean }[] = [];

  constructor(list: ShardPublic[], taken: ReadonlySet<string>) {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.8, 2.0, 0.4), toneMapped: false });
    const beamMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 0.9, 0.2), transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    for (const s of list) {
      const g = new THREE.Group();
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.42, 0).scale(0.7, 1.2, 0.7), mat);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 14, 8, 1, true).translate(0, 7, 0), beamMat);
      g.add(gem, beam);
      g.position.set(s.x, 0, s.z);
      g.visible = !taken.has(s.id);
      this.group.add(g);
      this.items.push({ s, mesh: g, taken: taken.has(s.id), busy: false });
    }
  }

  /** The first shard close enough to collect, if any. */
  near(p: THREE.Vector3, r: number): (typeof this.items)[number] | null {
    for (const it of this.items) if (!it.taken && !it.busy && Math.hypot(p.x - it.s.x, p.z - it.s.z) < r) return it;
    return null;
  }

  get count(): { got: number; total: number } {
    return { got: this.items.filter((x) => x.taken).length, total: this.items.length };
  }

  update(t: number): void {
    for (const it of this.items) {
      if (!it.mesh.visible) continue;
      const gem = it.mesh.children[0];
      gem.position.y = 1.3 + Math.sin(t * 2.2 + it.s.x) * 0.2;
      gem.rotation.y = t * 1.8;
    }
  }
}
