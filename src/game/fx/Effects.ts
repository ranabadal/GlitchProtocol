import * as THREE from "three";
import { radialTexture } from "../world/Textures";

/*
 * Pooled visual effects: sparks, fireballs, smoke, debris, laser tracers, shock rings
 * and a flash light. All pools are fixed-size, so a big firefight never allocates.
 */

const MAX_P = 1800;
const MAX_TRACERS = 48;
const MAX_RINGS = 10;
const MAX_DEBRIS = 120;

class ParticlePool {
  points: THREE.Points;
  private pos = new Float32Array(MAX_P * 3);
  private col = new Float32Array(MAX_P * 3);
  private size = new Float32Array(MAX_P);
  private alpha = new Float32Array(MAX_P);
  private vel = new Float32Array(MAX_P * 3);
  private life = new Float32Array(MAX_P);
  private maxLife = new Float32Array(MAX_P);
  private grow = new Float32Array(MAX_P);
  private drag = new Float32Array(MAX_P);
  private gravity = new Float32Array(MAX_P);
  private baseSize = new Float32Array(MAX_P);
  private next = 0;
  private geo = new THREE.BufferGeometry();

  constructor(additive: boolean, sizeScale: { value: number }) {
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uMap: { value: radialTexture() }, uScale: sizeScale },
      vertexShader: /* glsl */ `
        attribute vec3 aColor; attribute float aSize; attribute float aAlpha; uniform float uScale;
        varying vec3 vColor; varying float vAlpha;
        void main(){ vColor = aColor; vAlpha = aAlpha; vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale * (300.0 / max(-mv.z, 0.5)); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap; varying vec3 vColor; varying float vAlpha;
        void main(){ float a = texture2D(uMap, gl_PointCoord).a; gl_FragColor = vec4(vColor * ${additive ? "a * vAlpha" : "1.0"}, ${additive ? "1.0" : "a * vAlpha"}); }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, size: number, life: number, opts: { grow?: number; drag?: number; gravity?: number } = {}): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX_P;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([r, g, b], i * 3);
    this.baseSize[i] = size;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.alpha[i] = 1;
    this.grow[i] = opts.grow ?? 0;
    this.drag[i] = opts.drag ?? 1.5;
    this.gravity[i] = opts.gravity ?? 0;
  }

  update(dt: number): void {
    for (let i = 0; i < MAX_P; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const k = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.gravity[i] * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < 0.05) { this.pos[i * 3 + 1] = 0.05; this.vel[i * 3 + 1] *= -0.3; }
      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      this.alpha[i] = t;
      this.size[i] = this.baseSize[i] * (1 + this.grow[i] * (1 - t));
    }
    for (const n of ["position", "aColor", "aSize", "aAlpha"]) (this.geo.getAttribute(n) as THREE.BufferAttribute).needsUpdate = true;
  }
}

export class Effects {
  group = new THREE.Group();
  private sizeScale = { value: 1 };
  private glow: ParticlePool;
  private smoke: ParticlePool;
  private tracers: THREE.InstancedMesh;
  private tracerLife = new Float32Array(MAX_TRACERS);
  private tracerData: { from: THREE.Vector3; to: THREE.Vector3; color: THREE.Color; width: number }[] = [];
  private tracerNext = 0;
  private rings: { mesh: THREE.Mesh; life: number; max: number; radius: number }[] = [];
  private debris: THREE.InstancedMesh;
  private debrisState: { p: THREE.Vector3; v: THREE.Vector3; r: THREE.Euler; w: THREE.Vector3; life: number }[] = [];
  private debrisNext = 0;
  private flash: THREE.PointLight | null;
  private flashLife = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();

  constructor(withLights: boolean) {
    this.glow = new ParticlePool(true, this.sizeScale);
    this.smoke = new ParticlePool(false, this.sizeScale);
    this.group.add(this.smoke.points, this.glow.points);

    const tg = new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
    this.tracers = new THREE.InstancedMesh(tg, new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), MAX_TRACERS);
    this.tracers.frustumCulled = false;
    for (let i = 0; i < MAX_TRACERS; i++) {
      this.tracerData.push({ from: new THREE.Vector3(), to: new THREE.Vector3(), color: new THREE.Color(), width: 0.05 });
      this.tracers.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
      this.tracers.setColorAt(i, new THREE.Color(0, 0, 0));
    }
    this.group.add(this.tracers);

    for (let i = 0; i < MAX_RINGS; i++) {
      const mesh = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
      mesh.visible = false;
      this.rings.push({ mesh, life: 0, max: 1, radius: 1 });
      this.group.add(mesh);
    }

    this.debris = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 0.25, 0.25), new THREE.MeshStandardMaterial({ color: 0x2a2f36, metalness: 0.8, roughness: 0.4, emissive: 0xff3311, emissiveIntensity: 0.6 }), MAX_DEBRIS);
    this.debris.frustumCulled = false;
    for (let i = 0; i < MAX_DEBRIS; i++) {
      this.debrisState.push({ p: new THREE.Vector3(0, -100, 0), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3(), life: 0 });
      this.debris.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
    }
    this.group.add(this.debris);

    this.flash = withLights ? new THREE.PointLight(0xff6a33, 0, 40, 2) : null;
    if (this.flash) this.group.add(this.flash);
  }

  setPixelScale(s: number): void {
    this.sizeScale.value = s;
  }

  sparks(p: THREE.Vector3, n: THREE.Vector3 | null, color: THREE.Color, count = 10, speed = 8): void {
    for (let i = 0; i < count; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize();
      if (n) dir.add(n.clone().multiplyScalar(1.2)).normalize();
      const s = speed * (0.4 + Math.random());
      this.glow.spawn(p.x, p.y, p.z, dir.x * s, dir.y * s + 2, dir.z * s, color.r * 3, color.g * 3, color.b * 3, 0.12 + Math.random() * 0.1, 0.25 + Math.random() * 0.35, { drag: 2.5, gravity: 14 });
    }
  }

  explosion(p: THREE.Vector3, scale = 1, color = new THREE.Color(1, 0.45, 0.15)): void {
    for (let i = 0; i < 26 * scale; i++) {
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(4 + Math.random() * 7 * scale);
      this.glow.spawn(p.x, p.y, p.z, d.x, d.y, d.z, color.r * 4, color.g * 4, color.b * 4, 0.9 * scale, 0.35 + Math.random() * 0.35, { grow: 2.5, drag: 4, gravity: -1 });
    }
    for (let i = 0; i < 14 * scale; i++) {
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random(), Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 3);
      const g = 0.08 + Math.random() * 0.06;
      this.smoke.spawn(p.x, p.y + 0.5, p.z, d.x, d.y + 1.5, d.z, g, g, g * 1.1, 1.4 * scale, 1.6 + Math.random() * 1.2, { grow: 2.5, drag: 1.2, gravity: -1.2 });
    }
    this.sparks(p, null, new THREE.Color(1, 0.7, 0.3), Math.round(30 * scale), 14);
    for (let i = 0; i < 10 * scale; i++) {
      const s = this.debrisState[this.debrisNext];
      this.debrisNext = (this.debrisNext + 1) % MAX_DEBRIS;
      s.p.copy(p);
      s.v.set((Math.random() - 0.5) * 12, 5 + Math.random() * 8, (Math.random() - 0.5) * 12);
      s.w.set(Math.random() * 10, Math.random() * 10, Math.random() * 10);
      s.life = 2.5 + Math.random();
    }
    this.ring(p, 6 * scale, color);
    if (this.flash) {
      this.flash.position.copy(p).add(new THREE.Vector3(0, 2, 0));
      this.flash.intensity = 60 * scale;
      this.flash.color.copy(color);
      this.flashLife = 0.35;
    }
  }

  ring(p: THREE.Vector3, radius: number, color: THREE.Color, life = 0.5): void {
    const r = this.rings.find((x) => x.life <= 0) ?? this.rings[0];
    r.life = life;
    r.max = life;
    r.radius = radius;
    r.mesh.position.set(p.x, Math.max(0.15, p.y - 0.5), p.z);
    (r.mesh.material as THREE.MeshBasicMaterial).color.copy(color).multiplyScalar(2.5);
    r.mesh.visible = true;
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color, width = 0.06, life = 0.09): void {
    const i = this.tracerNext;
    this.tracerNext = (this.tracerNext + 1) % MAX_TRACERS;
    const d = this.tracerData[i];
    d.from.copy(from);
    d.to.copy(to);
    d.color.copy(color);
    d.width = width;
    this.tracerLife[i] = life;
  }

  muzzle(p: THREE.Vector3, color: THREE.Color): void {
    for (let i = 0; i < 4; i++) this.glow.spawn(p.x, p.y, p.z, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, color.r * 4, color.g * 4, color.b * 4, 0.35, 0.06);
  }

  /** Column of code particles where a robot teleports in. */
  materialize(p: THREE.Vector3, color = new THREE.Color(1, 0.15, 0.25)): void {
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 1.2;
      this.glow.spawn(p.x + Math.cos(a) * r, Math.random() * 4, p.z + Math.sin(a) * r, 0, 2 + Math.random() * 4, 0, color.r * 3, color.g * 3, color.b * 3, 0.18, 0.6 + Math.random() * 0.6, { drag: 0.5 });
    }
    this.ring(p, 3, color, 0.6);
  }

  /** Burst of green data when a core is collected. */
  dataBurst(p: THREE.Vector3): void {
    for (let i = 0; i < 60; i++) {
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.5 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(3 + Math.random() * 6);
      this.glow.spawn(p.x, p.y, p.z, d.x, d.y, d.z, 0.6, 3, 1.4, 0.2, 0.8 + Math.random() * 0.6, { drag: 1.5, gravity: -2 });
    }
    this.ring(p, 5, new THREE.Color(0.2, 1, 0.6), 0.7);
  }

  smokePuff(p: THREE.Vector3, dark = 0.06): void {
    this.smoke.spawn(p.x, p.y, p.z, (Math.random() - 0.5) * 0.6, 1.5 + Math.random(), (Math.random() - 0.5) * 0.6, dark, dark, dark, 0.8, 1.4, { grow: 2, drag: 0.6, gravity: -0.6 });
  }

  update(dt: number): void {
    this.glow.update(dt);
    this.smoke.update(dt);
    for (let i = 0; i < MAX_TRACERS; i++) {
      if (this.tracerLife[i] <= 0) continue;
      this.tracerLife[i] -= dt;
      const d = this.tracerData[i];
      if (this.tracerLife[i] <= 0) { this.tracers.setMatrixAt(i, this.m4.makeScale(0, 0, 0)); continue; }
      const len = d.from.distanceTo(d.to);
      this.v.subVectors(d.to, d.from).normalize();
      this.q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.v);
      const w = d.width * (0.5 + this.tracerLife[i] * 8);
      this.m4.compose(d.from, this.q, new THREE.Vector3(w, w, len));
      this.tracers.setMatrixAt(i, this.m4);
      this.tracers.setColorAt(i, d.color.clone().multiplyScalar(3 * Math.min(1, this.tracerLife[i] * 15)));
    }
    this.tracers.instanceMatrix.needsUpdate = true;
    if (this.tracers.instanceColor) this.tracers.instanceColor.needsUpdate = true;
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      const t = 1 - r.life / r.max;
      r.mesh.scale.setScalar(0.5 + r.radius * t);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - t;
      if (r.life <= 0) r.mesh.visible = false;
    }
    let anyDebris = false;
    for (let i = 0; i < MAX_DEBRIS; i++) {
      const s = this.debrisState[i];
      if (s.life <= 0) continue;
      anyDebris = true;
      s.life -= dt;
      s.v.y -= 20 * dt;
      s.p.addScaledVector(s.v, dt);
      if (s.p.y < 0.12) { s.p.y = 0.12; s.v.y *= -0.35; s.v.x *= 0.7; s.v.z *= 0.7; s.w.multiplyScalar(0.7); }
      s.r.x += s.w.x * dt; s.r.y += s.w.y * dt; s.r.z += s.w.z * dt;
      const sc = s.life > 0 ? Math.min(1, s.life) : 0;
      this.m4.compose(s.p, this.q.setFromEuler(s.r), new THREE.Vector3(sc, sc, sc));
      this.debris.setMatrixAt(i, this.m4);
    }
    if (anyDebris) this.debris.instanceMatrix.needsUpdate = true;
    if (this.flash && this.flashLife > 0) {
      this.flashLife -= dt;
      this.flash.intensity = Math.max(0, this.flash.intensity * (1 - dt * 9));
      if (this.flashLife <= 0) this.flash.intensity = 0;
    }
  }
}
