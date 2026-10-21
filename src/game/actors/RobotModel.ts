import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";

/*
 * NULL's robots. Walkers and brutes use the CC0 "RobotExpressive" model (Tomás Laulhé,
 * modified by Don McCurdy), recoloured as dark chrome with a glowing face. The model's
 * 20 separate parts are merged into ONE skinned mesh, so each robot costs one draw call.
 * Drones and turrets are built from primitives in code.
 *
 * Every robot gets its own small material (same shader program) for hit flashes and
 * the "materialise from code" dissolve effect.
 */

export type RobotAnim = "idle" | "walk" | "run" | "fire" | "die";
const CLIP: Record<RobotAnim, string> = { idle: "Idle", walk: "Walking", run: "Running", fire: "Punch", die: "Death" };
const MODEL_HEIGHT = 4.77;

export interface RobotTemplate {
  root: THREE.Object3D;
  clips: Map<string, THREE.AnimationClip>;
}

const ROLE: Record<string, number> = { Grey: 0, Main: 1, Black: 2 };

/** Merge every mesh part into one SkinnedMesh driven by the original bones. Exported for tests. */
export function mergeRobot(scene: THREE.Object3D): THREE.Object3D {
  scene.position.set(0, 0, 0);
  scene.rotation.set(0, 0, 0);
  scene.scale.set(1, 1, 1);
  scene.updateMatrixWorld(true);
  const bones: THREE.Bone[] = [];
  scene.traverse((o) => { if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone); });
  const boneIndex = new Map(bones.map((b, i) => [b, i]));

  const meshes: THREE.Mesh[] = [];
  scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  const parts: THREE.BufferGeometry[] = [];
  const v = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const m4 = new THREE.Matrix4();
  const n3 = new THREE.Matrix3();

  for (const mesh of meshes) {
    const src = mesh.geometry;
    const pos = src.getAttribute("position");
    const nor = src.getAttribute("normal");
    const count = pos.count;
    const P = new Float32Array(count * 3);
    const N = new Float32Array(count * 3);
    const R = new Float32Array(count).fill(ROLE[(mesh.material as THREE.Material).name] ?? 1);
    const SI = new Uint16Array(count * 4);
    const SW = new Float32Array(count * 4);
    const sm = mesh as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh) {
      const si = src.getAttribute("skinIndex");
      const sw = src.getAttribute("skinWeight");
      for (let i = 0; i < count; i++) {
        v.fromBufferAttribute(pos, i);
        sm.applyBoneTransform(i, v);
        v.applyMatrix4(sm.matrixWorld);
        P.set([v.x, v.y, v.z], i * 3);
        // Normal: use the bone with the largest weight.
        let best = 0, bw = -1;
        for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
        const bone = sm.skeleton.bones[best];
        m4.multiplyMatrices(bone.matrixWorld, sm.skeleton.boneInverses[best]).premultiply(sm.bindMatrixInverse).premultiply(sm.matrixWorld).multiply(sm.bindMatrix);
        nrm.fromBufferAttribute(nor, i).applyMatrix3(n3.getNormalMatrix(m4)).normalize();
        N.set([nrm.x, nrm.y, nrm.z], i * 3);
        for (let k = 0; k < 4; k++) {
          SI[i * 4 + k] = boneIndex.get(sm.skeleton.bones[si.getComponent(i, k)]) ?? 0;
          SW[i * 4 + k] = sw.getComponent(i, k);
        }
      }
    } else {
      let parent: THREE.Object3D | null = mesh.parent;
      while (parent && !(parent as THREE.Bone).isBone) parent = parent.parent;
      const bi = parent ? boneIndex.get(parent as THREE.Bone) ?? 0 : 0;
      n3.getNormalMatrix(mesh.matrixWorld);
      for (let i = 0; i < count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        P.set([v.x, v.y, v.z], i * 3);
        nrm.fromBufferAttribute(nor, i).applyMatrix3(n3).normalize();
        N.set([nrm.x, nrm.y, nrm.z], i * 3);
        SI[i * 4] = bi;
        SW[i * 4] = 1;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(P, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(N, 3));
    g.setAttribute("aRole", new THREE.BufferAttribute(R, 1));
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(SI, 4));
    g.setAttribute("skinWeight", new THREE.BufferAttribute(SW, 4));
    if (src.index) g.setIndex(src.index.clone());
    parts.push(g);
  }
  const anyUnindexed = parts.some((p) => !p.index);
  const merged = mergeGeometries(anyUnindexed ? parts.map((p) => (p.index ? p.toNonIndexed() : p)) : parts);
  if (!merged) throw new Error("robot merge failed");
  merged.computeBoundingSphere();

  for (const mesh of meshes) mesh.removeFromParent();
  const inverses = bones.map((b) => b.matrixWorld.clone().invert());
  const skeleton = new THREE.Skeleton(bones, inverses);
  const skinned = new THREE.SkinnedMesh(merged, new THREE.MeshStandardMaterial());
  skinned.name = "robot-body";
  skinned.frustumCulled = false;
  scene.add(skinned);
  skinned.updateMatrixWorld(true);
  skinned.bind(skeleton, new THREE.Matrix4());
  // Drop now-empty groups left behind by the old part meshes.
  const empty: THREE.Object3D[] = [];
  scene.traverse((o) => { if (o.type === "Group" && o.children.length === 0 && o !== scene) empty.push(o); });
  for (const o of empty) o.removeFromParent();
  return scene;
}

