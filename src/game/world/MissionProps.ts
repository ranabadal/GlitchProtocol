import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { getCity, LOBBY_H, SIDE_NORMAL } from "@/lib/shared/city";
import type { Hurdle, VaultPublic } from "@/lib/shared/mission";
import type { Box, Colliders } from "../Colliders";
import { raySphere, rayCapsule } from "../mathx";
import { radialTexture, stripeTexture, textTexture } from "./Textures";

/*
 * Mission set-pieces placed into the city: vault lobbies you can walk into, the
 * terminal and data core inside, road barricades, laser fences with shootable pylons,
 * the uplink zone and repair kits.
 */

const additive = (color: THREE.ColorRepresentation, opacity = 1) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });

// ---------------------------------------------------------------- vault lobby

export type VaultState = "locked" | "open" | "brute" | "taken";

const fieldMaterial = (uTime: { value: number }) => new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  uniforms: { uTime, uColor: { value: new THREE.Color(1, 0.12, 0.25) }, uAlpha: { value: 1 }, uProgress: { value: 0 } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform float uTime; uniform vec3 uColor; uniform float uAlpha; uniform float uProgress; varying vec2 vUv;
    void main(){
      vec2 g = vec2(vUv.x * 24.0, vUv.y * 10.0);
      vec2 f = abs(fract(g + vec2(0.5 * mod(floor(g.y), 2.0), 0.0)) - 0.5);
      float hex = smoothstep(0.42, 0.5, max(f.x, f.y));
      float scan = smoothstep(0.0, 0.05, fract(vUv.y * 2.0 - uTime * 0.6)) * (1.0 - smoothstep(0.05, 0.12, fract(vUv.y * 2.0 - uTime * 0.6)));
      float edge = smoothstep(0.85, 1.0, vUv.y) + smoothstep(0.15, 0.0, vUv.y);
      float fill = step(vUv.y, uProgress);
      vec3 c = uColor * (0.18 + hex * 0.6 + scan * 0.8 + edge * 0.6);
      c = mix(c, vec3(0.3, 1.0, 0.6) * (0.4 + hex), fill * 0.8);
      gl_FragColor = vec4(c * uAlpha, 1.0);
    }`,
});

const screenMaterial = (uTime: { value: number }) => new THREE.ShaderMaterial({
  uniforms: { uTime, uColor: { value: new THREE.Color(1, 0.15, 0.25) } },
  toneMapped: false,
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
    float h(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    void main(){
      vec2 cell = floor(vec2(vUv.x * 30.0, vUv.y * 14.0 + uTime * 3.0));
      float on = step(0.45, h(cell + floor(uTime * 4.0) * 0.01));
      float lineLen = h(vec2(cell.y, 7.0));
      on *= step(vUv.x, 0.15 + lineLen * 0.8);
      float frame = step(0.96, max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)) * 2.0);
      vec3 c = uColor * (0.15 + on * 0.9 + frame * 1.5);
      gl_FragColor = vec4(c * 1.6, 1.0);
    }`,
});

export class VaultLobby {
  group = new THREE.Group();
  state: VaultState = "locked";
  private field: THREE.Mesh;
  private fieldMat: THREE.ShaderMaterial;
  private screenMat: THREE.ShaderMaterial;
  private core: THREE.Mesh;
  private coreGlow: THREE.Sprite;
  private beam: THREE.Mesh;
  private ring: THREE.Mesh;
  private sign: THREE.Mesh;
  private progress = 0;

