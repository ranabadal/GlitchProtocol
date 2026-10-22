import * as THREE from "three";
import type { RemotePose } from "@/lib/services/rooms";
import { dampAngle, lerp, wrapAngle } from "../mathx";
import type { World } from "../World";
import { makeRig, type CharacterRig, type SoldierTemplate } from "./Character";
import { Heli } from "./Rides";
import type { Car, Vehicles } from "./Vehicles";

/*
 * The other racers in a multiplayer room. Each one is drawn as a full character (or
 * their car / helicopter) with a name tag in their team colour. Positions arrive from
 * the server a few times a second and are played back ~250 ms late, smoothly
 * interpolated between updates, so movement looks continuous even on school Wi-Fi.
 *
 * Racers are ghosts in each other's world: no collisions, no damage. Everyone fights
 * their own copy of NULL's robots.
 */

/** How far behind the newest update we draw (absorbs network jitter). */
const DELAY_MS = 260;
/** Remove a racer we haven't heard about for this long. */
const STALE_MS = 6000;

interface Snap {
  t: number;
  pose: RemotePose["pose"];
}

class Racer {
  rig: CharacterRig;
  tag: THREE.Sprite;
  ring: THREE.Mesh;
  snaps: Snap[] = [];
  car: Car | null = null;
  heli: Heli | null = null;
  pos = new THREE.Vector3();
  yaw = 0;
  lastSeen = 0;
  shown = false;

  constructor(public id: string, public name: string, public color: THREE.Color, template: SoldierTemplate | null, scene: THREE.Scene) {
    this.rig = makeRig(template, 150);
    this.rig.setGlow(color);
    this.rig.root.visible = false;
    scene.add(this.rig.root);
    this.tag = nameTag(name, color);
    this.tag.visible = false;
    scene.add(this.tag);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.72, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.6), transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false }));
    this.ring.visible = false;
    scene.add(this.ring);
  }
}

function nameTag(name: string, color: THREE.Color): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const g = c.getContext("2d")!;
  const hex = `#${color.getHexString()}`;
  g.font = "700 60px Oxanium, Rajdhani, sans-serif";
  const label = name.length > 16 ? name.slice(0, 15) + "…" : name;
  const w = Math.min(500, g.measureText(label).width + 56);
  g.fillStyle = "rgba(4, 10, 14, 0.78)";
  g.beginPath();
  g.roundRect((512 - w) / 2, 18, w, 84, 18);
  g.fill();
  g.strokeStyle = hex;
  g.lineWidth = 6;
  g.stroke();
  g.fillStyle = "#ffffff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(label, 256, 62);
  // Little pointer under the label.
  g.fillStyle = hex;
  g.beginPath();
  g.moveTo(240, 102);
  g.lineTo(272, 102);
  g.lineTo(256, 122);
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false }));
  sprite.renderOrder = 20;
  sprite.scale.set(2.4, 0.6, 1);
  return sprite;
}

export class Remotes {
  private racers = new Map<string, Racer>();
  private offset = 0;

  constructor(private world: World, private vehicles: Vehicles, private template: SoldierTemplate | null) {}

  /** Positions for the minimap and HUD: everyone currently visible. */
  list(): { id: string; name: string; color: string; x: number; z: number; heading: number }[] {
    return [...this.racers.values()].filter((r) => r.shown).map((r) => ({ id: r.id, name: r.name, color: `#${r.color.getHexString()}`, x: r.pos.x, z: r.pos.z, heading: r.yaw }));
  }

  /** New positions from the server. `serverNow` is the server clock when the reply was made. */
  push(others: RemotePose[], serverNow: number, colorOf: (userId: string) => string): void {
    this.offset = serverNow - Date.now();
    const seen = new Set<string>();
    for (const o of others) {
      seen.add(o.userId);
      let r = this.racers.get(o.userId);
      if (!r) {
        r = new Racer(o.userId, o.nickname, new THREE.Color(colorOf(o.userId)), this.template, this.world.scene);
        this.racers.set(o.userId, r);
      }
      r.lastSeen = serverNow;
      const last = r.snaps[r.snaps.length - 1];
      if (!last || o.at > last.t) {
        r.snaps.push({ t: o.at, pose: o.pose });
        if (r.snaps.length > 12) r.snaps.shift();
      }
    }
    for (const [id, r] of this.racers) {
      if (!seen.has(id) && serverNow - r.lastSeen > STALE_MS) this.remove(id, r);
    }
  }