export async function loadRobotTemplate(url = "/models/robot.glb"): Promise<RobotTemplate | null> {
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    const root = mergeRobot(gltf.scene);
    const names = new Set<string>();
    root.traverse((o) => names.add(o.name));
    const clips = new Map<string, THREE.AnimationClip>();
    for (const c of gltf.animations) {
      // Keep only tracks whose target still exists (the face morphs were merged away).
      const tracks = c.tracks.filter((t) => names.has(t.name.split(".")[0]) && !t.name.includes("morphTarget"));
      clips.set(c.name, new THREE.AnimationClip(c.name, c.duration, tracks));
    }
    return { root, clips };
  } catch (err) {
    console.warn("[glitch] robot model failed to load, using built-in robots", err);
    return null;
  }
}

// ---------------------------------------------------------------- materials

export interface RobotLook {
  main: THREE.Color;
  grey: THREE.Color;
  glow: THREE.Color;
}

export const LOOKS: Record<"walker" | "brute" | "titan", RobotLook> = {
  walker: { main: new THREE.Color(0.05, 0.055, 0.065), grey: new THREE.Color(0.22, 0.24, 0.27), glow: new THREE.Color(1.0, 0.08, 0.18) },
  brute: { main: new THREE.Color(0.12, 0.03, 0.035), grey: new THREE.Color(0.08, 0.08, 0.09), glow: new THREE.Color(1.0, 0.45, 0.05) },
  titan: { main: new THREE.Color(0.09, 0.02, 0.12), grey: new THREE.Color(0.16, 0.15, 0.2), glow: new THREE.Color(1.0, 0.1, 0.85) },
};

export interface FxUniforms {
  uFlash: { value: number };
  uDissolve: { value: number };
  uGlow: { value: THREE.Color };
  uTime: { value: number };
}

/** Per-robot material: role colours (body/joints/face), hit flash and a bottom-up digital dissolve. */
export function robotMaterial(look: RobotLook, uTime: { value: number }, skinned: boolean): THREE.MeshStandardMaterial & { userData: { fx: FxUniforms } } {
  const fx: FxUniforms = { uFlash: { value: 0 }, uDissolve: { value: 0 }, uGlow: { value: look.glow.clone() }, uTime };
  const m = new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0.85, color: 0xffffff });
  m.userData.fx = fx;
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, fx, { uMain: { value: look.main }, uGrey: { value: look.grey } });
    s.vertexShader = s.vertexShader
      .replace("#include <common>", `#include <common>
        attribute float aRole; varying float vRole; varying vec3 vGpLocal;`)
      .replace(skinned ? "#include <skinning_vertex>" : "#include <begin_vertex>", `${skinned ? "#include <skinning_vertex>" : "#include <begin_vertex>"}
        vRole = aRole; vGpLocal = transformed;`);
    s.fragmentShader = s.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform float uFlash; uniform float uDissolve; uniform vec3 uGlow; uniform float uTime; uniform vec3 uMain; uniform vec3 uGrey;
        varying float vRole; varying vec3 vGpLocal;
        float gpRh(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        float gpH = ${skinned ? `vGpLocal.y / ${MODEL_HEIGHT.toFixed(2)}` : "(vGpLocal.y + 0.8) / 3.4"};
        float gpN = gpRh(floor(vGpLocal * ${skinned ? "6.0" : "12.0"}));
        float gpCut = uDissolve * 1.25 - 0.1;
        if (gpH + gpN * 0.15 < gpCut - 0.08) discard;
        vec3 gpBase = vRole < 0.5 ? uGrey : (vRole < 1.5 ? uMain : vec3(0.02));
        diffuseColor.rgb = gpBase;`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        float gpFace = step(1.5, vRole);
        float gpPulse = 0.8 + 0.2 * sin(uTime * 6.0);
        totalEmissiveRadiance += uGlow * gpFace * 3.0 * gpPulse;
        totalEmissiveRadiance += uGlow * (1.0 - gpFace) * 0.05;
        totalEmissiveRadiance += vec3(1.0, 0.9, 0.9) * uFlash * 1.6;
        float gpEdge = smoothstep(0.1, 0.0, abs(gpH + gpN * 0.15 - gpCut)) * step(0.001, uDissolve);
        totalEmissiveRadiance += vec3(0.3, 1.0, 0.5) * gpEdge * 4.0;`);
  };
  m.customProgramCacheKey = () => (skinned ? "gp-robot-skinned" : "gp-robot-rigid");
  return m as THREE.MeshStandardMaterial & { userData: { fx: FxUniforms } };
}

