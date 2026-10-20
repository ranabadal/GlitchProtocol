import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { clamp, lerp } from "../mathx";

/*
 * People, built from primitives and animated in code.
 *   OperatorRig  - the player: long dark coat, visor and blaster glowing in the
 *                  colour of the avatar the player picked at sign-up.
 *   CrowdMeshes  - every pedestrian in the city drawn with six instanced meshes
 *                  (torso, head, two arms, two legs), so 40 people cost 6 draw calls.
 */

// ---------------------------------------------------------------- operator (player)

export interface OperatorPose {
  speed: number;       // horizontal speed m/s
  grounded: boolean;
  aim: number;         // 0..1 how much the gun is raised
  pitch: number;       // camera pitch, for aiming up/down
  recoil: number;      // 0..1
  hack: boolean;       // typing at a terminal
  dead: boolean;
  hurt: number;        // 0..1 flinch
}

function limb(len: number, r0: number, r1: number, mat: THREE.Material, seg = 8): { pivot: THREE.Group; mesh: THREE.Mesh } {
  const pivot = new THREE.Group();
  const g = new THREE.CylinderGeometry(r0, r1, len, seg, 1);
  g.translate(0, -len / 2, 0);
  const mesh = new THREE.Mesh(g, mat);
  mesh.castShadow = true;
  pivot.add(mesh);
  return { pivot, mesh };
}

export class OperatorRig {
  root = new THREE.Group();
  private body = new THREE.Group();
  private hips = new THREE.Group();
  private spine = new THREE.Group();
  private head = new THREE.Group();
  private armL: THREE.Group; private foreL: THREE.Group;
  private armR: THREE.Group; private foreR: THREE.Group;
  private legL: THREE.Group; private shinL: THREE.Group;
  private legR: THREE.Group; private shinR: THREE.Group;
  private flapL: THREE.Group; private flapR: THREE.Group;
  private gun = new THREE.Group();
  muzzle = new THREE.Object3D();
  private phase = 0;
  private air = 0;
  private deadT = 0;
  glowMat: THREE.MeshBasicMaterial;

