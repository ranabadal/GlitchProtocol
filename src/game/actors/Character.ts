import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { clamp, damp, lerp } from "../mathx";
import { OperatorRig, type OperatorPose } from "./Humanoid";

/*
 * A realistic, motion-captured human for the player and the other racers: the Mixamo
 * "Vanguard" soldier with Idle / Walk / Run clips, blended by speed. Everything the
 * clips don't cover (aiming the gun with both hands, slashing, throwing, slapping,
 * typing at a terminal, rolling, falling down) is layered on top in code with a small
 * two-bone IK solver, so the hands really hold the weapon wherever the player aims.
 *
 * If the model can't load, the game falls back to the built-in OperatorRig.
 */

export interface CharacterRig {
  root: THREE.Group;
  muzzle: THREE.Object3D;
  scatterMuzzle: THREE.Object3D;
  bladeTip: THREE.Object3D;
  update(dt: number, p: OperatorPose): void;
  /** Colour of the visor / glowing trim (avatar colour, or a team colour for racers). */
  setGlow(c: THREE.Color): void;
}

export interface SoldierTemplate {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
}

let shared: Promise<SoldierTemplate | null> | null = null;

export function loadSoldier(url = "/models/soldier.glb"): Promise<SoldierTemplate | null> {
  shared ??= new GLTFLoader()
    .loadAsync(url)
    .then((g) => {
      g.scene.traverse((o) => {
        const m = o as THREE.SkinnedMesh;
        if (!m.isSkinnedMesh) return;
        m.castShadow = true;
        m.receiveShadow = false;
        m.frustumCulled = false;
        const mat = m.material as THREE.MeshStandardMaterial;
        // The textures are authored for a studio light; tone them down for the city.
        mat.roughness = 0.62;
        mat.metalness = 0.18;
        mat.envMapIntensity = 0.7;
      });
      return { scene: g.scene as THREE.Group, clips: g.animations };
    })
    .catch((err) => {
      console.warn("[glitch] character model failed to load, using the built-in operator", err);
      return null;
    });
  return shared;
}

/** The player's rig: the real character when it loaded, otherwise the primitive one. */
export function makeRig(t: SoldierTemplate | null, hue: number): CharacterRig {
  if (t) {
    try { return new SkinnedOperator(t, new THREE.Color().setHSL(hue / 360, 1, 0.55)); } catch (err) { console.warn("[glitch] character rig failed", err); }
  }
  const rig = new OperatorRig(hue) as unknown as CharacterRig;
  rig.setGlow = (c: THREE.Color) => { (rig as unknown as OperatorRig).glowMat.color.copy(c).multiplyScalar(2.2); };
  return rig;
}

// ---------------------------------------------------------------- IK helpers

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();

/** Rotate `bone` (in world space) so the direction to `childNow` points at `want`. */
function aimBone(bone: THREE.Object3D, childNow: THREE.Vector3, want: THREE.Vector3, weight = 1): void {
  const p = bone.getWorldPosition(_a);
  const from = _b.subVectors(childNow, p).normalize();
  const to = _c.subVectors(want, p).normalize();
  if (from.lengthSq() < 1e-8 || to.lengthSq() < 1e-8) return;
  _q.setFromUnitVectors(from, to);
  if (weight < 1) _q.slerp(_q3.identity(), 1 - weight);
  bone.getWorldQuaternion(_q2);
  _q2.premultiply(_q);
  bone.parent!.getWorldQuaternion(_q3).invert();
  bone.quaternion.copy(_q3.multiply(_q2));
  bone.updateMatrixWorld(true);
}

/** Rotate a bone about a world-space axis (works under rotated parents, unlike Object3D.rotateOnWorldAxis). */
function rotateWorld(bone: THREE.Object3D, axis: THREE.Vector3, angle: number): void {
  _q.setFromAxisAngle(axis, angle);
  bone.getWorldQuaternion(_q2).premultiply(_q);
  bone.parent!.getWorldQuaternion(_q3).invert();
  bone.quaternion.copy(_q3.multiply(_q2));
  bone.updateMatrixWorld(true);
}

class Limb {
  lenA: number;
  lenB: number;
  constructor(public upper: THREE.Bone, public lower: THREE.Bone, public end: THREE.Bone, public tip: THREE.Bone | null) {
    const a = upper.getWorldPosition(new THREE.Vector3()), b = lower.getWorldPosition(new THREE.Vector3()), c = end.getWorldPosition(new THREE.Vector3());
    this.lenA = a.distanceTo(b);
    this.lenB = b.distanceTo(c);
  }