  constructor(public v: VaultPublic, colliders: Colliders, uTime: { value: number }) {
    const b = getCity().buildingById.get(v.buildingId)!;
    const side = v.side;
    const [nx, nz] = SIDE_NORMAL[side];
    const T = 0.5;
    const H = LOBBY_H;
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x141b22, roughness: 0.45, metalness: 0.5, emissive: 0x050d12 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x02050a, roughness: 0.05, metalness: 0.95, emissive: 0x041016 });
    const trimMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.15, 0.35), toneMapped: false });
    const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
    const DOOR = 7, DOOR_H = 4.6;
    const solid: THREE.BufferGeometry[] = [];
    const glass: THREE.BufferGeometry[] = [];
    const trims: THREE.BufferGeometry[] = [];
    const wall = (cx: number, cz: number, w: number, d: number, h: number, y0: number, isGlass = false) => {
      (isGlass ? glass : solid).push(new THREE.BoxGeometry(w, h, d).translate(cx, y0 + h / 2, cz));
      colliders.addRect(cx, cz, w, d, h, "wall", y0);
    };
    // Four walls; the door side has an opening.
    const sides: [string, number, number, number, number][] = [
      ["nz", b.x, z0 + T / 2, b.w, T], ["pz", b.x, z1 - T / 2, b.w, T], ["nx", x0 + T / 2, b.z, T, b.d], ["px", x1 - T / 2, b.z, T, b.d],
    ];
    for (const [s, cx, cz, w, d] of sides) {
      if (s !== side) { wall(cx, cz, w, d, H, 0); continue; }
      const along = s === "nz" || s === "pz";
      const len = along ? w : d;
      const seg = (len - DOOR) / 2;
      for (const k of [-1, 1]) {
        const off = k * (DOOR / 2 + seg / 2);
        if (along) wall(cx + off, cz, seg, d, H, 0, true);
        else wall(cx, cz + off, w, seg, H, 0, true);
      }
      if (along) wall(cx, cz, DOOR, d, H - DOOR_H, DOOR_H);
      else wall(cx, cz, w, DOOR, H - DOOR_H, DOOR_H);
      // Neon door frame.
      const fx = v.door.x + nx * 0.3, fz = v.door.z + nz * 0.3;
      if (along) {
        trims.push(new THREE.BoxGeometry(DOOR + 0.3, 0.15, 0.1).translate(fx, DOOR_H, fz));
        for (const k of [-1, 1]) trims.push(new THREE.BoxGeometry(0.15, DOOR_H, 0.1).translate(fx + k * DOOR / 2, DOOR_H / 2, fz));
      } else {
        trims.push(new THREE.BoxGeometry(0.1, 0.15, DOOR + 0.3).translate(fx, DOOR_H, fz));
        for (const k of [-1, 1]) trims.push(new THREE.BoxGeometry(0.1, DOOR_H, 0.15).translate(fx, DOOR_H / 2, fz + k * DOOR / 2));
      }
    }
    // Ceiling panel with light strips, and the rest of the tower above.
    solid.push(new THREE.BoxGeometry(b.w - T * 2, 0.3, b.d - T * 2).translate(b.x, H - 0.15, b.z));
    colliders.addRect(b.x, b.z, b.w, b.d, b.h - H + 0.3, "building", H - 0.3);
    const strips: THREE.BufferGeometry[] = [];
    for (let i = -2; i <= 2; i++) {
      if (side === "px" || side === "nx") strips.push(new THREE.BoxGeometry(b.w * 0.8, 0.05, 0.25).translate(b.x, H - 0.33, b.z + i * b.d * 0.18));
      else strips.push(new THREE.BoxGeometry(0.25, 0.05, b.d * 0.8).translate(b.x + i * b.w * 0.18, H - 0.33, b.z));
    }
    // Server racks along the inner side walls.
    const racks: THREE.BufferGeometry[] = [];
    const leds: THREE.BufferGeometry[] = [];
    const inward = [-nx, -nz];
    const across = side === "px" || side === "nx" ? [0, 1] : [1, 0];
    const halfAcross = (side === "px" || side === "nx" ? b.d : b.w) / 2 - T - 0.6;
    const depth = side === "px" || side === "nx" ? b.w : b.d;
    for (let k = 0; k < 3; k++) {
      const dIn = 4 + k * (depth - 8) / 2.5;
      if (dIn > depth - 3) continue;
      for (const s2 of [-1, 1]) {
        const cx = v.door.x + inward[0] * dIn + across[0] * s2 * halfAcross;
        const cz = v.door.z + inward[1] * dIn + across[1] * s2 * halfAcross;
        racks.push(new THREE.BoxGeometry(1.0, 2.6, 1.0).translate(cx, 1.3, cz));
        for (let l = 0; l < 4; l++) leds.push(new THREE.BoxGeometry(1.04, 0.05, 1.04).translate(cx, 0.5 + l * 0.55, cz));
        colliders.addRect(cx, cz, 1.0, 1.0, 2.6, "prop");
      }
    }
    this.group.add(new THREE.Mesh(mergeGeometries(solid.concat(racks))!, wallMat));
    this.group.add(new THREE.Mesh(mergeGeometries(glass)!, glassMat));
    this.group.add(new THREE.Mesh(mergeGeometries(trims)!, trimMat));
    this.group.add(new THREE.Mesh(mergeGeometries(strips)!, new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 2.2, 2.4), toneMapped: false })));
    // Vertical light strips on the inside walls.
    const wallStrips: THREE.BufferGeometry[] = [];
    for (const k of [-0.33, 0, 0.33]) {
      if (side === "px" || side === "nx") {
        wallStrips.push(new THREE.BoxGeometry(0.12, H - 1, 0.06).translate(b.x + k * b.w, H / 2, z0 + T + 0.04));
        wallStrips.push(new THREE.BoxGeometry(0.12, H - 1, 0.06).translate(b.x + k * b.w, H / 2, z1 - T - 0.04));
      } else {
        wallStrips.push(new THREE.BoxGeometry(0.06, H - 1, 0.12).translate(x0 + T + 0.04, H / 2, b.z + k * b.d));
        wallStrips.push(new THREE.BoxGeometry(0.06, H - 1, 0.12).translate(x1 - T - 0.04, H / 2, b.z + k * b.d));
      }
    }
    this.group.add(new THREE.Mesh(mergeGeometries(wallStrips)!, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 1.4, 1.8), toneMapped: false })));
    this.group.add(new THREE.Mesh(mergeGeometries(leds)!, additive(new THREE.Color(0.2, 1.2, 0.8), 0.9)));

    // Floor: dark tiles with a glowing grid.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(b.w - T * 2, b.d - T * 2).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
      uniforms: { uTime },
      vertexShader: /* glsl */ `varying vec3 vW; void main(){ vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`,
      fragmentShader: /* glsl */ `uniform float uTime; varying vec3 vW;
        void main(){ vec2 g = abs(fract(vW.xz / 2.0) - 0.5); float l = step(0.47, max(g.x, g.y));
          float pulse = 0.5 + 0.5 * sin(uTime * 2.0 - length(vW.xz) * 0.3);
          vec2 t = abs(fract(vW.xz / 4.0) - 0.5); float tile = step(0.25, max(t.x, t.y));
          gl_FragColor = vec4(vec3(0.035, 0.045, 0.055) * (0.8 + 0.4 * tile) + vec3(0.9, 0.1, 0.2) * l * (0.2 + pulse * 0.3), 1.0); }`,
    }));
    floor.position.set(b.x, 0.03, b.z);
    this.group.add(floor);

    // Terminal console with a live screen, facing the door.
    const face = Math.atan2(nx, nz);
    const term = new THREE.Group();
    term.position.set(v.terminal.x, 0, v.terminal.z);
    term.rotation.y = face;
    const consoleMesh = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.05, 0.8).translate(0, 0.52, 0), wallMat);
    this.screenMat = screenMaterial(uTime);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.9), this.screenMat);
    screen.position.set(0, 1.55, -0.1);
    screen.rotation.x = -0.25;
    const keys = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.04, 0.4).translate(0, 1.07, 0.1), additive(new THREE.Color(0.3, 0.9, 1.2), 0.8));
    term.add(consoleMesh, screen, keys);
    this.group.add(term);
    colliders.addRect(v.terminal.x, v.terminal.z, 1.4, 1.4, 1.1, "prop");

    // Core pedestal, floating core and force field.
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.2, 0.9, 16).translate(0, 0.45, 0), wallMat);
    ped.position.set(v.core.x, 0, v.core.z);
    this.group.add(ped);
    colliders.addRect(v.core.x, v.core.z, 1.6, 1.6, 0.9, "prop");
    this.core = new THREE.Mesh(new THREE.OctahedronGeometry(0.45, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 2.6, 1.6), toneMapped: false, wireframe: false }));
    this.core.position.set(v.core.x, 1.7, v.core.z);
    const coreWire = new THREE.Mesh(new THREE.OctahedronGeometry(0.62, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 3, 2), wireframe: true, toneMapped: false }));
    this.core.add(coreWire);
    this.coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture(), color: new THREE.Color(0.3, 1, 0.6), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.coreGlow.scale.setScalar(3.2);
    this.core.add(this.coreGlow);
    this.group.add(this.core);
    this.fieldMat = fieldMaterial(uTime);
    this.field = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 3.2, 32, 1, true), this.fieldMat);
    this.field.position.set(v.core.x, 1.6, v.core.z);
    this.group.add(this.field);

    // Outside: a sky beam and a ground ring so the vault is easy to spot.
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 260, 8, 1, true).translate(0, 130, 0), additive(new THREE.Color(0.25, 1.2, 1.6), 0.22));
    this.beam.position.set(v.door.x + nx * 4, 0, v.door.z + nz * 4);
    this.group.add(this.beam);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(2.6, 3.0, 40).rotateX(-Math.PI / 2), additive(new THREE.Color(0.25, 1.2, 1.6), 0.9));
    this.ring.position.set(v.door.x + nx * 4, 0.06, v.door.z + nz * 4);
    this.group.add(this.ring);
    const signTex = textTexture(`NULL VAULT · ${v.name.toUpperCase()}`, { color: "#ff3d6e", w: 1024, h: 128, font: `700 64px "Oxanium Variable", Oxanium, sans-serif` });
    this.sign = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.12), new THREE.MeshBasicMaterial({ map: signTex, transparent: true, toneMapped: false, depthWrite: false, side: THREE.DoubleSide }));
    this.sign.position.set(v.door.x + nx * 0.6, 5.6, v.door.z + nz * 0.6);
    this.sign.rotation.y = face;
    this.group.add(this.sign);
  }

  setState(s: VaultState, bruteProgress = 0): void {
    this.state = s;
    this.progress = bruteProgress;
    const u = this.fieldMat.uniforms;
    if (s === "locked") { u.uColor.value.setRGB(1, 0.12, 0.25); this.screenMat.uniforms.uColor.value.setRGB(1, 0.15, 0.25); }
    if (s === "brute") { u.uColor.value.setRGB(1, 0.5, 0.1); u.uProgress.value = bruteProgress; this.screenMat.uniforms.uColor.value.setRGB(1, 0.6, 0.1); }
    if (s === "open" || s === "taken") { this.screenMat.uniforms.uColor.value.setRGB(0.2, 1, 0.5); }
    this.core.visible = s !== "taken";
    const beamMat = this.beam.material as THREE.MeshBasicMaterial;
    const ringMat = this.ring.material as THREE.MeshBasicMaterial;
    const col = s === "taken" ? new THREE.Color(0.2, 1.4, 0.6) : new THREE.Color(0.25, 1.2, 1.6);
    beamMat.color.copy(col);
    ringMat.color.copy(col);
    beamMat.opacity = s === "taken" ? 0.06 : 0.22;
    (this.sign.material as THREE.MeshBasicMaterial).color.setScalar(s === "taken" ? 0.35 : 1);
  }

  update(time: number, dt: number): void {
    this.core.rotation.y += dt * 1.6;
    this.core.position.y = 1.7 + Math.sin(time * 2.2) * 0.12;
    const u = this.fieldMat.uniforms;
    const target = this.state === "locked" || this.state === "brute" ? 1 : 0;
    u.uAlpha.value += (target - u.uAlpha.value) * Math.min(1, dt * 3);
    if (this.state === "brute") u.uAlpha.value = 0.6 + 0.4 * Math.sin(time * 20) * Math.sin(time * 7);
    this.field.visible = u.uAlpha.value > 0.02;
    this.ring.scale.setScalar(1 + Math.sin(time * 3) * 0.05);
  }

  corePos(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.core.position);
  }
}