  constructor(hue: number) {
    const glow = new THREE.Color().setHSL(hue / 360, 1, 0.55).multiplyScalar(2.2);
    this.glowMat = new THREE.MeshBasicMaterial({ color: glow, toneMapped: false });
    const coat = new THREE.MeshStandardMaterial({ color: 0x0a0c0f, roughness: 0.38, metalness: 0.35 });
    const cloth = new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.8 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xa8714f, roughness: 0.6 });
    const hair = new THREE.MeshStandardMaterial({ color: 0x0b0908, roughness: 0.9 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.3, metalness: 0.9 });

    this.root.add(this.body);
    this.body.add(this.hips);
    this.hips.position.y = 0.98;
    this.hips.add(this.spine);

    // Torso: coat body with trim.
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.17, 0.62, 10).translate(0, 0.31, 0).scale(1.15, 1, 0.75), coat);
    torso.castShadow = true;
    this.spine.add(torso);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.2, 0.14, 10, 1, true).translate(0, 0.62, 0).scale(1.1, 1, 0.8), coat);
    this.spine.add(collar);
    for (const x of [-0.07, 0.07]) {
      const trim = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.6, 0.01).translate(x, 0.31, 0.155), this.glowMat);
      this.spine.add(trim);
    }
    const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 10).scale(1.15, 1, 0.78).translate(0, 0.02, 0), metal);
    this.spine.add(belt);

    // Head.
    this.head.position.y = 0.7;
    this.spine.add(this.head);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 8).translate(0, 0.0, 0), skin);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.115, 14, 12).scale(0.92, 1.1, 1).translate(0, 0.14, 0.005), skin);
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.95, 1.05, 1.05).translate(0, 0.165, -0.008), hair);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.045, 0.06).translate(0, 0.16, 0.095), this.glowMat);
    skull.castShadow = true;
    this.head.add(neck, skull, hairCap, visor);

    // Arms.
    const mkArm = (side: number) => {
      const upper = limb(0.3, 0.055, 0.05, coat);
      upper.pivot.position.set(side * 0.24, 0.56, 0);
      const fore = limb(0.27, 0.048, 0.04, coat);
      fore.pivot.position.y = -0.3;
      upper.pivot.add(fore.pivot);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6).translate(0, -0.3, 0), skin);
      fore.pivot.add(hand);
      this.spine.add(upper.pivot);
      return [upper.pivot, fore.pivot] as const;
    };
    [this.armL, this.foreL] = mkArm(-1);
    [this.armR, this.foreR] = mkArm(1);

    // Legs.
    const mkLeg = (side: number) => {
      const thigh = limb(0.46, 0.08, 0.065, cloth);
      thigh.pivot.position.set(side * 0.1, 0, 0);
      const shin = limb(0.44, 0.062, 0.05, cloth);
      shin.pivot.position.y = -0.46;
      thigh.pivot.add(shin.pivot);
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.24).translate(0, -0.46, 0.05), metal);
      shin.pivot.add(boot);
      this.hips.add(thigh.pivot);
      return [thigh.pivot, shin.pivot] as const;
    };
    [this.legL, this.shinL] = mkLeg(-1);
    [this.legR, this.shinR] = mkLeg(1);

    // Coat tails that swing with the legs.
    const mkFlap = (side: number) => {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.1, 0.02, 0);
      const g = new THREE.BoxGeometry(0.2, 0.72, 0.03).translate(side * 0.02, -0.36, -0.02);
      const flap = new THREE.Mesh(g, coat);
      flap.castShadow = true;
      const edge = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.012, 0.035).translate(side * 0.02, -0.72, -0.02), this.glowMat);
      pivot.add(flap, edge);
      this.hips.add(pivot);
      return pivot;
    };
    this.flapL = mkFlap(-1);
    this.flapR = mkFlap(1);
    const backFlap = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.7, 0.03).translate(0, -0.35, -0.14), coat);
    this.hips.add(backFlap);

    // Blaster in the right hand.
    const gunBody = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.11, 0.42).translate(0, 0, 0.12), metal);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.26, 8).rotateX(Math.PI / 2).translate(0, 0.02, 0.44), metal);
    const cell = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.03, 0.2).translate(0, 0.065, 0.1), this.glowMat);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.13, 0.06).translate(0, -0.09, 0.0), metal);
    this.gun.add(gunBody, barrel, cell, grip);
    this.muzzle.position.set(0, 0.02, 0.6);
    this.gun.add(this.muzzle);
    this.gun.position.set(0, -0.3, 0.02);
    this.foreR.add(this.gun);

    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  }

  update(dt: number, p: OperatorPose): void {
    const run = clamp(p.speed / 9, 0, 1);
    const walk = clamp(p.speed / 2.5, 0, 1);
    this.phase += dt * (3.2 + p.speed * 1.05);
    this.air = p.grounded ? Math.max(0, this.air - dt * 6) : Math.min(1, this.air + dt * 5);
    const s = Math.sin(this.phase), c = Math.cos(this.phase);

    if (p.dead) {
      this.deadT = Math.min(1, this.deadT + dt * 2.2);
      this.body.rotation.x = lerp(0, -Math.PI / 2, this.deadT * this.deadT);
      this.body.position.y = lerp(0, 0.18, this.deadT);
      this.armL.rotation.x = this.armR.rotation.x = lerp(this.armR.rotation.x, -2.6, this.deadT);
      return;
    }
    this.deadT = 0;
    this.body.rotation.x = 0;
    this.body.position.y = 0;

    // Legs.
    const swing = (0.35 + run * 0.45) * walk * (1 - this.air);
    this.legL.rotation.x = s * swing - this.air * 0.6;
    this.legR.rotation.x = -s * swing + this.air * 0.2;
    this.shinL.rotation.x = Math.max(0, -c) * swing * 1.4 + this.air * 1.0;
    this.shinR.rotation.x = Math.max(0, c) * swing * 1.4 + this.air * 0.5;
    this.flapL.rotation.x = Math.min(this.legL.rotation.x, 0) * 0.8 - run * 0.35 - this.air * 0.4;
    this.flapR.rotation.x = Math.min(this.legR.rotation.x, 0) * 0.8 - run * 0.35 - this.air * 0.4;
    this.hips.position.y = 0.98 + Math.abs(c) * 0.04 * walk - this.air * 0.04;
    this.spine.rotation.x = run * 0.18 * (1 - p.aim) + p.hurt * -0.2;
    this.spine.rotation.y = Math.sin(this.phase) * 0.08 * walk * (1 - p.aim);

    // Arms: swing while moving, raise the blaster when aiming or firing.
    const armSwing = (0.3 + run * 0.6) * walk;
    const aim = p.hack ? 0 : p.aim;
    this.armL.rotation.set(lerp(-s * armSwing, -1.25 - p.pitch * 0.9, aim), 0, lerp(0.08, -0.55, aim));
    this.foreL.rotation.x = lerp(-0.25 - run * 0.9, -0.55, aim);
    this.armR.rotation.set(lerp(s * armSwing * 0.6 - 0.15, -1.45 - p.pitch + p.recoil * 0.15, aim), 0, lerp(-0.08, 0.05, aim));
    this.foreR.rotation.x = lerp(-0.6 - run * 0.6, -0.1, aim);
    this.gun.rotation.x = lerp(1.2, 1.57, aim);
    if (p.hack) {
      const tap = Math.sin(this.phase * 3);
      this.armL.rotation.set(-0.9 + tap * 0.05, 0, -0.2);
      this.armR.rotation.set(-0.9 - tap * 0.05, 0, 0.2);
      this.foreL.rotation.x = this.foreR.rotation.x = -0.6;
    }
    this.head.rotation.x = -p.pitch * 0.5 * aim;
  }
}