// ---------------------------------------------------------------- walker / brute visual

export interface RobotVisual {
  object: THREE.Object3D;
  fx: FxUniforms;
  play(anim: RobotAnim, speed?: number): void;
  update(dt: number): void;
  /** World position of the gun hand, for muzzle flashes. */
  muzzle(out: THREE.Vector3): THREE.Vector3;
  dispose(): void;
}

class SkinnedRobot implements RobotVisual {
  object = new THREE.Group();
  fx: FxUniforms;
  private mixer: THREE.AnimationMixer;
  private actions = new Map<RobotAnim, THREE.AnimationAction>();
  private current: RobotAnim | null = null;
  private hand: THREE.Object3D | null = null;
  private mat: THREE.MeshStandardMaterial;

  constructor(t: RobotTemplate, look: RobotLook, height: number, uTime: { value: number }) {
    const root = SkeletonUtils.clone(t.root);
    root.scale.setScalar(height / MODEL_HEIGHT);
    this.object.add(root);
    const mat = robotMaterial(look, uTime, true);
    this.mat = mat;
    this.fx = mat.userData.fx;
    root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) { (o as THREE.SkinnedMesh).material = mat; o.castShadow = true; }
      if (o.name === "LowerArmR") this.hand = o;
    });
    this.mixer = new THREE.AnimationMixer(root);
    for (const k of Object.keys(CLIP) as RobotAnim[]) {
      const clip = t.clips.get(CLIP[k]);
      if (!clip) continue;
      const a = this.mixer.clipAction(clip);
      if (k === "die") { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      if (k === "fire") { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = false; }
      this.actions.set(k, a);
    }
    this.play("idle");
    this.mixer.setTime(Math.random() * 2);
  }

  play(anim: RobotAnim, speed = 1): void {
    const next = this.actions.get(anim);
    if (!next) return;
    next.timeScale = speed;
    if (this.current === anim && anim !== "fire") return;
    const prev = this.current ? this.actions.get(this.current) : null;
    next.reset().play();
    if (prev && prev !== next) next.crossFadeFrom(prev, anim === "fire" ? 0.08 : 0.25, false);
    this.current = anim;
    if (anim === "fire") {
      const back = () => { this.mixer.removeEventListener("finished", back); if (this.current === "fire") this.play("idle"); };
      this.mixer.addEventListener("finished", back);
    }
  }

  update(dt: number): void {
    this.mixer.update(dt);
  }

  muzzle(out: THREE.Vector3): THREE.Vector3 {
    if (this.hand) return this.hand.getWorldPosition(out);
    return this.object.getWorldPosition(out).add(new THREE.Vector3(0, 1.4, 0));
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mat.dispose();
  }
}

/** Built-in blocky robot, used only if the model file cannot be loaded. */
class BlockRobot implements RobotVisual {
  object = new THREE.Group();
  fx: FxUniforms;
  private legs: THREE.Mesh[] = [];
  private arm: THREE.Mesh;
  private t = 0;
  private anim: RobotAnim = "idle";
  private speed = 1;
  private mat: THREE.MeshStandardMaterial;