// ---------------------------------------------------------------- barricades

export function buildBarricades(list: Hurdle[], colliders: Colliders, uTime: { value: number }): THREE.Group {
  const g = new THREE.Group();
  if (!list.length) return g;
  const profile = new THREE.Shape([new THREE.Vector2(-0.42, 0), new THREE.Vector2(0.42, 0), new THREE.Vector2(0.3, 0.3), new THREE.Vector2(0.16, 1.15), new THREE.Vector2(-0.16, 1.15), new THREE.Vector2(-0.3, 0.3)]);
  const jersey = new THREE.ExtrudeGeometry(profile, { depth: 1.9, bevelEnabled: false }).translate(0, 0, -0.95);
  const per = 13;
  const blocks = new THREE.InstancedMesh(jersey, new THREE.MeshStandardMaterial({ color: 0x6b6f76, roughness: 0.85, metalness: 0.1 }), list.length * per);
  const stripes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.36, 0.3, 1.9), new THREE.MeshStandardMaterial({ map: stripeTexture(), emissive: 0xffffff, emissiveMap: stripeTexture(), emissiveIntensity: 0.35, roughness: 0.6 }), list.length * per);
  const lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.2, 0.2), toneMapped: false }), list.length * 4);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  let bi = 0, li = 0;
  for (const h of list) {
    // horizontal road (along x) -> barricade spans z.
    const rot = h.horizontal ? 0 : Math.PI / 2;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
    for (let k = 0; k < per; k++) {
      const off = -h.span / 2 + 1 + k * ((h.span - 2) / (per - 1));
      const px = h.horizontal ? h.x : h.x + off;
      const pz = h.horizontal ? h.z + off : h.z;
      m4.compose(new THREE.Vector3(px, 0, pz), q, new THREE.Vector3(1, 1, 1));
      blocks.setMatrixAt(bi, m4);
      m4.compose(new THREE.Vector3(px, 1.0, pz), q, new THREE.Vector3(1, 1, 1));
      stripes.setMatrixAt(bi, m4);
      bi++;
    }
    for (let k = 0; k < 4; k++) {
      const off = -h.span / 2 + 2 + k * ((h.span - 4) / 3);
      m4.makeTranslation(h.horizontal ? h.x : h.x + off, 1.3, h.horizontal ? h.z + off : h.z);
      lamps.setMatrixAt(li++, m4);
    }
    colliders.addRect(h.x, h.z, h.horizontal ? 1.0 : h.span, h.horizontal ? h.span : 1.0, 1.3, "barricade");
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(7, 1.1), new THREE.MeshBasicMaterial({ map: textTexture("ROAD BLOCKED", { color: "#ff4d4d", w: 768, h: 128 }), transparent: true, toneMapped: false, depthWrite: false, side: THREE.DoubleSide }));
    sign.position.set(h.x, 3.2, h.z);
    sign.rotation.y = h.horizontal ? Math.PI / 2 : 0;
    g.add(sign);
  }
  const lampMat = lamps.material as THREE.MeshBasicMaterial;
  lamps.onBeforeRender = () => { lampMat.color.setRGB(0.5 + 3.5 * (Math.sin(uTime.value * 6) > 0 ? 1 : 0), 0.15, 0.15); };
  g.add(blocks, stripes, lamps);
  return g;
}

