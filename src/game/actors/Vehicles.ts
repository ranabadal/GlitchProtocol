import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { getCity, LANES, ROAD, type Edge } from "@/lib/shared/city";
import { clamp, damp, mulberry, turnToward, wrapAngle } from "../mathx";
import { radialTexture } from "../world/Textures";
import { panFor, type CarLike, type World } from "../World";

/*
 * Cars. Three procedural futuristic models (Interceptor, Cab, Hauler), drawn instanced:
 * one draw call per model for bodies plus one for every wheel in the city. Traffic
 * drives on the LEFT (like India) along the road graph, yields at junctions, stops for
 * anything in front and never enters barricaded or fenced roads. Any car can be
 * taken over with F; the player's car uses arcade physics with drifting.
 */

export interface Variant {
  name: string;
  length: number;
  width: number;
  wheelR: number;
  wheelbase: number;
  track: number;
  maxSpeed: number;
  accel: number;
  grip: number;
  health: number;
}

export const VARIANTS: Variant[] = [
  { name: "Interceptor", length: 4.6, width: 2.0, wheelR: 0.36, wheelbase: 2.8, track: 1.72, maxSpeed: 40, accel: 17, grip: 9, health: 100 },
  { name: "Neon Cab", length: 4.8, width: 2.0, wheelR: 0.38, wheelbase: 2.9, track: 1.7, maxSpeed: 33, accel: 13, grip: 8, health: 110 },
  { name: "Hauler", length: 5.4, width: 2.25, wheelR: 0.45, wheelbase: 3.4, track: 1.9, maxSpeed: 28, accel: 10, grip: 7, health: 150 },
];

// ---------------------------------------------------------------- geometry

const P_PAINT = 0, P_GLASS = 1, P_TRIM = 2, P_HEAD = 3, P_TAIL = 4, P_NEON = 5;

function part(g: THREE.BufferGeometry, p: number): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute("uv");
  ng.setAttribute("aPart", new THREE.BufferAttribute(new Float32Array(ng.getAttribute("position").count).fill(p), 1));
  return ng;
}

function extrudeSide(pts: [number, number][], width: number, bevel: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 2, curveSegments: 4 });
  g.translate(0, 0, -(width - bevel * 2) / 2);
  g.rotateY(-Math.PI / 2);
  return g;
}

function carGeometry(v: number): THREE.BufferGeometry {
  const V = VARIANTS[v];
  const L = V.length / 2, W = V.width;
  const parts: THREE.BufferGeometry[] = [];
  if (v === 0) {
    parts.push(part(extrudeSide([[-L, 0.32], [L - 0.1, 0.3], [L, 0.45], [L - 0.15, 0.68], [0.9, 0.82], [-1.2, 0.86], [-L + 0.05, 0.92], [-L, 0.6]], W, 0.12), P_PAINT));
    parts.push(part(extrudeSide([[-1.25, 0.84], [-0.45, 1.22], [0.35, 1.2], [1.05, 0.83]], W * 0.82, 0.08), P_GLASS));
    parts.push(part(new THREE.BoxGeometry(W * 0.95, 0.06, 0.3).translate(0, 1.0, -L + 0.12), P_TRIM));
    parts.push(part(new THREE.BoxGeometry(0.06, 0.12, 0.06).translate(W * 0.4, 0.94, -L + 0.2), P_TRIM));
    parts.push(part(new THREE.BoxGeometry(0.06, 0.12, 0.06).translate(-W * 0.4, 0.94, -L + 0.2), P_TRIM));
  } else if (v === 1) {
    parts.push(part(extrudeSide([[-L, 0.35], [L - 0.1, 0.33], [L, 0.5], [L - 0.2, 0.78], [1.2, 0.9], [-1.6, 0.92], [-L, 0.85]], W, 0.12), P_PAINT));
    parts.push(part(extrudeSide([[-1.6, 0.9], [-1.2, 1.45], [0.6, 1.45], [1.2, 0.9]], W * 0.86, 0.08), P_GLASS));
    parts.push(part(new THREE.BoxGeometry(0.7, 0.22, 0.28).translate(0, 1.58, -0.2), P_NEON));
  } else {
    parts.push(part(extrudeSide([[-L, 0.42], [L - 0.1, 0.4], [L, 0.6], [L - 0.15, 1.05], [L - 0.9, 1.3], [-L, 1.3]], W, 0.1), P_PAINT));
    parts.push(part(new THREE.BoxGeometry(W * 0.96, 1.05, V.length - 1.4).translate(0, 1.82, -0.55), P_PAINT));
    parts.push(part(extrudeSide([[L - 0.95, 1.28], [L - 0.7, 1.95], [L - 1.35, 2.2], [L - 1.4, 1.28]], W * 0.9, 0.06), P_GLASS));
    parts.push(part(new THREE.BoxGeometry(W * 0.98, 0.05, V.length - 1.5).translate(0, 2.35, -0.55), P_NEON));
  }
  // Shared details: lights, neon stripe, underglow, dark skirts.
  const frontZ = V.length / 2 + 0.01, rearZ = -V.length / 2 - 0.01;
  const lightY = v === 2 ? 0.85 : 0.58;
  parts.push(part(new THREE.BoxGeometry(W * 0.3, 0.07, 0.05).translate(W * 0.28, lightY, frontZ - 0.08), P_HEAD));
  parts.push(part(new THREE.BoxGeometry(W * 0.3, 0.07, 0.05).translate(-W * 0.28, lightY, frontZ - 0.08), P_HEAD));
  parts.push(part(new THREE.BoxGeometry(W * 0.9, 0.06, 0.05).translate(0, lightY + 0.12, rearZ + 0.06), P_TAIL));
  parts.push(part(new THREE.BoxGeometry(W + 0.02, 0.025, V.length * 0.62).translate(0, lightY + 0.05, 0), P_NEON));
  parts.push(part(new THREE.BoxGeometry(W * 0.85, 0.04, V.length * 0.8).translate(0, 0.22, 0), P_NEON));
  parts.push(part(new THREE.BoxGeometry(W * 0.98, 0.16, V.length * 0.94).translate(0, 0.3, 0), P_TRIM));
  return mergeGeometries(parts)!;
}

function bodyMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.6 });
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aPart; attribute vec2 aState; attribute vec3 aNeon; varying float vPart; varying vec2 vState; varying vec3 vNeon;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPart = aPart; vState = aState; vNeon = aNeon;");
    s.fragmentShader = s.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vPart; varying vec2 vState; varying vec3 vNeon;")
      .replace("#include <color_fragment>", `#include <color_fragment>
        vec3 gpPaint = diffuseColor.rgb;
        float gpDmg = vState.y;
        int gpP = int(vPart + 0.5);
        vec3 gpEm = vec3(0.0);
        float gpRough = 0.28, gpMetal = 0.65;
        if (gpP == 0) { diffuseColor.rgb = mix(gpPaint, vec3(0.03), gpDmg); }
        else if (gpP == 1) { diffuseColor.rgb = vec3(0.015, 0.02, 0.03); gpRough = 0.08; gpMetal = 0.9; gpEm = vec3(0.02, 0.06, 0.08); }
        else if (gpP == 2) { diffuseColor.rgb = vec3(0.025); gpRough = 0.6; gpMetal = 0.3; }
        else if (gpP == 3) { diffuseColor.rgb = vec3(1.0); gpEm = vec3(3.2, 3.1, 2.8) * (1.0 - gpDmg); }
        else if (gpP == 4) { diffuseColor.rgb = vec3(0.4, 0.0, 0.0); gpEm = vec3(2.4, 0.08, 0.15) * (0.45 + vState.x * 1.6) * (1.0 - gpDmg); }
        else { diffuseColor.rgb = vNeon * 0.3; gpEm = vNeon * 1.35 * (1.0 - gpDmg); }`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = gpRough;")
      .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nmetalnessFactor = gpMetal;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += gpEm;");
  };
  m.customProgramCacheKey = () => "gp-car";
  return m;
}

// Real-world car colours (white, silver, red, blue, black, teal, orange, graphite): readable by day and under neon.
const PAINTS = [0xd9dde2, 0x8e959e, 0xa3141f, 0x1d4f9a, 0x14171b, 0x0f6b66, 0xd86a12, 0x3a3f46, 0xe8e4da, 0x5b1f6e].map((h) => new THREE.Color(h).multiplyScalar(0.55));
const CAB_PAINTS = [0xc79a0c, 0xb8860b, 0xd4a017].map((h) => new THREE.Color(h).multiplyScalar(0.55));
const NEONS = [0x29ffa0, 0x29d9ff, 0xff3aa8, 0xffb229, 0xa86bff].map((h) => new THREE.Color(h));

// ---------------------------------------------------------------- car state

export type Driver = "ai" | "player" | "none";

export class Car implements CarLike {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  heading = 0;
  speed = 0;
  steer = 0;
  wheelSpin = 0;
  health: number;
  driver: Driver = "ai";
  /** Simulated with physics (player is or was driving it). */
  phys = false;
  braking = 0;
  dead = false;
  deadT = 0;
  paint = new THREE.Color();
  neon = new THREE.Color();
  active = true;
  // AI
  pts: THREE.Vector3[] = [];
  edge: Edge | null = null;
  from = 0;
  to = 0;
  lane = LANES[0];
  bumpT = 0;
  stuckT = 0;
  hornT = 0;
  smokeT = 0;
  lastHit = 0;
  onDamage: ((amount: number, from: THREE.Vector3) => void) | null = null;

  constructor(public id: number, public variant: number) {
    this.health = VARIANTS[variant].health;
  }

  get v(): Variant { return VARIANTS[this.variant]; }

  takeDamage(amount: number, from: THREE.Vector3): void {
    if (this.dead) return;
    this.health = Math.max(0, this.health - amount);
    this.onDamage?.(amount, from);
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }
}

export interface DriveInput { throttle: number; brake: number; steer: number; handbrake: boolean; boost: boolean }

const CIRCLES = [-1, 0, 1];
const WRECK = new THREE.Color(0.02, 0.02, 0.022);

// ---------------------------------------------------------------- system