  /** Two-bone IK: put the end bone at `target`, bending toward `pole`. `w` blends with the animated pose. */
  solve(target: THREE.Vector3, pole: THREE.Vector3, w = 1, handDir: THREE.Vector3 | null = null): void {
    if (w <= 0.001) return;
    const a = this.upper.getWorldPosition(new THREE.Vector3());
    const endNow = this.end.getWorldPosition(new THREE.Vector3());
    // Blend the target with where the animation already put the hand.
    const t = endNow.clone().lerp(target, w);
    const toT = t.clone().sub(a);
    const dist = clamp(toT.length(), 0.05, this.lenA + this.lenB - 0.002);
    const dir = toT.normalize();
    const cosA = clamp((this.lenA * this.lenA + dist * dist - this.lenB * this.lenB) / (2 * this.lenA * dist), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    const pd = pole.clone().sub(a);
    pd.addScaledVector(dir, -pd.dot(dir));
    if (pd.lengthSq() < 1e-6) pd.set(0, -1, 0);
    pd.normalize();
    const elbow = a.clone().addScaledVector(dir, cosA * this.lenA).addScaledVector(pd, sinA * this.lenA);
    aimBone(this.upper, this.lower.getWorldPosition(_d), elbow);
    aimBone(this.lower, this.end.getWorldPosition(_d), a.clone().addScaledVector(dir, dist));
    if (handDir && this.tip) {
      const hp = this.end.getWorldPosition(new THREE.Vector3());
      aimBone(this.end, this.tip.getWorldPosition(_d), hp.addScaledVector(handDir, 0.1), w);
    }
  }
}

// ---------------------------------------------------------------- the operator

export class SkinnedOperator implements CharacterRig {
  root = new THREE.Group();
  muzzle = new THREE.Object3D();
  scatterMuzzle = new THREE.Object3D();
  bladeTip = new THREE.Object3D();
  private body = new THREE.Group();
  private model: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private idle: THREE.AnimationAction;
  private walk: THREE.AnimationAction;
  private run: THREE.AnimationAction;
  private bones = new Map<string, THREE.Bone>();
  private armR: Limb;
  private armL: Limb;
  private spine: THREE.Bone[];
  private head: THREE.Bone;
  private hips: THREE.Bone;
  private gunRig = new THREE.Group();
  private gun = new THREE.Group();
  private scatterGun = new THREE.Group();
  private blade = new THREE.Group();
  private bomb: THREE.Mesh;
  private glowMat: THREE.MeshBasicMaterial;
  private visor: THREE.MeshStandardMaterial | null = null;
  private deadT = 0;
  private air = 0;
  private aimS = 0;
  private lean = 0;
  private phase = 0;

