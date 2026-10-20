import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { mergeRobot } from "@/game/actors/RobotModel";
import { Colliders } from "@/game/Colliders";
import { rayCapsule, raySphere, segSegDist, wrapAngle } from "@/game/mathx";

/*
 * Checks for the browser engine's pure parts: the robot model merge (one draw call per
 * robot must animate exactly like the original 20-part model), and the ray/collision
 * maths behind shooting, line of sight and walking into walls.
 */

function loadRobot(): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
  const buf = fs.readFileSync(path.join(process.cwd(), "public/models/robot.glb"));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((res, rej) => new GLTFLoader().parse(ab, "", res as never, rej));
}

describe("robot model merge", () => {
  it("the merged single mesh matches the original model vertex-for-vertex while running", async () => {
    const a = await loadRobot();
    const b = await loadRobot();
    const meshesA: THREE.Mesh[] = [];
    a.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshesA.push(o as THREE.Mesh); });
    const merged = mergeRobot(b.scene);
    const names = new Set<string>();
    merged.traverse((o) => names.add(o.name));
    const clipB = b.animations.map((c) => new THREE.AnimationClip(c.name, c.duration, c.tracks.filter((t) => names.has(t.name.split(".")[0]) && !t.name.includes("morphTarget"))));
    for (const [root, clips] of [[a.scene, a.animations], [merged, clipB]] as const) {
      const mx = new THREE.AnimationMixer(root);
      mx.clipAction(clips.find((c) => c.name === "Running")!).play();
      mx.setTime(0.41);
      root.updateMatrixWorld(true);
    }
    let sm: THREE.SkinnedMesh | null = null;
    merged.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) sm = o as THREE.SkinnedMesh; });
    expect(sm).not.toBeNull();
    const skinned = sm as unknown as THREE.SkinnedMesh;
    expect(skinned.geometry.groups.length).toBe(0);
    let offset = 0, maxErr = 0;
    const v = new THREE.Vector3(), w = new THREE.Vector3();
    for (const m of meshesA) {
      const pos = m.geometry.getAttribute("position");
      for (let i = 0; i < pos.count; i += 5) {
        v.fromBufferAttribute(pos, i);
        if ((m as THREE.SkinnedMesh).isSkinnedMesh) (m as THREE.SkinnedMesh).applyBoneTransform(i, v);
        v.applyMatrix4(m.matrixWorld);
        w.fromBufferAttribute(skinned.geometry.getAttribute("position"), offset + i);
        skinned.applyBoneTransform(offset + i, w).applyMatrix4(skinned.matrixWorld);
        maxErr = Math.max(maxErr, v.distanceTo(w));
      }
      offset += pos.count;
    }
    expect(offset).toBe(skinned.geometry.getAttribute("position").count);
    expect(maxErr).toBeLessThan(1e-3);
  });
});

describe("ray and collision maths", () => {
  const o = new THREE.Vector3(0, 1, 0);
  const fwd = new THREE.Vector3(0, 0, 1);

  it("ray vs capsule: hits a robot in front, misses one beside or behind", () => {
    const a = new THREE.Vector3(0, 0.5, 10), b = new THREE.Vector3(0, 2, 10);
    const t = rayCapsule(o, fwd, a, b, 0.6, 100);
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(9.3);
    expect(t!).toBeLessThan(9.5);
    expect(rayCapsule(o, fwd, new THREE.Vector3(2, 0.5, 10), new THREE.Vector3(2, 2, 10), 0.6, 100)).toBeNull();
    expect(rayCapsule(o, fwd, new THREE.Vector3(0, 0.5, -10), new THREE.Vector3(0, 2, -10), 0.6, 100)).toBeNull();
    expect(rayCapsule(o, fwd, a, b, 0.6, 5)).toBeNull();
  });

  it("ray vs sphere and segment distance", () => {
    expect(raySphere(o, fwd, 0, 1, 5, 1, 50)).toBeCloseTo(4, 5);
    expect(raySphere(o, fwd, 3, 1, 5, 1, 50)).toBeNull();
    const d = segSegDist(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, -1), new THREE.Vector3(0, 1, 1));
    expect(d).toBeCloseTo(1, 6);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 6);
  });

  it("walls push characters out, bullets stop at walls, and walls block line of sight", () => {
    const c = new Colliders();
    c.addRect(0, 10, 20, 2, 30, "building");
    const r = c.resolveCircle(0, 9.5, 0.5, 0, 1.8);
    expect(r.hit).toBe(true);
    expect(r.z).toBeCloseTo(8.5, 5);
    const hit = c.raycast(0, 1, 0, 0, 0, 1, 100);
    expect(hit?.box?.kind).toBe("building");
    expect(hit!.t).toBeCloseTo(9, 5);
    expect(c.lineOfSight(0, 1, 0, 0, 1, 20)).toBe(false);
    expect(c.lineOfSight(0, 1, 0, 15, 1, 0)).toBe(true);
    // Props (lamp posts) never block line of sight, and disabled boxes (destroyed fences) are ignored.
    const p = c.addRect(5, 0, 0.4, 0.4, 8, "prop");
    expect(c.lineOfSight(0, 1, 0, 10, 1, 0)).toBe(true);
    const fence = c.addRect(0, -5, 20, 0.6, 3, "fence");
    expect(c.resolveCircle(0, -5.2, 0.5, 0, 1.8).hit).toBe(true);
    fence.enabled = false;
    expect(c.resolveCircle(0, -5.2, 0.5, 0, 1.8).hit).toBe(false);
    void p;
  });

  it("a ray pointing down hits the ground", () => {
    const c = new Colliders();
    const d = new THREE.Vector3(0, -1, 1).normalize();
    const hit = c.raycast(0, 2, 0, d.x, d.y, d.z, 100);
    expect(hit?.box).toBeNull();
    expect(hit!.y).toBeCloseTo(0, 6);
  });
});