  constructor(look: RobotLook, height: number, uTime: { value: number }) {
    const mat = robotMaterial(look, uTime, false);
    this.mat = mat;
    this.fx = mat.userData.fx;
    const part = (w: number, h: number, d: number, role: number, x: number, y: number, z: number) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.setAttribute("aRole", new THREE.BufferAttribute(new Float32Array(g.getAttribute("position").count).fill(role), 1));
      const m = new THREE.Mesh(g, mat);
      m.position.set(x, y, z);
      return m;
    };
    const s = height / 2.2;
    const body = new THREE.Group();
    body.scale.setScalar(s);
    body.add(part(0.8, 0.8, 0.5, 1, 0, 1.25, 0), part(0.55, 0.45, 0.5, 0, 0, 1.9, 0), part(0.45, 0.12, 0.05, 2, 0, 1.92, 0.26));
    for (const x of [-0.22, 0.22]) {
      const leg = part(0.22, 0.85, 0.25, 0, x, 0.42, 0);
      leg.geometry.translate(0, -0.42, 0);
      leg.position.y = 0.85;
      this.legs.push(leg);
      body.add(leg);
    }
    this.arm = part(0.18, 0.7, 0.18, 1, 0.52, 1.3, 0);
    body.add(this.arm, part(0.18, 0.7, 0.18, 1, -0.52, 1.3, 0));
    this.object.add(body);
  }

  play(anim: RobotAnim, speed = 1): void { this.anim = anim; this.speed = speed; }

  update(dt: number): void {
    this.t += dt * this.speed;
    const swing = this.anim === "walk" ? 0.5 : this.anim === "run" ? 0.9 : 0;
    const f = this.anim === "run" ? 9 : 6;
    this.legs[0].rotation.x = Math.sin(this.t * f) * swing;
    this.legs[1].rotation.x = -Math.sin(this.t * f) * swing;
    this.arm.rotation.x = this.anim === "fire" ? -1.4 : 0;
    if (this.anim === "die") this.object.rotation.x = Math.min(Math.PI / 2, this.object.rotation.x + dt * 3);
  }

  muzzle(out: THREE.Vector3): THREE.Vector3 { return this.arm.getWorldPosition(out); }

  dispose(): void { this.mat.dispose(); }
}

export function createRobotVisual(t: RobotTemplate | null, kind: "walker" | "brute" | "titan", uTime: { value: number }): RobotVisual {
  const height = kind === "titan" ? 6.2 : kind === "brute" ? 3.5 : 2.3;
  return t ? new SkinnedRobot(t, LOOKS[kind], height, uTime) : new BlockRobot(LOOKS[kind], height, uTime);
}

// ---------------------------------------------------------------- drones and turrets

function roleGeo(g: THREE.BufferGeometry, role: number): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute("uv");
  ng.setAttribute("aRole", new THREE.BufferAttribute(new Float32Array(ng.getAttribute("position").count).fill(role), 1));
  return ng;
}

let droneGeo: THREE.BufferGeometry | null = null;
let rotorGeo: THREE.BufferGeometry | null = null;
let turretBaseGeo: THREE.BufferGeometry | null = null;
let turretHeadGeo: THREE.BufferGeometry | null = null;

function droneGeometry(): THREE.BufferGeometry {
  if (droneGeo) return droneGeo;
  droneGeo = mergeGeometries([
    roleGeo(new THREE.SphereGeometry(0.55, 14, 10).scale(1, 0.6, 1.15), 1),
    roleGeo(new THREE.CylinderGeometry(0.42, 0.5, 0.18, 12).translate(0, -0.3, 0), 0),
    roleGeo(new THREE.SphereGeometry(0.2, 10, 8).translate(0, -0.05, 0.55), 2),
    roleGeo(new THREE.BoxGeometry(1.9, 0.08, 0.2), 0),
    roleGeo(new THREE.BoxGeometry(0.2, 0.08, 1.9), 0),
    roleGeo(new THREE.CylinderGeometry(0.06, 0.06, 0.5, 6).translate(0.18, -0.5, 0.15), 0),
    roleGeo(new THREE.CylinderGeometry(0.06, 0.06, 0.5, 6).translate(-0.18, -0.5, 0.15), 0),
  ])!;
  return droneGeo;
}