// ---------------------------------------------------------------- laser fences

export interface Fence {
  id: string;
  h: Hurdle;
  edge: string;
  active: boolean;
  pylons: { pos: THREE.Vector3; hp: number; mesh: THREE.Mesh }[];
  beams: THREE.Mesh[];
  box: Box;
}

export class Fences {
  group = new THREE.Group();
  list: Fence[] = [];
  private beamMat: THREE.MeshBasicMaterial;
  onDisabled: ((f: Fence) => void) | null = null;

  constructor(hurdles: Hurdle[], colliders: Colliders) {
    this.beamMat = additive(new THREE.Color(3, 0.15, 0.25), 0.9);
    const pylonGeo = mergeGeometries([
      new THREE.BoxGeometry(0.7, 3.2, 0.7).translate(0, 1.6, 0),
      new THREE.BoxGeometry(0.9, 0.3, 0.9).translate(0, 0.15, 0),
      new THREE.BoxGeometry(0.9, 0.2, 0.9).translate(0, 3.25, 0),
    ])!;
    for (const h of hurdles) {
      const half = h.span / 2 - 0.6;
      const pylons: Fence["pylons"] = [];
      for (const k of [-1, 1]) {
        const pos = new THREE.Vector3(h.horizontal ? h.x : h.x + k * half, 0, h.horizontal ? h.z + k * half : h.z);
        const mesh = new THREE.Mesh(pylonGeo, new THREE.MeshStandardMaterial({ color: 0x15181d, metalness: 0.8, roughness: 0.35, emissive: new THREE.Color(1, 0.08, 0.15), emissiveIntensity: 0.9 }));
        mesh.position.copy(pos);
        this.group.add(mesh);
        pylons.push({ pos, hp: 90, mesh });
      }
      const beams: THREE.Mesh[] = [];
      for (let i = 0; i < 5; i++) {
        const beam = new THREE.Mesh(new THREE.BoxGeometry(h.horizontal ? 0.06 : half * 2, 0.06, h.horizontal ? half * 2 : 0.06), this.beamMat);
        beam.position.set(h.x, 0.45 + i * 0.55, h.z);
        this.group.add(beam);
        beams.push(beam);
      }
      const box = colliders.addRect(h.x, h.z, h.horizontal ? 0.6 : half * 2, h.horizontal ? half * 2 : 0.6, 3.0, "fence", 0, h.id);
      this.list.push({ id: h.id, h, edge: h.edge, active: true, pylons, beams, box });
    }
  }