  constructor(t: SoldierTemplate, glow: THREE.Color) {
    this.model = SkeletonUtils.clone(t.scene);
    // The model faces -Z; the game's characters face +Z.
    this.model.rotation.y = Math.PI;
    this.body.add(this.model);
    this.root.add(this.body);
    this.model.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.bones.set(o.name.replace(/^mixamorig:?/, ""), o as THREE.Bone);
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh) {
        // Own copy of the materials so each racer can have their own visor colour.
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        m.material = mat;
        if (/visor/i.test(m.name) || /visor/i.test(mat.name)) this.visor = mat;
      }
    });
    const B = (n: string) => {
      const b = this.bones.get(n);
      if (!b) throw new Error(`missing bone ${n}`);
      return b;
    };
    this.mixer = new THREE.AnimationMixer(this.model);
    const clip = (n: string) => t.clips.find((c) => c.name.toLowerCase() === n)!;
    // Strip the hips' forward drift from the clips: the game moves the character itself.
    const inPlace = (c: THREE.AnimationClip) => {
      const cc = c.clone();
      for (const tr of cc.tracks) {
        if (tr.name.endsWith("Hips.position")) {
          // Hips are in the model's Z-up space: keep the bob (z), drop the sway forward/sideways.
          const v = tr.values;
          const x0 = v[0], y0 = v[1];
          for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 1] = y0; }
        }
      }
      return cc;
    };
    this.idle = this.mixer.clipAction(inPlace(clip("idle")));
    this.walk = this.mixer.clipAction(inPlace(clip("walk")));
    this.run = this.mixer.clipAction(inPlace(clip("run")));
    for (const a of [this.idle, this.walk, this.run]) { a.play(); a.setEffectiveWeight(0); }
    this.idle.setEffectiveWeight(1);
    this.mixer.update(0);
    this.root.updateMatrixWorld(true);

    this.hips = B("Hips");
    this.spine = [B("Spine"), B("Spine1"), B("Spine2")];
    this.head = B("Head");
    this.armR = new Limb(B("RightArm"), B("RightForeArm"), B("RightHand"), B("RightHandMiddle1"));
    this.armL = new Limb(B("LeftArm"), B("LeftForeArm"), B("LeftHand"), B("LeftHandMiddle1"));

    // ---- weapons (same designs as the built-in operator)
    this.glowMat = new THREE.MeshBasicMaterial({ color: glow.clone().multiplyScalar(2.2), toneMapped: false });
    const metal = new THREE.MeshStandardMaterial({ color: 0x23272d, roughness: 0.32, metalness: 0.85 });
    const polymer = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.7, metalness: 0.1 });
    this.gun.add(
      new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.44).translate(0, 0, 0.1), metal),
      new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.28, 10).rotateX(Math.PI / 2).translate(0, 0.02, 0.45), metal),
      new THREE.Mesh(new THREE.BoxGeometry(0.066, 0.025, 0.2).translate(0, 0.062, 0.08), this.glowMat),
      new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.13, 0.06).rotateX(0.25).translate(0, -0.1, -0.02), polymer),
      new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.2).translate(0, -0.01, -0.2), polymer),
    );
    this.muzzle.position.set(0, 0.02, 0.6);
    this.gun.add(this.muzzle);
    const hot = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.1, 0.25), toneMapped: false });
    this.scatterGun.add(
      new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.5).translate(0, 0, 0.12), metal),
      new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.34, 10).rotateX(Math.PI / 2).translate(0.028, 0.035, 0.5), metal),
      new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.34, 10).rotateX(Math.PI / 2).translate(-0.028, 0.035, 0.5), metal),
      new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.035, 0.22).translate(0, -0.05, 0.1), hot),
      new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.06).rotateX(0.25).translate(0, -0.11, -0.04), polymer),
      new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.22).translate(0, -0.01, -0.22), polymer),
    );
    this.scatterMuzzle.position.set(0, 0.035, 0.7);
    this.scatterGun.add(this.scatterMuzzle);
    this.gunRig.add(this.gun, this.scatterGun);
    this.body.add(this.gunRig);
    const edge = new THREE.MeshBasicMaterial({ color: glow.clone().multiplyScalar(3), toneMapped: false });
    this.blade.add(
      new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.13, 8).rotateX(Math.PI / 2), polymer),
      new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.045, 0.48).translate(0, 0, 0.3), edge),
      new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.018, 0.025).translate(0, 0, 0.065), metal),
    );
    this.bladeTip.position.set(0, 0, 0.55);
    this.blade.add(this.bladeTip);
    this.body.add(this.blade);
    this.bomb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.07, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 2.6, 2.2), toneMapped: false }));
    this.body.add(this.bomb);
    for (const g of [this.gun, this.scatterGun, this.blade]) g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    this.setGlow(glow);
  }

  setGlow(c: THREE.Color): void {
    this.glowMat.color.copy(c).multiplyScalar(2.2);
    if (this.visor) {
      this.visor.emissive = c.clone();
      this.visor.emissiveIntensity = 1.4;
      this.visor.color.copy(c).multiplyScalar(0.3);
    }
  }

  private bonePos(n: string, out = new THREE.Vector3()): THREE.Vector3 {
    return this.bones.get(n)!.getWorldPosition(out);
  }

  /**
   * Point in the character's own space -> world. x is the character's RIGHT (which is -X in
   * three.js for something facing +Z), y up, z forward.
   */
  private local(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    return this.root.localToWorld(out.set(-x, y, z));
  }

  update(dt: number, p: OperatorPose): void {
    const weapon = p.weapon ?? "blaster";
    // ---- locomotion blend
    const sp = p.speed;
    this.air = p.grounded ? Math.max(0, this.air - dt * 6) : Math.min(1, this.air + dt * 5);
    const wIdle = clamp(1 - sp / 1.2, 0, 1);
    const wRun = clamp((sp - 2.4) / 2.2, 0, 1);
    const wWalk = clamp(1 - wIdle - wRun, 0, 1);
    this.idle.setEffectiveWeight(wIdle);
    this.walk.setEffectiveWeight(wWalk);
    this.run.setEffectiveWeight(wRun);
    this.walk.timeScale = clamp(sp / 1.5, 0.6, 1.6);
    this.run.timeScale = clamp(sp / 5.6, 0.85, 1.55);
    // Airborne: freeze the legs mid-stride.
    const frozen = this.air > 0.5 || p.dead || (p.roll ?? -1) >= 0;
    this.mixer.update(frozen ? 0 : dt);
    this.phase += dt * (3 + sp);

    // ---- whole-body moves: falling down, rolling, sprint lean
    if (p.dead) {
      this.deadT = Math.min(1, this.deadT + dt * 2.2);
      const e = this.deadT * this.deadT;
      this.body.rotation.set(lerp(0, -Math.PI / 2, e), 0, 0);
      this.body.position.set(0, lerp(0, 0.2, this.deadT), lerp(0, -0.2, e));
      this.showWeapons(weapon, false);
      this.root.updateMatrixWorld(true);
      return;
    }
    this.deadT = 0;
    const roll = p.roll ?? -1;
    if (roll >= 0) {
      const e = Math.sin(roll * Math.PI);
      this.body.rotation.set(roll * Math.PI * 2, 0, 0);
      this.body.position.set(0, 0.45 * e, 0);
      this.model.position.y = -0.55 * e;
      this.showWeapons(weapon, false);
      this.root.updateMatrixWorld(true);
      return;
    }
    this.model.position.y = 0;
    this.lean = damp(this.lean, clamp((sp - 6.5) / 4, 0, 1) * 0.16 + p.hurt * -0.12, 8, dt);
    this.body.rotation.set(this.lean, 0, 0);
    this.body.position.set(0, -this.air * 0.05, 0);
    this.root.updateMatrixWorld(true);

    // ---- upper body: aim pitch through the spine, flinch
    const aimT = p.hack ? 0 : p.aim;
    this.aimS = damp(this.aimS, aimT, 14, dt);
    const pitch = clamp(p.pitch, -0.9, 0.9);
    const pitchShare = (pitch * this.aimS) / 3;
    const right = this.worldRight();
    for (const b of this.spine) rotateWorld(b, right, pitchShare);
    // A twist so the shoulders square up to the gun when aiming.
    if (this.aimS > 0.01) rotateWorld(this.spine[2], new THREE.Vector3(0, 1, 0), -0.25 * this.aimS);

    // ---- hands
    const sw = p.swing ?? -1, th = p.throwT ?? -1, sl = p.slapT ?? -1;
    const gunHeld = weapon === "blaster" || weapon === "scatter";
    // Typing at a terminal: the gun is slung (hidden) so both hands are free.
    this.showWeapons(weapon, !p.hack, th);
    const fwd = this.worldDir(0, 0, 1, new THREE.Vector3());
    const aimDir = this.worldDir(0, Math.sin(pitch), Math.cos(pitch), new THREE.Vector3()).normalize();

    if (p.hack) {
      // Typing on a terminal in front of the chest.
      const tap = Math.sin(this.phase * 9) * 0.02;
      this.armR.solve(this.local(0.14, 1.08 + tap, 0.42), this.local(0.6, 0.9, -0.3), 1, fwd);
      this.armL.solve(this.local(-0.14, 1.08 - tap, 0.42), this.local(-0.6, 0.9, -0.3), 1, fwd);
    } else if (gunHeld) {
      // Rifle hold: low-ready when relaxed, up at the shoulder when aiming or firing.
      const a = this.aimS;
      const shoulder = this.bonePos("RightShoulder");
      const ready = this.local(0.17, 1.05, 0.3);
      const up = shoulder.clone().addScaledVector(aimDir, 0.12).add(this.worldDir(-0.04, -0.04, 0, _d));
      const grip = ready.lerp(up, a);
      // Recoil kicks the gun back a few centimetres.
      grip.addScaledVector(aimDir, -p.recoil * 0.06 * a);
      const gunDir = new THREE.Vector3().copy(fwd).multiplyScalar(Math.cos(0.5 * (1 - a))).add(_d.set(0, -Math.sin(0.5 * (1 - a)), 0)).normalize().lerp(aimDir, a).normalize();
      this.placeWeapon(this.gunRig, grip, gunDir);
      const forend = grip.clone().addScaledVector(gunDir, weapon === "scatter" ? 0.3 : 0.28).add(this.worldDir(0, -0.04, 0, _d));
      this.armR.solve(grip, this.local(0.55, 0.7, -0.4), 1, gunDir);
      if (sl < 0 && th < 0) this.armL.solve(forend, this.local(-0.5, 0.6, -0.1), 1, gunDir);
    } else {
      // Blade or bomb: natural arm swing from the clip, with a slight guard pose.
      if (weapon === "blade" && sw < 0) this.armR.solve(this.local(0.24, 1.0, 0.28), this.local(0.6, 0.8, -0.4), 0.6, fwd);
    }

    // Blade slash: the right hand sweeps across the body.
    if (sw >= 0) {
      const side = p.swingSide ?? 1;
      const e = Math.sin(Math.min(1, sw) * Math.PI * 0.5);
      const x = lerp(0.55 * side, -0.45 * side, e);
      const y = lerp(1.55, 1.05, e);
      this.armR.solve(this.local(x, y, 0.5), this.local(0.7, 1.4, -0.3), 1, this.worldDir(-side, -0.3, 1, new THREE.Vector3()).normalize());
    }
    // Bomb throw: wind up behind the head, then whip forward.
    if (th >= 0) {
      const wind = Math.min(1, th / 0.4), fw = Math.max(0, (th - 0.4) / 0.6);
      const tgt = this.local(-0.22, lerp(1.0, 1.85, wind), lerp(0.1, -0.3, wind)).lerp(this.local(-0.15, 1.45, 0.65), fw);
      this.armL.solve(tgt, this.local(-0.7, 1.2, -0.4), 1, fwd);
    }
    // Slap: the left hand swings flat across.
    if (sl >= 0) {
      const e = Math.sin(Math.min(1, sl) * Math.PI * 0.5);
      this.armL.solve(this.local(lerp(-0.7, 0.35, e), 1.45, 0.55), this.local(-0.8, 1.2, -0.3), 1, this.worldDir(1, 0, 0.4, new THREE.Vector3()).normalize());
    }
    // Head follows the aim a little.
    rotateWorld(this.head, this.worldRight(), pitch * 0.35);

    // Things held in the hands follow the hand bones.
    if (weapon === "blade") {
      const hp = this.bonePos("RightHand");
      const dir = sw >= 0 ? this.worldDir(-(p.swingSide ?? 1) * 0.6, 0.2, 1, new THREE.Vector3()).normalize() : this.worldDir(0, 0.15, 1, new THREE.Vector3()).normalize();
      this.placeWeapon(this.blade, hp.addScaledVector(dir, 0.04), dir);
    }
    if (weapon === "bomb") {
      const hp = this.bonePos("LeftHand");
      this.bomb.position.copy(this.body.worldToLocal(hp.add(this.worldDir(0, -0.02, 0.06, _d))));
    }
  }

  private showWeapons(weapon: string, on: boolean, throwT = -1): void {
    this.gun.visible = on && weapon === "blaster";
    this.scatterGun.visible = on && weapon === "scatter";
    this.blade.visible = on && weapon === "blade";
    this.bomb.visible = on && weapon === "bomb" && !(throwT > 0.45);
  }

  /** Put a weapon group (child of body) at a world position, pointing along a world direction. */
  private placeWeapon(g: THREE.Object3D, worldPos: THREE.Vector3, worldDir: THREE.Vector3): void {
    const parent = g.parent!;
    parent.updateMatrixWorld(true);
    g.position.copy(parent.worldToLocal(worldPos.clone()));
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), worldDir.clone().negate(), new THREE.Vector3(0, 1, 0));
    const wq = new THREE.Quaternion().setFromRotationMatrix(m);
    parent.getWorldQuaternion(_q3).invert();
    g.quaternion.copy(_q3.multiply(wq));
    g.updateMatrixWorld(true);
  }

  private worldRight(): THREE.Vector3 {
    return this.worldDir(1, 0, 0, new THREE.Vector3()).normalize();
  }

  /** Direction in the character's space (x right, y up, z forward) -> world. */
  private worldDir(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(-x, y, z).applyQuaternion(this.root.getWorldQuaternion(_q2));
  }
}