// ---------------------------------------------------------------- crowd

export interface PedPose {
  x: number; y: number; z: number;
  yaw: number;
  phase: number;
  speed: number;
  /** 0..1 dive-to-the-side animation (dodging a car). */
  dive: number;
  diveSide: number;
  /** 0..1 cowering with hands on head (robots nearby). */
  cower: number;
  /** 0..1 arms up, hopping (city saved). */
  cheer: number;
  visible: boolean;
}

const SHIRTS = [0x2a6f97, 0x9a2f4f, 0xc9a227, 0x3a3f47, 0x5b3b8c, 0x2f8f6f, 0xb85c38, 0x1f2a44, 0x8c8c8c, 0x7a1f2b, 0x115e59, 0xd1d5db];
const PANTS = [0x1c1f26, 0x2b2f3a, 0x3b3426, 0x14213d, 0x22252b, 0x4a4e57];
const SKIN = [0x8d5524, 0xa8714f, 0xc68642, 0xe0ac69, 0x6b4226, 0xb5835a];

function coloured(g: THREE.BufferGeometry, rgb: [number, number, number], glow = 0): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute("uv");
  const n = ng.getAttribute("position").count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set(rgb, i * 3);
  ng.setAttribute("color", new THREE.BufferAttribute(col, 3));
  ng.setAttribute("aGlow", new THREE.BufferAttribute(new Float32Array(n).fill(glow), 1));
  return ng;
}

function crowdMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05 });
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aGlow; varying float vGlow;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGlow = aGlow;");
    s.fragmentShader = s.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vGlow;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow * 2.5;");
  };
  m.customProgramCacheKey = () => "gp-crowd";
  return m;
}