  private remove(id: string, r: Racer): void {
    this.world.scene.remove(r.rig.root, r.tag, r.ring);
    if (r.car) this.vehicles.removePuppet(r.car);
    if (r.heli) this.world.scene.remove(r.heli.group);
    this.racers.delete(id);
  }

  update(dt: number): void {
    const now = Date.now() + this.offset - DELAY_MS;
    for (const r of this.racers.values()) {
      if (!r.snaps.length) continue;
      // Find the two updates around the playback time.
      let a = r.snaps[0], b = r.snaps[0];
      for (let i = 0; i < r.snaps.length; i++) {
        if (r.snaps[i].t <= now) a = r.snaps[i];
        if (r.snaps[i].t >= now) { b = r.snaps[i]; break; }
        b = r.snaps[i];
      }
      const span = b.t - a.t;
      let k = span > 0 ? (now - a.t) / span : 1;
      const P = a.pose, Q = b.pose;
      // Past the newest update: keep moving a little in the same direction (max 0.3 s).
      let ex = 0, ez = 0;
      if (now > b.t && Q.s > 0.5) {
        const extra = Math.min(0.3, (now - b.t) / 1000);
        ex = Math.sin(Q.h) * Q.s * extra;
        ez = Math.cos(Q.h) * Q.s * extra;
        k = 1;
      }
      k = Math.max(0, Math.min(1, k));
      const x = lerp(P.x, Q.x, k) + ex, y = lerp(P.y, Q.y, k), z = lerp(P.z, Q.z, k);
      const h = P.h + wrapAngle(Q.h - P.h) * k;
      r.pos.set(x, y, z);
      r.yaw = dampAngle(r.yaw, h, 14, dt);
      const mode = Q.m;
      r.shown = true;

      // Vehicle bodies come and go with the mode.
      if (mode === "car") {
        if (!r.car) r.car = this.vehicles.addPuppet(Q.v ?? 0, new THREE.Color(0.12, 0.13, 0.15), r.color);
        if (r.car) { r.car.pos.set(x, 0, z); r.car.heading = h; r.car.speed = Q.s; }
      } else if (r.car) { this.vehicles.removePuppet(r.car); r.car = null; }
      if (mode === "heli") {
        if (!r.heli) {
          r.heli = new Heli(x, z, h, new THREE.Color(0.85, 0.87, 0.9), r.color);
          this.world.scene.add(r.heli.group);
        }
        r.heli.puppet(dt, x, y, z, h, Q.s);
      } else if (r.heli) { this.world.scene.remove(r.heli.group); r.heli = null; }

      const onFoot = mode === "foot" || mode === "dead";
      r.rig.root.visible = onFoot;
      r.ring.visible = onFoot;
      if (onFoot) {
        r.rig.root.position.set(x, y, z);
        r.rig.root.rotation.y = r.yaw;
        r.rig.update(dt, {
          speed: Q.s, grounded: y < 0.25, aim: Q.f ? 1 : 0, pitch: Q.a ?? 0, recoil: 0, hack: false,
          dead: mode === "dead", hurt: 0, weapon: Q.w ?? "blaster",
        });
        r.ring.position.set(x, y + 0.04, z);
      }
      // Name tag above whatever they are in; on the train they are hidden inside.
      const tagY = mode === "heli" ? y + 4.6 : mode === "car" ? 2.6 : mode === "train" ? y + 3.8 : y + 2.25;
      r.tag.visible = true;
      r.tag.position.set(x, tagY, z);
      // Keep the tag readable at distance (constant-ish screen size).
      const d = this.world.camera.position.distanceTo(r.tag.position);
      const s = Math.max(1, d / 14);
      r.tag.scale.set(2.4 * s, 0.6 * s, 1);
    }
  }

  dispose(): void {
    for (const [id, r] of this.racers) this.remove(id, r);
  }
}