  byId(id: string | undefined): Fence | undefined {
    return this.list.find((f) => f.id === id);
  }

  hitScan(o: THREE.Vector3, d: THREE.Vector3, maxT: number): { fence: Fence; pylon: number; t: number } | null {
    let best: { fence: Fence; pylon: number; t: number } | null = null;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (const f of this.list) {
      if (!f.active) continue;
      f.pylons.forEach((p, i) => {
        a.set(p.pos.x, 0.4, p.pos.z);
        b.set(p.pos.x, 3.0, p.pos.z);
        const t = rayCapsule(o, d, a, b, 0.55, maxT);
        if (t !== null && (!best || t < best.t)) best = { fence: f, pylon: i, t };
      });
    }
    return best;
  }

  damage(f: Fence, pylon: number, amount: number): boolean {
    const p = f.pylons[pylon];
    p.hp -= amount;
    (p.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 3;
    if (p.hp <= 0 && f.active) {
      this.disable(f);
      return true;
    }
    return false;
  }

  disable(f: Fence): void {
    f.active = false;
    f.box.enabled = false;
    for (const b of f.beams) b.visible = false;
    for (const p of f.pylons) (p.mesh.material as THREE.MeshStandardMaterial).emissive.setRGB(0.05, 0.05, 0.05);
    this.onDisabled?.(f);
  }

  update(time: number, dt: number): void {
    this.beamMat.opacity = 0.75 + Math.sin(time * 30) * 0.15;
    for (const f of this.list) {
      if (!f.active) continue;
      f.beams.forEach((b, i) => { b.position.y = 0.45 + i * 0.55 + Math.sin(time * 3 + i) * 0.04; });
      for (const p of f.pylons) {
        const m = p.mesh.material as THREE.MeshStandardMaterial;
        m.emissiveIntensity = Math.max(0.9, m.emissiveIntensity - dt * 8);
      }
    }
  }
}

/** Ray against nothing but the near side of fences (bullets pass through beams). */
export const RAY_IGNORE_FOR_SHOTS: ReadonlySet<Box["kind"]> = new Set(["fence"]);

// ---------------------------------------------------------------- uplink zone

export class UplinkZone {
  group = new THREE.Group();
  private ringMat: THREE.ShaderMaterial;
  active = false;