export class CrowdMeshes {
  group = new THREE.Group();
  private torso: THREE.InstancedMesh;
  private head: THREE.InstancedMesh;
  private armL: THREE.InstancedMesh;
  private armR: THREE.InstancedMesh;
  private legL: THREE.InstancedMesh;
  private legR: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private base = new THREE.Matrix4();
  private local = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(public count: number, seed: () => number) {
    const mat = crowdMaterial();
    const torsoGeo = mergeGeometries([
      coloured(new THREE.CylinderGeometry(0.19, 0.16, 0.6, 8).scale(1.1, 1, 0.7).translate(0, 0.3, 0), [1, 1, 1]),
      coloured(new THREE.CylinderGeometry(0.165, 0.17, 0.16, 8).scale(1.1, 1, 0.75).translate(0, -0.06, 0), [0.35, 0.35, 0.38]),
      coloured(new THREE.BoxGeometry(0.36, 0.02, 0.24).translate(0, 0.44, 0), [1, 1, 1], 1),
    ])!;
    const headGeo = mergeGeometries([
      coloured(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 6).translate(0, -0.05, 0), [1, 1, 1]),
      coloured(new THREE.SphereGeometry(0.11, 10, 8).scale(0.92, 1.1, 1).translate(0, 0.08, 0), [1, 1, 1]),
      coloured(new THREE.SphereGeometry(0.118, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5).scale(0.95, 1.05, 1.05).translate(0, 0.11, -0.01), [0.08, 0.06, 0.05]),
    ])!;
    const armGeo = mergeGeometries([
      coloured(new THREE.CylinderGeometry(0.05, 0.042, 0.56, 6).translate(0, -0.28, 0), [1, 1, 1]),
      coloured(new THREE.SphereGeometry(0.043, 6, 4).translate(0, -0.58, 0), [0.75, 0.55, 0.42]),
    ])!;
    const legGeo = mergeGeometries([
      coloured(new THREE.CylinderGeometry(0.075, 0.055, 0.88, 6).translate(0, -0.44, 0), [1, 1, 1]),
      coloured(new THREE.BoxGeometry(0.1, 0.07, 0.22).translate(0, -0.89, 0.04), [0.15, 0.15, 0.16]),
    ])!;
    const mk = (g: THREE.BufferGeometry) => {
      const im = new THREE.InstancedMesh(g, mat, count);
      im.frustumCulled = false;
      im.castShadow = true;
      this.group.add(im);
      return im;
    };
    this.torso = mk(torsoGeo);
    this.head = mk(headGeo);
    this.armL = mk(armGeo);
    this.armR = mk(armGeo);
    this.legL = mk(legGeo);
    this.legR = mk(legGeo);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const shirt = c.setHex(SHIRTS[Math.floor(seed() * SHIRTS.length)]).clone();
      this.torso.setColorAt(i, shirt);
      this.armL.setColorAt(i, shirt);
      this.armR.setColorAt(i, shirt);
      const pants = c.setHex(PANTS[Math.floor(seed() * PANTS.length)]).clone();
      this.legL.setColorAt(i, pants);
      this.legR.setColorAt(i, pants);
      this.head.setColorAt(i, c.setHex(SKIN[Math.floor(seed() * SKIN.length)]).clone());
    }
  }

  private put(im: THREE.InstancedMesh, i: number, x: number, y: number, z: number, rx: number, rz = 0): void {
    this.e.set(rx, 0, rz);
    this.q.setFromEuler(this.e);
    this.local.compose(this.v.set(x, y, z), this.q, this.one);
    this.m.multiplyMatrices(this.base, this.local);
    im.setMatrixAt(i, this.m);
  }

  setPose(i: number, p: PedPose): void {
    if (!p.visible) {
      for (const im of [this.torso, this.head, this.armL, this.armR, this.legL, this.legR]) im.setMatrixAt(i, this.zero);
      return;
    }
    // Base: position + yaw, then the dive rolls the whole body sideways.
    this.e.set(0, p.yaw, 0);
    this.q.setFromEuler(this.e);
    this.base.compose(this.v.set(p.x, p.y, p.z), this.q, this.one);
    if (p.dive > 0) {
      const roll = Math.sin(Math.min(1, p.dive) * Math.PI * 0.5) * 1.35 * p.diveSide;
      this.local.makeRotationZ(-roll);
      this.base.multiply(this.local);
    }
    const walk = clamp(p.speed / 1.6, 0, 1);
    const run = clamp((p.speed - 2) / 3, 0, 1);
    const s = Math.sin(p.phase);
    const swing = (0.35 + run * 0.4) * walk;
    const bob = Math.abs(Math.cos(p.phase)) * 0.035 * walk;
    const lean = run * 0.2 + p.cower * 0.35;
    this.put(this.torso, i, 0, 0.95 + bob - p.cower * 0.25, 0, lean);
    this.put(this.head, i, 0, 1.53 + bob - p.cower * 0.32, Math.sin(lean) * 0.6 * 0.95 + p.cower * 0.05, lean * 0.5);
    if (p.cheer > 0.5) {
      const hop = Math.abs(Math.sin(p.phase * 1.5)) * 0.25;
      this.base.multiply(this.local.makeTranslation(0, hop, 0));
      this.put(this.torso, i, 0, 0.95, 0, 0);
      this.put(this.head, i, 0, 1.53, 0, -0.2);
      this.put(this.armL, i, -0.22, 1.39, 0, Math.PI - 0.3 + Math.sin(p.phase * 3) * 0.3, 0.3);
      this.put(this.armR, i, 0.22, 1.39, 0, Math.PI - 0.3 - Math.sin(p.phase * 3) * 0.3, -0.3);
      this.put(this.legL, i, -0.09, 0.91, 0, 0);
      this.put(this.legR, i, 0.09, 0.91, 0, 0);
      return;
    }
    if (p.cower > 0.5) {
      this.put(this.armL, i, -0.22, 1.39 - p.cower * 0.3, 0.1, -2.6, -0.4);
      this.put(this.armR, i, 0.22, 1.39 - p.cower * 0.3, 0.1, -2.6, 0.4);
    } else {
      this.put(this.armL, i, -0.22, 1.39 + bob, 0, -s * swing * 1.1 + run * -0.4, 0.06);
      this.put(this.armR, i, 0.22, 1.39 + bob, 0, s * swing * 1.1 + run * -0.4, -0.06);
    }
    this.put(this.legL, i, -0.09, 0.91 + bob - p.cower * 0.2, 0, s * swing - p.cower * 0.9);
    this.put(this.legR, i, 0.09, 0.91 + bob - p.cower * 0.2, 0, -s * swing - p.cower * 0.9);
  }

  commit(): void {
    for (const im of [this.torso, this.head, this.armL, this.armR, this.legL, this.legR]) im.instanceMatrix.needsUpdate = true;
  }
}