function rotorGeometry(): THREE.BufferGeometry {
  if (rotorGeo) return rotorGeo;
  const rings: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[0.95, 0], [-0.95, 0], [0, 0.95], [0, -0.95]]) {
    rings.push(roleGeo(new THREE.TorusGeometry(0.38, 0.05, 6, 20).rotateX(Math.PI / 2).translate(x, 0.05, z), 2));
    rings.push(roleGeo(new THREE.BoxGeometry(0.7, 0.02, 0.08).translate(x, 0.08, z), 0));
  }
  rotorGeo = mergeGeometries(rings)!;
  return rotorGeo;
}

function turretGeometry(): [THREE.BufferGeometry, THREE.BufferGeometry] {
  if (turretBaseGeo && turretHeadGeo) return [turretBaseGeo, turretHeadGeo];
  turretBaseGeo = mergeGeometries([
    roleGeo(new THREE.CylinderGeometry(1.1, 1.4, 0.5, 8).translate(0, 0.25, 0), 0),
    roleGeo(new THREE.CylinderGeometry(0.45, 0.6, 1.6, 8).translate(0, 1.3, 0), 1),
    roleGeo(new THREE.TorusGeometry(1.15, 0.05, 6, 24).rotateX(Math.PI / 2).translate(0, 0.52, 0), 2),
  ])!;
  turretHeadGeo = mergeGeometries([
    roleGeo(new THREE.BoxGeometry(1.3, 0.8, 1.2), 1),
    roleGeo(new THREE.BoxGeometry(0.9, 0.18, 0.08).translate(0, 0.12, 0.62), 2),
    roleGeo(new THREE.CylinderGeometry(0.1, 0.12, 1.5, 8).rotateX(Math.PI / 2).translate(0.32, -0.12, 1.2), 0),
    roleGeo(new THREE.CylinderGeometry(0.1, 0.12, 1.5, 8).rotateX(Math.PI / 2).translate(-0.32, -0.12, 1.2), 0),
  ])!;
  return [turretBaseGeo, turretHeadGeo];
}

export class DroneVisual implements RobotVisual {
  object = new THREE.Group();
  fx: FxUniforms;
  private rotors: THREE.Mesh;
  private mat: THREE.MeshStandardMaterial;

  constructor(uTime: { value: number }) {
    const mat = robotMaterial({ main: new THREE.Color(0.06, 0.06, 0.075), grey: new THREE.Color(0.25, 0.26, 0.3), glow: new THREE.Color(1, 0.12, 0.25) }, uTime, false);
    this.mat = mat;
    this.fx = mat.userData.fx;
    const body = new THREE.Mesh(droneGeometry(), mat);
    this.rotors = new THREE.Mesh(rotorGeometry(), mat);
    this.object.add(body, this.rotors);
  }
  play(): void { /* drones have no clips */ }
  update(dt: number): void { this.rotors.rotation.y += dt * 2; }
  muzzle(out: THREE.Vector3): THREE.Vector3 { return out.set(0, -0.6, 0.3).applyMatrix4(this.object.matrixWorld); }
  dispose(): void { this.mat.dispose(); }
}

export class TurretVisual implements RobotVisual {
  object = new THREE.Group();
  head: THREE.Mesh;
  fx: FxUniforms;
  private mat: THREE.MeshStandardMaterial;
  private recoil = 0;

  constructor(uTime: { value: number }) {
    const mat = robotMaterial({ main: new THREE.Color(0.08, 0.085, 0.1), grey: new THREE.Color(0.2, 0.2, 0.22), glow: new THREE.Color(1, 0.2, 0.1) }, uTime, false);
    this.mat = mat;
    this.fx = mat.userData.fx;
    const [b, h] = turretGeometry();
    this.object.add(new THREE.Mesh(b, mat));
    this.head = new THREE.Mesh(h, mat);
    this.head.position.y = 2.5;
    this.object.add(this.head);
  }
  play(anim: RobotAnim): void { if (anim === "fire") this.recoil = 1; }
  update(dt: number): void {
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.head.position.y = 2.5;
    this.head.scale.set(1, 1, 1 - this.recoil * 0.06);
  }
  muzzle(out: THREE.Vector3): THREE.Vector3 { return out.set(0, -0.12, 2.0).applyMatrix4(this.head.matrixWorld); }
  dispose(): void { this.mat.dispose(); }
}