  constructor(public x: number, public z: number, public radius: number, uTime: { value: number }) {
    this.ringMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uTime, uProgress: { value: 0 }, uActive: { value: 0 }, uInside: { value: 0 } },
      vertexShader: /* glsl */ `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uProgress; uniform float uActive; uniform float uInside; varying vec2 vP;
        void main(){
          float r = length(vP) / ${radius.toFixed(1)};
          float a = atan(vP.y, vP.x) / 6.28318 + 0.5;
          float edge = smoothstep(0.94, 0.98, r) * (1.0 - smoothstep(0.99, 1.0, r));
          float prog = step(a, uProgress) * smoothstep(0.82, 0.86, r) * (1.0 - smoothstep(0.92, 0.94, r));
          float ripple = smoothstep(0.03, 0.0, abs(fract(r * 3.0 - uTime * 0.6) - 0.5)) * (1.0 - r) * 0.5;
          vec3 c = vec3(0.2, 1.0, 0.6) * (edge * (0.4 + uActive * 1.6) + prog * 2.5 + ripple * uActive * (0.5 + uInside));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 64).rotateX(-Math.PI / 2), this.ringMat);
    disc.position.set(x, 0.07, z);
    this.group.add(disc);
  }

  set(progress: number, active: boolean, inside: boolean): void {
    this.active = active;
    this.ringMat.uniforms.uProgress.value = progress;
    this.ringMat.uniforms.uActive.value = active ? 1 : 0.25;
    this.ringMat.uniforms.uInside.value = inside ? 1 : 0;
  }
}

// ---------------------------------------------------------------- repair kits

export class Medkits {
  group = new THREE.Group();
  kits: { pos: THREE.Vector3; mesh: THREE.Group; readyAt: number }[] = [];

  constructor(points: { x: number; z: number }[]) {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 2.4, 1.0), toneMapped: false });
    const cross = mergeGeometries([new THREE.BoxGeometry(0.7, 0.22, 0.22), new THREE.BoxGeometry(0.22, 0.7, 0.22)])!;
    for (const p of points) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(cross, mat));
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.85, 24).rotateX(-Math.PI / 2), additive(new THREE.Color(0.3, 1.6, 0.8), 0.8));
      ring.position.y = -1.0;
      g.add(ring);
      g.position.set(p.x, 1.2, p.z);
      this.group.add(g);
      this.kits.push({ pos: new THREE.Vector3(p.x, 0, p.z), mesh: g, readyAt: 0 });
    }
  }

  /** Returns true if a kit was picked up at this position. */
  tryPickup(pos: THREE.Vector3, now: number): boolean {
    for (const k of this.kits) {
      if (k.readyAt > now) continue;
      if (Math.hypot(k.pos.x - pos.x, k.pos.z - pos.z) < 1.6) { k.readyAt = now + 40; return true; }
    }
    return false;
  }

  update(now: number): void {
    for (const k of this.kits) {
      k.mesh.visible = k.readyAt <= now;
      k.mesh.rotation.y = now * 1.5;
      k.mesh.position.y = 1.2 + Math.sin(now * 2 + k.pos.x) * 0.15;
    }
  }
}

export { raySphere };