export class Vehicles {
  group = new THREE.Group();
  cars: Car[] = [];
  /** Roads AI must not use (barricades, active laser fences). */
  blocked = new Set<string>();
  /** Notified when an AI driver is kicked out (crowd spawns a fleeing person). */
  onDriverEjected: ((x: number, z: number, awayX: number, awayZ: number) => void) | null = null;
  /** Notified when a car wall-hits a box with a tag (laser fences). */
  onBoxHit: ((car: Car, kind: string, tag: string | undefined, impact: number) => void) | null = null;
  private bodies: THREE.InstancedMesh[] = [];
  private states: THREE.InstancedBufferAttribute[] = [];
  private neons: THREE.InstancedBufferAttribute[] = [];
  private wheelNeon: THREE.InstancedBufferAttribute;
  private wheels: THREE.InstancedMesh;
  private beams: THREE.InstancedMesh;
  private pools: THREE.InstancedMesh;
  private rand = mulberry(77);
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private s = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private frustum = new THREE.Frustum();
  private nextId = 1;
  headlight: THREE.SpotLight | null = null;

  constructor(private world: World, private trafficCount: number, private capacity: number) {
    const mat = bodyMaterial();
    for (let v = 0; v < VARIANTS.length; v++) {
      const g = carGeometry(v);
      const st = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
      st.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute("aState", st);
      const nn = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      nn.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute("aNeon", nn);
      this.neons.push(nn);
      const im = new THREE.InstancedMesh(g, mat, capacity);
      im.castShadow = true;
      im.frustumCulled = false;
      for (let i = 0; i < capacity; i++) { im.setMatrixAt(i, this.zero); im.setColorAt(i, new THREE.Color(0, 0, 0)); }
      this.bodies.push(im);
      this.states.push(st);
      this.group.add(im);
    }
    const wg = mergeGeometries([
      part(new THREE.CylinderGeometry(1, 1, 0.32, 16).rotateZ(Math.PI / 2), P_TRIM),
      part(new THREE.TorusGeometry(0.62, 0.06, 6, 16).rotateY(Math.PI / 2).translate(0.165, 0, 0), P_NEON),
      part(new THREE.TorusGeometry(0.62, 0.06, 6, 16).rotateY(Math.PI / 2).translate(-0.165, 0, 0), P_NEON),
      part(new THREE.BoxGeometry(0.34, 0.14, 1.3), P_TRIM),
    ])!;
    wg.setAttribute("aState", new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4 * 2), 2));
    this.wheelNeon = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4 * 3), 3);
    this.wheelNeon.setUsage(THREE.DynamicDrawUsage);
    wg.setAttribute("aNeon", this.wheelNeon);
    this.wheels = new THREE.InstancedMesh(wg, mat, capacity * 4);
    this.wheels.frustumCulled = false;
    for (let i = 0; i < capacity * 4; i++) { this.wheels.setMatrixAt(i, this.zero); this.wheels.setColorAt(i, new THREE.Color(0, 0, 0)); }
    this.group.add(this.wheels);

    // Fake headlight beams and light pools on the road.
    const beamGeo = new THREE.ConeGeometry(2.6, 14, 16, 1, true).rotateX(-Math.PI / 2).translate(0, 0, 7);
    const beamMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: /* glsl */ `varying float vZ; void main(){ vZ = position.z / 14.0; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `varying float vZ; void main(){ gl_FragColor = vec4(vec3(0.9, 0.95, 1.0) * 0.06 * (1.0 - vZ) * smoothstep(0.0, 0.08, vZ), 1.0); }`,
    });
    this.beams = new THREE.InstancedMesh(beamGeo, beamMat, capacity * 2);
    this.beams.frustumCulled = false;
    const poolGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.pools = new THREE.InstancedMesh(poolGeo, new THREE.MeshBasicMaterial({ map: radialTexture(), color: new THREE.Color(0.32, 0.33, 0.3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), capacity);
    this.pools.frustumCulled = false;
    for (let i = 0; i < capacity * 2; i++) this.beams.setMatrixAt(i, this.zero);
    for (let i = 0; i < capacity; i++) this.pools.setMatrixAt(i, this.zero);
    this.group.add(this.beams, this.pools);

    if (world.q.lights) {
      this.headlight = new THREE.SpotLight(0xe8f4ff, 0, 60, 0.5, 0.6, 1.4);
      this.headlight.castShadow = false;
      this.group.add(this.headlight, this.headlight.target);
    }
  }

  // ------------------------------------------------------------ spawning

  private makeCar(variant: number): Car | null {
    if (this.cars.length >= this.capacity) return null;
    const c = new Car(this.nextId++, variant);
    c.paint.copy(variant === 1 ? CAB_PAINTS[Math.floor(this.rand() * CAB_PAINTS.length)] : PAINTS[Math.floor(this.rand() * PAINTS.length)]);
    c.neon.copy(NEONS[Math.floor(this.rand() * NEONS.length)]);
    this.cars.push(c);
    return c;
  }

  /** The car waiting outside the safehouse at mission start. */
  addParked(x: number, z: number, heading: number, variant: number, paint?: THREE.Color, neon?: THREE.Color): Car | null {
    const c = this.makeCar(variant);
    if (!c) return null;
    c.pos.set(x, 0, z);
    c.heading = heading;
    c.driver = "none";
    c.phys = true;
    if (paint) c.paint.copy(paint);
    if (neon) c.neon.copy(neon);
    return c;
  }

  /** Fill the streets around a point with traffic and a few parked cars. */
  populate(cx: number, cz: number, parked = 6): void {
    for (let i = 0; i < this.trafficCount; i++) {
      const c = this.makeCar(this.rand() < 0.5 ? 1 : this.rand() < 0.6 ? 0 : 2);
      if (!c) break;
      if (!this.respawnAi(c, cx, cz, 20, 190, false)) c.active = false;
    }
    const city = getCity();
    for (let i = 0; i < parked; i++) {
      for (let t = 0; t < 20; t++) {
        const e = city.edges[Math.floor(this.rand() * city.edges.length)];
        const p = this.edgePoint(e, e.a, 0.25 + this.rand() * 0.5, 8.2);
        if (Math.hypot(p.x - cx, p.z - cz) > 160 || this.tooClose(p.x, p.z, 9)) continue;
        const h = Math.atan2(city.nodes[e.b].x - city.nodes[e.a].x, city.nodes[e.b].z - city.nodes[e.a].z);
        this.addParked(p.x, p.z, h, Math.floor(this.rand() * 3));
        break;
      }
    }
  }

  private tooClose(x: number, z: number, d: number, except?: Car): boolean {
    return this.cars.some((c) => c !== except && c.active && Math.hypot(c.pos.x - x, c.pos.z - z) < d);
  }

  /** Point on the left-hand lane of an edge, travelling away from node `from`. */
  private edgePoint(e: Edge, from: number, t: number, lane: number): THREE.Vector3 {
    const city = getCity();
    const a = city.nodes[from], b = city.nodes[from === e.a ? e.b : e.a];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    const lx = dz / len, lz = -dx / len;
    return new THREE.Vector3(a.x + dx * t + lx * lane, 0, a.z + dz * t + lz * lane);
  }

  private respawnAi(c: Car, cx: number, cz: number, minD: number, maxD: number, hidden: boolean): boolean {
    const city = getCity();
    const cam = this.world.camera;
    this.frustum.setFromProjectionMatrix(this.m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    for (let t = 0; t < 30; t++) {
      const e = city.edges[Math.floor(this.rand() * city.edges.length)];
      if (this.blocked.has(e.id)) continue;
      const from = this.rand() < 0.5 ? e.a : e.b;
      const lane = LANES[this.rand() < 0.5 ? 0 : 1];
      const p = this.edgePoint(e, from, 0.3 + this.rand() * 0.4, lane);
      const d = Math.hypot(p.x - cx, p.z - cz);
      if (d < minD || d > maxD) continue;
      if (this.tooClose(p.x, p.z, 12, c)) continue;
      if (hidden && t < 24 && this.frustum.containsPoint(this.v3.set(p.x, 1, p.z))) continue;
      const to = from === e.a ? e.b : e.a;
      c.pos.copy(p);
      c.heading = Math.atan2(city.nodes[to].x - city.nodes[from].x, city.nodes[to].z - city.nodes[from].z);
      c.edge = e;
      c.from = from;
      c.to = to;
      c.lane = lane;
      c.pts = [this.edgePoint(e, from, 1, lane).addScaledVector(this.forward2(c.heading), -(ROAD / 2 + 2))];
      c.speed = 8;
      c.driver = "ai";
      c.phys = false;
      c.dead = false;
      c.health = c.v.health;
      c.active = true;
      c.bumpT = 0;
      c.stuckT = 0;
      return true;
    }
    return false;
  }

  private forward2(h: number): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
  }

  /** Choose the next road at a junction and queue the turn. */
  private planNext(c: Car): void {
    const city = getCity();
    const node = city.nodes[c.to];
    const options = city.adjacency[c.to].filter((id) => id !== c.edge!.id && !this.blocked.has(id));
    const eid = options.length ? options[Math.floor(this.rand() * options.length)] : c.edge!.id;
    const e = city.edgeById.get(eid)!;
    const from = c.to;
    const to = e.a === from ? e.b : e.a;
    const d1 = new THREE.Vector3(node.x - city.nodes[c.from].x, 0, node.z - city.nodes[c.from].z).normalize();
    const d2 = new THREE.Vector3(city.nodes[to].x - node.x, 0, city.nodes[to].z - node.z).normalize();
    const lane = c.lane;
    const end = c.pos.clone();
    const start = this.edgePoint(e, from, 0, lane).addScaledVector(d2, ROAD / 2 + 2);
    let ctrl: THREE.Vector3;
    const cross = d1.x * d2.z - d1.z * d2.x;
    if (Math.abs(cross) < 0.1) {
      ctrl = d1.dot(d2) > 0 ? end.clone().add(start).multiplyScalar(0.5) : new THREE.Vector3(node.x, 0, node.z).addScaledVector(d1, 5);
    } else {
      // Intersection of the two lane lines.
      const t = ((start.x - end.x) * d2.z - (start.z - end.z) * d2.x) / cross;
      ctrl = end.clone().addScaledVector(d1, t);
    }
    const pts: THREE.Vector3[] = [];
    for (const t of [0.35, 0.7, 1]) {
      const a = 1 - t;
      pts.push(new THREE.Vector3(a * a * end.x + 2 * a * t * ctrl.x + t * t * start.x, 0, a * a * end.z + 2 * a * t * ctrl.z + t * t * start.z));
    }
    pts.push(this.edgePoint(e, from, 1, lane).addScaledVector(d2, -(ROAD / 2 + 2)));
    c.pts = pts;
    c.edge = e;
    c.from = from;
    c.to = to;
  }

  // ------------------------------------------------------------ queries

  nearestEnterable(p: THREE.Vector3, maxD: number): Car | null {
    let best: Car | null = null, bd = maxD;
    for (const c of this.cars) {
      if (!c.active || c.dead || c.driver === "player") continue;
      const d = Math.hypot(c.pos.x - p.x, c.pos.z - p.z) - c.v.width / 2;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  takeControl(c: Car): void {
    if (c.driver === "ai") {
      const side = this.v3.set(-Math.cos(c.heading), 0, Math.sin(c.heading));
      this.onDriverEjected?.(c.pos.x + side.x * 1.6, c.pos.z + side.z * 1.6, side.x, side.z);
      this.world.sound.horn();
    }
    c.driver = "player";
    c.phys = true;
    this.forward(c);
    c.vel.copy(this.fwd).multiplyScalar(c.speed);
  }

  release(c: Car): void {
    c.driver = "none";
  }

  private forward(c: Car): THREE.Vector3 {
    return this.fwd.set(Math.sin(c.heading), 0, Math.cos(c.heading));
  }

  /** Circle overlap test used by the crowd and the player on foot. */
  carsNear(x: number, z: number, r: number): Car[] {
    return this.cars.filter((c) => c.active && Math.hypot(c.pos.x - x, c.pos.z - z) < r + c.v.length / 2);
  }

  /** Push a circle out of every car; returns true if it touched one. */
  pushOut(pos: THREE.Vector3, r: number): Car | null {
    let touched: Car | null = null;
    for (const c of this.cars) {
      if (!c.active) continue;
      const fx = Math.sin(c.heading), fz = Math.cos(c.heading);
      // Car as an oriented box: local coordinates of the point.
      const dx = pos.x - c.pos.x, dz = pos.z - c.pos.z;
      const lz = dx * fx + dz * fz, lx = dx * fz - dz * fx;
      const hx = c.v.width / 2 + r, hz = c.v.length / 2 + r;
      if (Math.abs(lx) >= hx || Math.abs(lz) >= hz) continue;
      const px = hx - Math.abs(lx), pz = hz - Math.abs(lz);
      let nx: number, nz: number;
      if (px < pz) { nx = Math.sign(lx) * px; nz = 0; } else { nx = 0; nz = Math.sign(lz) * pz; }
      pos.x += nx * fz + nz * fx;
      pos.z += -nx * fx + nz * fz;
      touched = c;
    }
    return touched;
  }

  // ------------------------------------------------------------ player driving

  drive(c: Car, inp: DriveInput, dt: number): void {
    const V = c.v;
    const f = this.forward(c).clone();
    const r = new THREE.Vector3(f.z, 0, -f.x);
    let vF = c.vel.dot(f);
    let vR = c.vel.dot(r);
    const top = V.maxSpeed * (inp.boost ? 1.12 : 1) * (c.health < 25 ? 0.7 : 1);
    if (inp.throttle > 0) {
      vF += (vF < 0 ? V.accel * 2 : V.accel * (inp.boost ? 1.35 : 1) * (1 - Math.max(0, vF) / top)) * inp.throttle * dt;
    }
    if (inp.brake > 0) {
      if (vF > 0.5) vF -= 32 * inp.brake * dt;
      else vF = Math.max(-11, vF - V.accel * 0.7 * inp.brake * dt);
    }
    c.braking = inp.brake > 0 && vF > 0.5 ? 1 : inp.handbrake ? 1 : 0;
    // Rolling resistance and drag.
    vF -= vF * (inp.throttle === 0 && inp.brake === 0 ? 0.6 : 0.05) * dt;
    if (inp.handbrake) vF -= Math.sign(vF) * Math.min(Math.abs(vF), 9 * dt);
    // Steering: tighter at low speed.
    const steerMax = 0.62 - clamp(Math.abs(vF) / 45, 0, 1) * 0.4;
    c.steer = damp(c.steer, inp.steer * steerMax, 10, dt);
    const yawRate = (vF / V.wheelbase) * Math.tan(c.steer) * (inp.handbrake ? 1.35 : 1);
    c.heading = wrapAngle(c.heading + yawRate * dt);
    // Lateral grip: handbrake lets the tail slide.
    const grip = inp.handbrake ? 1.6 : V.grip;
    vR *= Math.exp(-grip * dt);
    const nf = this.forward(c).clone();
    const nr = new THREE.Vector3(nf.z, 0, -nf.x);
    c.vel.copy(nf).multiplyScalar(vF).addScaledVector(nr, vR);
    c.speed = vF;
    if (Math.abs(vR) > 6 && Math.abs(vF) > 8 && Math.random() < dt * 30) {
      this.world.fx.smokePuff(this.v3.set(c.pos.x - nf.x * 1.8 + nr.x * (Math.random() > 0.5 ? 0.8 : -0.8), 0.3, c.pos.z - nf.z * 1.8 + nr.z * (Math.random() > 0.5 ? 0.8 : -0.8)), 0.12);
    }
  }

  private physicsStep(c: Car, dt: number): void {
    if (c.driver !== "player") {
      // Coasting to a stop.
      c.vel.multiplyScalar(Math.exp(-1.8 * dt));
      this.forward(c);
      c.speed = c.vel.dot(this.fwd);
      c.braking = 0;
    }
    if (c.vel.lengthSq() < 1e-4 && c.driver !== "player") return;
    c.pos.addScaledVector(c.vel, dt);
    const fx = Math.sin(c.heading), fz = Math.cos(c.heading);
    const rad = c.v.width / 2;
    const step = c.v.length / 2 - rad;
    let hitN: THREE.Vector3 | null = null;
    let hitKind = "", hitTag: string | undefined;
    for (const k of CIRCLES) {
      const cx = c.pos.x + fx * step * k, cz = c.pos.z + fz * step * k;
      const res = this.world.colliders.resolveCircle(cx, cz, rad, 0.2, 1.4);
      if (res.hit) {
        c.pos.x += res.x - cx;
        c.pos.z += res.z - cz;
        hitN = new THREE.Vector3(res.nx, 0, res.nz);
        hitKind = res.box?.kind ?? "";
        hitTag = res.box?.tag;
      }
    }
    // Other cars.
    for (const o of this.cars) {
      if (o === c || !o.active) continue;
      const dx = o.pos.x - c.pos.x, dz = o.pos.z - c.pos.z;
      if (dx * dx + dz * dz > 49) continue;
      const ofx = Math.sin(o.heading), ofz = Math.cos(o.heading);
      const orad = o.v.width / 2, ostep = o.v.length / 2 - orad;
      for (const k of CIRCLES) {
        for (const j of CIRCLES) {
          const ax = c.pos.x + fx * step * k, az = c.pos.z + fz * step * k;
          const bx = o.pos.x + ofx * ostep * j, bz = o.pos.z + ofz * ostep * j;
          const ddx = ax - bx, ddz = az - bz, d = Math.hypot(ddx, ddz), min = rad + orad;
          if (d >= min || d < 1e-4) continue;
          const nx = ddx / d, nz = ddz / d, pen = min - d;
          c.pos.x += nx * pen * 0.7;
          c.pos.z += nz * pen * 0.7;
          if (o.phys) { o.pos.x -= nx * pen * 0.3; o.pos.z -= nz * pen * 0.3; o.vel.x -= nx * 2; o.vel.z -= nz * 2; }
          else { o.bumpT = 2.5; o.speed = 0; }
          hitN = new THREE.Vector3(nx, 0, nz);
          hitKind = "car";
        }
      }
    }
    if (hitN) {
      const impact = -c.vel.dot(hitN);
      if (impact > 0) {
        c.vel.addScaledVector(hitN, impact * 1.35);
        c.vel.multiplyScalar(0.92);
        if (impact > 6 && this.world.time - c.lastHit > 0.25) {
          c.lastHit = this.world.time;
          if (c.driver === "player") {
            c.takeDamage((impact - 6) * 1.6, c.pos);
            this.world.shake(Math.min(0.8, impact / 30));
          }
          const sp = panFor(this.world, c.pos.x, c.pos.z);
          this.world.sound.crash(Math.min(1, impact / 25) * Math.max(0.2, sp.vol));
          this.world.fx.sparks(this.v3.set(c.pos.x - hitN.x * 1.2, 0.6, c.pos.z - hitN.z * 1.2), hitN, new THREE.Color(1, 0.7, 0.3), 12, 8);
        }
        if (hitKind && hitKind !== "car") this.onBoxHit?.(c, hitKind, hitTag, impact);
      }
    }
  }

  // ------------------------------------------------------------ AI

  private aiStep(c: Car, dt: number, depth = 0): void {
    const w = this.world;
    if (c.bumpT > 0) {
      c.bumpT -= dt;
      c.speed = 0;
      c.braking = 1;
      if (c.hornT <= 0 && Math.hypot(c.pos.x - w.listenerPos.x, c.pos.z - w.listenerPos.z) < 40) { w.sound.horn(); c.hornT = 3; }
      c.hornT -= dt;
      return;
    }
    if (!c.pts.length) this.planNext(c);
    const target = c.pts[0];
    const dx = target.x - c.pos.x, dz = target.z - c.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 2.4 && depth < 4) { c.pts.shift(); if (!c.pts.length) this.planNext(c); return this.aiStep(c, dt, depth + 1); }
    const want = Math.atan2(dx, dz);
    const turnNeed = Math.abs(wrapAngle(want - c.heading));
    let cruise = c.pts.length > 1 && turnNeed > 0.25 ? 7 : 12.5;
    if (c.lane > 5) cruise -= 1.5;
    // Anything ahead of us?
    const fx = Math.sin(c.heading), fz = Math.cos(c.heading);
    const look = 5 + c.speed * 1.1;
    let ahead = Infinity;
    const consider = (x: number, z: number, rad: number) => {
      const rx = x - c.pos.x, rz = z - c.pos.z;
      const along = rx * fx + rz * fz;
      if (along <= 0 || along > look + rad) return;
      const lat = Math.abs(rx * fz - rz * fx);
      if (lat < 1.4 + rad) ahead = Math.min(ahead, along - rad);
    };
    for (const o of this.cars) if (o !== c && o.active) consider(o.pos.x, o.pos.z, o.v.width / 2);
    const p = w.player;
    if (p && !p.car && p.alive) consider(p.pos.x, p.pos.z, 0.6);
    for (const r of this.extraObstacles) consider(r.x, r.z, r.r);
    // Yield at junctions: wait if someone is already crossing.
    if (c.pts.length === 1) {
      const node = getCity().nodes[c.to];
      const toNode = Math.hypot(node.x - c.pos.x, node.z - c.pos.z);
      if (toNode < ROAD / 2 + 9 && toNode > ROAD / 2 + 1) {
        for (const o of this.cars) {
          if (o === c || !o.active) continue;
          if (Math.hypot(o.pos.x - node.x, o.pos.z - node.z) < ROAD / 2 + 1 && o.pos.distanceTo(c.pos) > 3) { ahead = Math.min(ahead, toNode - ROAD / 2); break; }
        }
      }
    }
    const target_speed = ahead === Infinity ? cruise : clamp((ahead - 3.5) * 1.3, 0, cruise);
    c.braking = target_speed < c.speed - 0.5 ? 1 : 0;
    c.speed = target_speed > c.speed ? Math.min(target_speed, c.speed + 6 * dt) : Math.max(target_speed, c.speed - 14 * dt);
    if (c.speed < 0.3 && ahead !== Infinity) {
      c.stuckT += dt;
      if (c.stuckT > 2 && c.hornT <= 0 && Math.hypot(c.pos.x - w.listenerPos.x, c.pos.z - w.listenerPos.z) < 35) { w.sound.horn(); c.hornT = 4; }
    } else c.stuckT = 0;
    c.hornT -= dt;
    const maxTurn = (c.speed / 5.5) * dt + 0.3 * dt;
    const prevH = c.heading;
    c.heading = turnToward(c.heading, want, maxTurn);
    c.steer = clamp(wrapAngle(c.heading - prevH) / Math.max(dt, 1e-3) * 0.3, -0.5, 0.5);
    c.pos.x += Math.sin(c.heading) * c.speed * dt;
    c.pos.z += Math.cos(c.heading) * c.speed * dt;
    c.vel.set(Math.sin(c.heading) * c.speed, 0, Math.cos(c.heading) * c.speed);
  }

  /** Extra things AI cars stop for (robots standing in the road). Filled by the game each frame. */
  extraObstacles: { x: number; z: number; r: number }[] = [];

  // ------------------------------------------------------------ frame

  update(dt: number): void {
    const w = this.world;
    const L = w.listenerPos;
    for (const c of this.cars) {
      if (!c.active) continue;
      if (c.dead) {
        c.deadT += dt;
        if (Math.random() < dt * 12) w.fx.smokePuff(this.v3.set(c.pos.x, 1.2, c.pos.z), 0.04);
        if (c.driver === "none") this.physicsStep(c, dt);
        continue;
      }
      if (c.driver === "ai") {
        this.aiStep(c, dt);
        const d = Math.hypot(c.pos.x - L.x, c.pos.z - L.z);
        if (d > 250 || (c.stuckT > 8 && d > 60)) this.respawnAi(c, L.x, L.z, 70, 200, true);
      } else if (c.phys) {
        this.physicsStep(c, dt);
      }
      c.wheelSpin += (c.speed / c.v.wheelR) * dt;
      // Damage smoke and fire.
      if (c.health < c.v.health * 0.45) {
        c.smokeT -= dt;
        if (c.smokeT <= 0) {
          c.smokeT = c.health < c.v.health * 0.2 ? 0.05 : 0.15;
          const f = this.forward(c);
          const p = this.v3.set(c.pos.x + f.x * (c.v.length / 2 - 0.6), 1.0, c.pos.z + f.z * (c.v.length / 2 - 0.6));
          w.fx.smokePuff(p, c.health < c.v.health * 0.2 ? 0.03 : 0.12);
          if (c.health < c.v.health * 0.2) w.fx.sparks(p, null, new THREE.Color(1, 0.4, 0.1), 2, 3);
        }
      }
      if (c.health <= 0 && !c.dead) this.explode(c);
    }
    // Wrecks far away get recycled into traffic.
    for (const c of this.cars) {
      if (c.dead && c.deadT > 20 && Math.hypot(c.pos.x - L.x, c.pos.z - L.z) > 120) this.respawnAi(c, L.x, L.z, 80, 200, true);
    }
    this.render();
  }

  explode(c: Car): void {
    c.dead = true;
    c.deadT = 0;
    c.health = 0;
    const p = c.pos.clone().setY(1);
    this.world.fx.explosion(p, 1.6);
    const sp = panFor(this.world, p.x, p.z);
    this.world.sound.explosion(Math.max(0.3, sp.vol), sp.pan);
    this.world.shake(0.9 * Math.max(0.3, sp.vol));
    this.world.noise(p.x, p.z, 50, "explosion");
    c.vel.y = 0;
    if (c.driver === "ai") c.driver = "none";
    c.phys = true;
  }

  private render(): void {
    const counts = [0, 0, 0];
    let wi = 0, bi = 0, pi = 0;
    const cam = this.world.camera.position;
    const one = this.s.set(1, 1, 1).clone();
    for (const c of this.cars) {
      if (!c.active) continue;
      const v = c.variant;
      const i = counts[v]++;
      // Body with a little lean while turning.
      const lean = clamp(-c.steer * c.speed * 0.006, -0.06, 0.06);
      this.e.set(c.speed > 0.5 && c.braking ? 0.015 : 0, c.heading, lean, "YXZ");
      this.q.setFromEuler(this.e);
      this.m4.compose(this.v3.set(c.pos.x, c.dead ? -0.12 : 0, c.pos.z), this.q, one);
      this.bodies[v].setMatrixAt(i, this.m4);
      this.bodies[v].setColorAt(i, c.dead ? WRECK : c.paint);
      this.neons[v].setXYZ(i, c.neon.r, c.neon.g, c.neon.b);
      const st = this.states[v];
      st.setXY(i, c.braking, c.dead ? 1 : clamp(1 - c.health / c.v.health - 0.5, 0, 0.6));
      // Wheels.
      const V = c.v;
      const fx = Math.sin(c.heading), fz = Math.cos(c.heading);
      if (Math.hypot(c.pos.x - cam.x, c.pos.z - cam.z) < 140) {
        for (let k = 0; k < 4; k++) {
          const front = k < 2 ? 1 : -1, side = k % 2 ? 1 : -1;
          const lz = front * V.wheelbase / 2, lx = side * V.track / 2;
          const wx = c.pos.x + fx * lz + fz * lx, wz = c.pos.z + fz * lz - fx * lx;
          this.e.set(c.wheelSpin, c.heading + (front > 0 ? c.steer : 0), 0, "YXZ");
          this.q.setFromEuler(this.e);
          this.m4.compose(this.v3.set(wx, V.wheelR, wz), this.q, this.s.set(1, V.wheelR, V.wheelR));
          this.wheels.setMatrixAt(wi, this.m4);
          this.wheels.setColorAt(wi, WRECK);
          if (c.dead) this.wheelNeon.setXYZ(wi, 0, 0, 0);
          else this.wheelNeon.setXYZ(wi, c.neon.r, c.neon.g, c.neon.b);
          wi++;
        }
      }
      // Headlight beams and pools for moving cars.
      if (!c.dead && (c.driver !== "none" || Math.abs(c.speed) > 0.5)) {
        for (const side of [-1, 1]) {
          this.e.set(-0.12, c.heading, 0, "YXZ");
          this.q.setFromEuler(this.e);
          const hx = c.pos.x + fx * (V.length / 2) + fz * side * V.width * 0.28;
          const hz = c.pos.z + fz * (V.length / 2) - fx * side * V.width * 0.28;
          this.m4.compose(this.v3.set(hx, c.variant === 2 ? 0.85 : 0.6, hz), this.q, one);
          this.beams.setMatrixAt(bi++, this.m4);
        }
        this.m4.compose(this.v3.set(c.pos.x + fx * 9, 0.04, c.pos.z + fz * 9), this.q.identity(), this.s.set(9, 1, 12));
        this.pools.setMatrixAt(pi++, this.m4);
      }
    }
    for (let v = 0; v < this.bodies.length; v++) {
      for (let i = counts[v]; i < this.capacity; i++) this.bodies[v].setMatrixAt(i, this.zero);
      this.bodies[v].count = this.capacity;
      this.bodies[v].instanceMatrix.needsUpdate = true;
      if (this.bodies[v].instanceColor) this.bodies[v].instanceColor!.needsUpdate = true;
      this.states[v].needsUpdate = true;
      this.neons[v].needsUpdate = true;
    }
    this.wheelNeon.needsUpdate = true;
    for (let i = wi; i < this.capacity * 4; i++) this.wheels.setMatrixAt(i, this.zero);
    for (let i = bi; i < this.capacity * 2; i++) this.beams.setMatrixAt(i, this.zero);
    for (let i = pi; i < this.capacity; i++) this.pools.setMatrixAt(i, this.zero);
    this.wheels.instanceMatrix.needsUpdate = true;
    if (this.wheels.instanceColor) this.wheels.instanceColor.needsUpdate = true;
    this.beams.instanceMatrix.needsUpdate = true;
    this.pools.instanceMatrix.needsUpdate = true;

    // The player's car gets a real headlight.
    if (this.headlight) {
      const pc = this.cars.find((c) => c.driver === "player" && !c.dead);
      if (pc) {
        const f = this.forward(pc);
        this.headlight.position.set(pc.pos.x + f.x * 2.4, 1.0, pc.pos.z + f.z * 2.4);
        this.headlight.target.position.set(pc.pos.x + f.x * 20, 0, pc.pos.z + f.z * 20);
        this.headlight.intensity = 40;
      } else this.headlight.intensity = 0;
    }
  }
}
