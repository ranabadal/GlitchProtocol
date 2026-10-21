import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BLOCK, blockCenter, doorInfo, getCity, GRID, HALF, LOBBY_H, PITCH, ROAD, roadPos, SIDE_NORMAL, SIDEWALK, type Building } from "@/lib/shared/city";
import type { Colliders } from "../Colliders";
import { billboardAtlas, glyphAtlas, radialTexture, signAtlas } from "./Textures";

/*
 * Builds the fixed Neon City: ground with roads and sidewalks (one shader), every
 * building in a single instanced draw call with shader-generated windows, street
 * lights, neon name signs, rooftop billboards, parks, uplink towers and the NULL
 * Spire. Mission vault buildings are left hollow at street level for the Director
 * to fill with an enterable lobby.
 */

export interface CityUniforms {
  uTime: { value: number };
  uCorrupt: { value: number };
  uHealCenter: { value: THREE.Vector2 };
  uHealRadius: { value: number };
  uGlyphs: { value: THREE.Texture };
  /** 0 = night, 0.5 = sunset, 1 = day. */
  uDay: { value: number };
}

export const PALETTE = [
  new THREE.Color(0.25, 1.0, 0.55), // matrix green
  new THREE.Color(0.25, 0.85, 1.0), // cyan
  new THREE.Color(1.0, 0.62, 0.25), // amber
  new THREE.Color(1.0, 0.3, 0.75), // magenta
  new THREE.Color(0.3, 1.0, 0.5), // code rain
];

const GLSL_HASH = /* glsl */ `
float gpH21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
`;

function buildingMaterial(u: CityUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x0c1116, roughness: 0.5, metalness: 0.45 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u, { uPalette: { value: PALETTE } });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        attribute vec2 aStyle;
        varying vec3 vGpWorld; varying vec3 vGpN; flat varying float vGpTop; flat varying vec2 vGpStyle;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        mat4 gpM = modelMatrix;
        #ifdef USE_INSTANCING
          gpM = modelMatrix * instanceMatrix;
        #endif
        vGpWorld = (gpM * vec4(position, 1.0)).xyz;
        vGpN = normalize(mat3(gpM) * normal);
        vGpTop = (gpM * vec4(0.0, 1.0, 0.0, 1.0)).y;
        vGpStyle = aStyle;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform float uTime; uniform float uCorrupt; uniform vec2 uHealCenter; uniform float uHealRadius; uniform float uDay;
        uniform vec3 uPalette[5]; uniform sampler2D uGlyphs;
        varying vec3 vGpWorld; varying vec3 vGpN; flat varying float vGpTop; flat varying vec2 vGpStyle;
        ${GLSL_HASH}
        vec3 gpDayCol = vec3(0.5);
        vec3 gpFacade(out float panel) {
          panel = 1.0;
          // Screen-space derivatives must be taken before any branch or early return.
          vec3 gpFwW = fwidth(vGpWorld);
          vec3 n = abs(vGpN);
          int style = int(vGpStyle.x + 0.5);
          vec3 col = uPalette[style];
          float healed = smoothstep(uHealRadius, uHealRadius - 30.0, distance(vGpWorld.xz, uHealCenter));
          col = mix(col, vec3(0.75, 1.0, 1.0), healed * 0.6);
          // Daylight materials: concrete, blue glass, sandstone, mauve panels; dark glass code towers.
          vec3 dayBase = style == 0 ? vec3(0.62, 0.64, 0.66) : style == 1 ? vec3(0.36, 0.5, 0.64) : style == 2 ? vec3(0.74, 0.64, 0.52) : style == 3 ? vec3(0.62, 0.56, 0.64) : vec3(0.1, 0.16, 0.14);
          dayBase *= 0.88 + 0.24 * gpH21(vec2(floor(vGpStyle.y * 997.0 + 0.5), 7.0));
          if (n.y > 0.5) {
            vec2 g = abs(fract(vGpWorld.xz / 3.0) - 0.5);
            gpDayCol = vec3(0.44, 0.45, 0.47) * (0.9 + 0.1 * step(0.47, max(g.x, g.y)));
            return col * step(0.47, max(g.x, g.y)) * 0.12;
          }
          gpDayCol = dayBase;
          float u = n.x > 0.5 ? vGpWorld.z : vGpWorld.x;
          float v = vGpWorld.y;
          vec3 e = col * smoothstep(0.45, 0.0, abs(v - (vGpTop - 0.35))) * 1.8;
          e += col * smoothstep(0.3, 0.0, abs(v - 7.0)) * 0.8;
          // Corruption: some buildings glitch red for a moment.
          float bseed = floor(vGpStyle.y * 997.0 + 0.5) * 0.01;
          float glitch = step(1.0 - uCorrupt * 0.07, gpH21(vec2(bseed, floor(uTime * 1.3)))) * (1.0 - healed);
          float band = step(0.5, gpH21(vec2(floor(v * 0.4), floor(uTime * 12.0))));
          if (style == 4) {
            float colW = 1.4;
            float cx = floor(u / colW);
            float sp = 3.0 + 7.0 * gpH21(vec2(cx, bseed));
            float yy = v + uTime * sp;
            float row = floor(yy / 1.4);
            vec2 lf = vec2(fract(u / colW), fract(yy / 1.4));
            float gi = floor(gpH21(vec2(cx, row + floor(uTime * 2.0 * gpH21(vec2(row, cx))))) * 64.0);
            vec2 guv = (vec2(mod(gi, 8.0), floor(gi / 8.0)) + vec2(lf.x, 1.0 - lf.y)) / 8.0;
            float glyph = texture2D(uGlyphs, guv).r;
            float trail = fract(yy / (50.0 + 40.0 * gpH21(vec2(cx, 3.0))) + gpH21(vec2(cx, 9.0)));
            e += mix(vec3(0.25, 1.0, 0.45), vec3(0.85, 1.0, 0.9), step(0.97, trail)) * glyph * pow(trail, 3.0) * 2.2;
            panel = 0.7;
            gpDayCol = dayBase + vec3(0.05, 0.25, 0.12) * glyph * pow(trail, 3.0);
          } else {
            vec2 cell = vec2(u / 3.0, v / 3.5);
            vec2 id = floor(cell);
            vec2 f = fract(cell);
            float win = step(0.16, f.x) * step(f.x, 0.84) * step(0.24, f.y) * step(f.y, 0.78);
            float r = gpH21(id + bseed * 17.0);
            float lit = step(0.5 - healed * 0.35, r);
            lit *= 1.0 - step(0.992, gpH21(id + floor(uTime * 0.6)));
            float tone = 0.45 + 0.55 * gpH21(id.yx + 3.1);
            vec3 wc = mix(col, vec3(1.0, 0.95, 0.85), 0.25 * step(0.8, gpH21(id + 5.0)));
            // Far away, windows are smaller than a pixel: blend to their average glow (no moire).
            vec2 gpFw = vec2((n.x > 0.5 ? gpFwW.z : gpFwW.x) / 3.0, gpFwW.y / 3.5);
            float gpFar = smoothstep(0.18, 0.55, max(gpFw.x, gpFw.y));
            float gpWin = mix(win * lit * tone, 0.37 * (0.5 + healed * 0.35) * 0.72, gpFar);
            e += wc * gpWin * 0.8 * (v > 7.0 ? 1.0 : 0.0);
            // By day the windows are dark reflective glass set into the facade.
            float dayWin = mix(win, 0.45, gpFar) * (v > 7.0 ? 1.0 : 0.0);
            gpDayCol = mix(dayBase, vec3(0.14, 0.22, 0.32) + 0.06 * tone, dayWin * 0.8);
            if (v < 6.0 && v > 0.8) gpDayCol = mix(gpDayCol, vec3(0.1, 0.13, 0.16), 0.7);
            // Street-level storefront glow.
            e += col * step(v, 6.0) * step(0.8, v) * 0.22 * step(0.15, fract(u / 6.0));
            panel = 0.85 + 0.3 * step(0.5, fract(u / 3.0));
          }
          if (glitch > 0.5) e = mix(e, vec3(1.0, 0.08, 0.2) * band * 1.6, 0.85);
          return e;
        }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        float gpPanel; vec3 gpE = gpFacade(gpPanel);
        diffuseColor.rgb = mix(diffuseColor.rgb * gpPanel, gpDayCol, uDay);`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        totalEmissiveRadiance += gpE * mix(1.0, 0.2, uDay);`);
  };
  return m;
}

function groundMaterial(u: CityUniforms, blockKinds: number[]): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.2 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u, { uKinds: { value: blockKinds } });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        varying vec3 vGpWorld;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vGpWorld = (modelMatrix * vec4(position, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform float uTime; uniform float uKinds[49]; uniform vec2 uHealCenter; uniform float uHealRadius; uniform float uDay;
        varying vec3 vGpWorld;
        ${GLSL_HASH}
        const float PITCH = ${PITCH.toFixed(1)};
        const float R0 = ${roadPos(0).toFixed(1)};
        const float HALFW = ${(ROAD / 2).toFixed(1)};
        const float WALK = ${(ROAD / 2 + SIDEWALK).toFixed(1)};
        const float EDGE = ${HALF.toFixed(1)};
        vec3 gpEmit = vec3(0.0);
        vec3 gpDayG = vec3(0.35);
        float gpRough = 0.5;
        vec3 gpGround() {
          vec2 p = vGpWorld.xz;
          if (abs(p.x) > EDGE || abs(p.y) > EDGE) {
            vec2 g = abs(fract(p / 6.0) - 0.5);
            float line = step(0.46, max(g.x, g.y));
            gpEmit = vec3(0.1, 0.9, 0.45) * line * 0.25 * (0.6 + 0.4 * sin(uTime * 2.0 + p.x * 0.05));
            gpRough = 0.9;
            gpDayG = vec3(0.22, 0.27, 0.2);
            return vec3(0.0);
          }
          vec2 q = (p - R0) / PITCH;
          vec2 dr = abs(fract(q + 0.5) - 0.5) * PITCH;
          bool vRoad = dr.x < HALFW;
          bool hRoad = dr.y < HALFW;
          if (vRoad || hRoad) {
            gpRough = 0.36 + 0.08 * gpH21(floor(p * 0.5));
            vec3 c = vec3(0.022, 0.026, 0.032);
            bool inter = vRoad && hRoad;
            float along = vRoad && !hRoad ? p.y : p.x;
            float across = vRoad && !hRoad ? dr.x : dr.y;
            if (!inter) {
              if (abs(across - 0.35) < 0.12) gpEmit += vec3(1.0, 0.75, 0.2) * 0.35;
              if (abs(across - 5.0) < 0.1 && fract(along / 6.0) < 0.5) gpEmit += vec3(0.8) * 0.25;
              if (abs(across - (HALFW - 0.4)) < 0.08) gpEmit += vec3(0.8) * 0.18;
            } else {
              // Crosswalk stripes at the mouth of each road.
              vec2 dd = dr;
              if ((dd.y > HALFW - 3.2 && dd.x < HALFW - 0.6) && fract(p.x / 1.4) < 0.5) gpEmit += vec3(0.75) * 0.22;
              if ((dd.x > HALFW - 3.2 && dd.y < HALFW - 0.6) && fract(p.y / 1.4) < 0.5) gpEmit += vec3(0.75) * 0.22;
            }
            gpDayG = vec3(0.13, 0.135, 0.145) * (0.9 + 0.2 * gpH21(floor(p * 0.5)));
            return c;
          }
          if (dr.x < WALK || dr.y < WALK) {
            vec2 g = abs(fract(p / 2.0) - 0.5);
            float tile = step(0.47, max(g.x, g.y));
            gpRough = 0.7;
            float curb = (dr.x < HALFW + 0.25 || dr.y < HALFW + 0.25) ? 1.0 : 0.0;
            gpEmit += vec3(0.2, 0.9, 1.0) * curb * 0.35;
            gpDayG = vec3(0.5, 0.49, 0.47) * (0.85 + 0.15 * tile) * (1.0 - curb * 0.35);
            return vec3(0.07, 0.075, 0.085) * (0.85 + 0.15 * tile);
          }
          float bj = floor((p.x - R0) / PITCH);
          float bl = floor((p.y - R0) / PITCH);
          int idx = int(clamp(bj, 0.0, 6.0) + clamp(bl, 0.0, 6.0) * 7.0);
          float kind = uKinds[idx];
          if (kind > 3.5) {
            gpRough = 0.95;
            float n = gpH21(floor(p * 1.5));
            gpDayG = vec3(0.17, 0.34, 0.12) * (0.75 + 0.5 * n);
            return vec3(0.01, 0.05, 0.03) * (0.7 + 0.6 * n);
          }
          if (kind > 2.5) {
            vec2 g = abs(fract(p / 4.0) - 0.5);
            float line = step(0.48, max(g.x, g.y));
            gpEmit += vec3(0.2, 1.0, 0.7) * line * 0.25;
            gpRough = 0.3;
            gpDayG = vec3(0.6, 0.6, 0.57) * (0.92 + 0.08 * line);
            return vec3(0.03, 0.04, 0.045);
          }
          if (kind > 0.5 && kind < 1.5) {
            float r = length(p - vec2(${blockCenter(3).toFixed(1)}));
            gpEmit += vec3(1.0, 0.1, 0.2) * step(0.92, fract(r / 4.0 - uTime * 0.3)) * 0.4;
            gpRough = 0.25;
            gpDayG = vec3(0.24, 0.1, 0.12);
            return vec3(0.02, 0.01, 0.015);
          }
          vec2 g = abs(fract(p / 5.0) - 0.5);
          gpRough = 0.6;
          gpDayG = vec3(0.38, 0.38, 0.37) * (0.9 + 0.1 * step(0.48, max(g.x, g.y)));
          return vec3(0.045, 0.05, 0.055) * (0.85 + 0.15 * step(0.48, max(g.x, g.y)));
        }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        vec3 gpNight = gpGround();
        // By day, lane lines and curbs are paint rather than glow.
        diffuseColor.rgb = mix(gpNight, min(gpDayG + gpEmit * 1.6, vec3(0.95)), uDay);`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = gpRough;`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        float gpHeal = smoothstep(uHealRadius, uHealRadius - 40.0, distance(vGpWorld.xz, uHealCenter));
        totalEmissiveRadiance += gpEmit * (1.0 + gpHeal * 1.5) * (1.0 - uDay * 0.85);`);
  };
  return m;
}

export class CityView {
  group = new THREE.Group();
  uniforms: CityUniforms;
  private spireRings: THREE.Mesh[] = [];
  private spireCore: THREE.Mesh | null = null;
  private signMat: THREE.ShaderMaterial | null = null;
  private billboardMat: THREE.ShaderMaterial | null = null;
  private curtainMat: THREE.ShaderMaterial | null = null;
  /** Materials that change colour between night and day: [material, night, day, night glow, day glow]. */
  private dayMats: [THREE.MeshStandardMaterial | THREE.MeshBasicMaterial, THREE.Color, THREE.Color, number, number][] = [];
  private shade(m: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial, day: number, glowNight = 0, glowDay = 0): typeof m {
    this.dayMats.push([m, m.color.clone(), new THREE.Color(day), glowNight, glowDay]);
    return m;
  }
  uplinkTowers: { x: number; z: number; beacon: THREE.Mesh }[] = [];

  constructor(colliders: Colliders, opts: { hollow: Set<string> }) {
    const city = getCity();
    this.uniforms = {
      uTime: { value: 0 },
      uCorrupt: { value: 1 },
      uHealCenter: { value: new THREE.Vector2(9999, 9999) },
      uHealRadius: { value: 0 },
      uGlyphs: { value: glyphAtlas() },
      uDay: { value: 0 },
    };
    const glyphs = this.uniforms.uGlyphs.value;
    glyphs.generateMipmaps = false;
    glyphs.minFilter = THREE.LinearFilter;

    // ---- ground
    const kinds = new Array(49).fill(0);
    for (const b of city.blocks) kinds[b.j + b.l * 7] = { buildings: 0, spire: 1, safehouse: 2, plaza: 3, park: 4 }[b.kind];
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(HALF * 2 + 400, HALF * 2 + 400, 1, 1), groundMaterial(this.uniforms, kinds));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.group.add(ground);

    // ---- curbs (visual only)
    const curbGeo = new THREE.BoxGeometry(1, 0.18, 1);
    curbGeo.translate(0, 0.09, 0);
    const curbs = new THREE.InstancedMesh(curbGeo, this.shade(new THREE.MeshStandardMaterial({ color: 0x1a2128, roughness: 0.8 }), 0x9a9a95), city.blocks.length * 4);
    const m4 = new THREE.Matrix4();
    let ci = 0;
    for (const b of city.blocks) {
      const s = BLOCK, t = 0.35;
      for (const [x, z, w, d] of [[b.x, b.z - s / 2, s, t], [b.x, b.z + s / 2, s, t], [b.x - s / 2, b.z, t, s], [b.x + s / 2, b.z, t, s]]) {
        m4.compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion(), new THREE.Vector3(w, 1, d));
        curbs.setMatrixAt(ci++, m4);
      }
    }
    this.group.add(curbs);

    // ---- buildings
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    boxGeo.translate(0, 0.5, 0);
    const blds = city.buildings;
    const styleAttr = new Float32Array(blds.length * 2);
    const mesh = new THREE.InstancedMesh(boxGeo, buildingMaterial(this.uniforms), blds.length);
    blds.forEach((b, i) => {
      const hollow = opts.hollow.has(b.id);
      const baseY = hollow ? LOBBY_H : 0;
      m4.compose(new THREE.Vector3(b.x, baseY, b.z), new THREE.Quaternion(), new THREE.Vector3(b.w, b.h - baseY, b.d));
      mesh.setMatrixAt(i, m4);
      const codeRain = (i * 7) % 9 === 0 && b.h > 30;
      styleAttr[i * 2] = codeRain ? 4 : b.style % 4;
      styleAttr[i * 2 + 1] = (i * 0.618) % 1;
      if (!hollow) colliders.addRect(b.x, b.z, b.w, b.d, b.h, "building");
    });
    boxGeo.setAttribute("aStyle", new THREE.InstancedBufferAttribute(styleAttr, 2));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);

    // Rooftop antennas with blinking lights.
    const ant = blds.filter((b) => b.antenna);
    const antGeo = new THREE.CylinderGeometry(0.15, 0.3, 1, 5);
    antGeo.translate(0, 0.5, 0);
    const antMesh = new THREE.InstancedMesh(antGeo, new THREE.MeshStandardMaterial({ color: 0x222831, metalness: 0.8, roughness: 0.4 }), ant.length);
    const tipMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.45, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.2, 0.3), toneMapped: false }), ant.length);
    ant.forEach((b, i) => {
      const h = 8 + (i % 4) * 4;
      m4.compose(new THREE.Vector3(b.x + b.w * 0.2, b.h, b.z - b.d * 0.2), new THREE.Quaternion(), new THREE.Vector3(1, h, 1));
      antMesh.setMatrixAt(i, m4);
      m4.compose(new THREE.Vector3(b.x + b.w * 0.2, b.h + h, b.z - b.d * 0.2), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
      tipMesh.setMatrixAt(i, m4);
    });
    this.group.add(antMesh, tipMesh);

    // ---- neon signs above lobby doors
    const signBuildings = blds.filter((b) => b.door && (b.lobby || b.name === "Safehouse") && !opts.hollow.has(b.id));
    const atlas = signAtlas(Array.from(new Set(signBuildings.map((b) => b.name))));
    this.signMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: atlas.texture }, uTime: this.uniforms.uTime },
      vertexShader: /* glsl */ `
        attribute vec4 aUv; attribute float aSeed; varying vec2 vUv; flat varying float vSeed;
        void main(){ vUv = aUv.xy + uv * aUv.zw; vSeed = aSeed; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap; uniform float uTime; varying vec2 vUv; flat varying float vSeed;
        ${GLSL_HASH}
        void main(){
          vec3 c = texture2D(uMap, vUv).rgb;
          float flick = 0.75 + 0.25 * step(0.08, gpH21(vec2(vSeed, floor(uTime * 9.0))));
          gl_FragColor = vec4(c * 2.2 * flick, 1.0);
        }`,
      toneMapped: false,
    });
    const signGeo = new THREE.PlaneGeometry(1, 1);
    const uvAttr = new Float32Array(signBuildings.length * 4);
    const seedAttr = new Float32Array(signBuildings.length);
    const signs = new THREE.InstancedMesh(signGeo, this.signMat, signBuildings.length);
    signBuildings.forEach((b, i) => {
      const di = doorInfo(b);
      const [nx, nz] = SIDE_NORMAL[b.door!];
      const face = b.door === "px" || b.door === "nx" ? b.d : b.w;
      const w = Math.min(face * 0.7, 16);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(nx, nz));
      m4.compose(new THREE.Vector3(di.door.x + nx * 0.3, 9.2, di.door.z + nz * 0.3), q, new THREE.Vector3(w, w / 4, 1));
      signs.setMatrixAt(i, m4);
      const slot = atlas.slot.get(b.name) ?? 0;
      uvAttr.set([(slot % atlas.cols) / atlas.cols, 1 - (Math.floor(slot / atlas.cols) + 1) / atlas.rows, 1 / atlas.cols, 1 / atlas.rows], i * 4);
      seedAttr[i] = i * 0.37;
    });
    signGeo.setAttribute("aUv", new THREE.InstancedBufferAttribute(uvAttr, 4));
    signGeo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seedAttr, 1));
    this.group.add(signs);

    // ---- rooftop billboards
    const bb = billboardAtlas();
    this.billboardMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: bb.texture }, uTime: this.uniforms.uTime, uCount: { value: bb.count } },
      vertexShader: /* glsl */ `
        attribute float aAd; varying vec2 vUv; flat varying float vAd;
        void main(){ vUv = uv; vAd = aAd; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap; uniform float uTime; uniform float uCount; varying vec2 vUv; flat varying float vAd;
        ${GLSL_HASH}
        void main(){
          float slot = mod(vAd + floor(uTime / 7.0), uCount);
          float g = step(0.93, gpH21(vec2(floor(vUv.y * 20.0), floor(uTime * 8.0)))) * 0.03;
          vec2 uv = vec2(vUv.x + g, (vUv.y + (uCount - 1.0 - slot)) / uCount);
          vec3 c = texture2D(uMap, uv).rgb;
          c *= 0.85 + 0.15 * sin(vUv.y * 400.0 + uTime * 10.0);
          gl_FragColor = vec4(c * 1.8, 1.0);
        }`,
      toneMapped: false,
    });
    const tall = blds.filter((b) => b.h > 60 && !opts.hollow.has(b.id)).slice(0, 10);
    const bbGeo = new THREE.PlaneGeometry(1, 1);
    const adAttr = new Float32Array(tall.length);
    const boards = new THREE.InstancedMesh(bbGeo, this.billboardMat, tall.length);
    tall.forEach((b, i) => {
      // Face the city centre.
      const ang = Math.atan2(-b.x, -b.z);
      const sideX = Math.abs(Math.sin(ang)) > Math.abs(Math.cos(ang));
      const nx = sideX ? Math.sign(-b.x) : 0, nz = sideX ? 0 : Math.sign(-b.z);
      const w = Math.min((sideX ? b.d : b.w) * 0.9, 26);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(nx, nz));
      m4.compose(new THREE.Vector3(b.x + nx * (b.w / 2 + 0.6), b.h - w * 0.25 - 4, b.z + nz * (b.d / 2 + 0.6)), q, new THREE.Vector3(w, w / 4, 1));
      boards.setMatrixAt(i, m4);
      adAttr[i] = i % bb.count;
    });
    bbGeo.setAttribute("aAd", new THREE.InstancedBufferAttribute(adAttr, 1));
    this.group.add(boards);

    // ---- street lights and light pools
    const poleGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.12, 0.18, 8, 6).translate(0, 4, 0),
      new THREE.BoxGeometry(0.15, 0.15, 2.4).translate(0, 7.9, 1.1),
    ])!;
    const lampGeo = new THREE.BoxGeometry(0.5, 0.18, 1.1).translate(0, 7.8, 2.1);
    const spots: { x: number; z: number; rot: number; warm: boolean }[] = [];
    for (const e of city.edges) {
      for (const t of [0.3, 0.7]) {
        for (const side of [-1, 1]) {
          const x = e.x0 + (e.x1 - e.x0) * t, z = e.z0 + (e.z1 - e.z0) * t;
          const off = ROAD / 2 + 1.2;
          const px = e.horizontal ? x : x + side * off;
          const pz = e.horizontal ? z + side * off : z;
          if (Math.abs(px) > HALF - 2 || Math.abs(pz) > HALF - 2) continue;
          // Arm points toward the road centre.
          const rot = e.horizontal ? (side > 0 ? Math.PI : 0) : (side > 0 ? -Math.PI / 2 : Math.PI / 2);
          spots.push({ x: px, z: pz, rot, warm: (spots.length % 5) === 0 });
        }
      }
    }
    const poleMesh = new THREE.InstancedMesh(poleGeo, this.shade(new THREE.MeshStandardMaterial({ color: 0x1b2229, metalness: 0.7, roughness: 0.45 }), 0x5d646c), spots.length);
    const lampMesh = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), spots.length);
    const poolMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: radialTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      spots.length,
    );
    this.lampPools = poolMesh.material as THREE.MeshBasicMaterial;
    const cool = new THREE.Color(0.55, 1.6, 1.4), warm = new THREE.Color(2.0, 1.2, 0.5);
    spots.forEach((s, i) => {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.rot);
      m4.compose(new THREE.Vector3(s.x, 0, s.z), q, new THREE.Vector3(1, 1, 1));
      poleMesh.setMatrixAt(i, m4);
      lampMesh.setMatrixAt(i, m4);
      lampMesh.setColorAt(i, s.warm ? warm : cool);
      const fwd = new THREE.Vector3(0, 0, 2.1).applyQuaternion(q);
      m4.compose(new THREE.Vector3(s.x + fwd.x, 0.03, s.z + fwd.z), new THREE.Quaternion(), new THREE.Vector3(13, 1, 13));
      poolMesh.setMatrixAt(i, m4);
      poolMesh.setColorAt(i, (s.warm ? warm : cool).clone().multiplyScalar(0.11));
      colliders.addRect(s.x, s.z, 0.4, 0.4, 8, "prop");
    });
    this.group.add(poleMesh, lampMesh, poolMesh);

    // ---- park trees (neon canopies)
    const trunkMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.3, 1, 6).translate(0, 0.5, 0), this.shade(new THREE.MeshStandardMaterial({ color: 0x2a1f1a, roughness: 0.9 }), 0x5a4232), city.trees.length);
    const canopyMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), this.shade(new THREE.MeshStandardMaterial({ color: 0x0a2a1a, emissive: 0x1aff7a, emissiveIntensity: 0.35, roughness: 0.6, flatShading: true }), 0x3f8f34, 0.35, 0.04), city.trees.length);
    city.trees.forEach((t, i) => {
      m4.compose(new THREE.Vector3(t.x, 0, t.z), new THREE.Quaternion(), new THREE.Vector3(1, t.h * 0.55, 1));
      trunkMesh.setMatrixAt(i, m4);
      m4.compose(new THREE.Vector3(t.x, t.h * 0.7, t.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, i, 0)), new THREE.Vector3(2.4, t.h * 0.42, 2.4));
      canopyMesh.setMatrixAt(i, m4);
      colliders.addRect(t.x, t.z, 0.8, 0.8, t.h, "prop");
    });
    this.group.add(trunkMesh, canopyMesh);

    // ---- uplink towers on every plaza
    const plazas = city.blocks.filter((b) => b.kind === "plaza");
    const towerGeo = mergeGeometries([
      new THREE.CylinderGeometry(1.0, 3.2, 34, 6, 1, true).translate(0, 17, 0),
      new THREE.CylinderGeometry(3.6, 3.6, 0.6, 12).translate(0, 0.3, 0),
      new THREE.TorusGeometry(2.4, 0.18, 6, 16).rotateX(Math.PI / 2).translate(0, 12, 0),
      new THREE.TorusGeometry(1.8, 0.18, 6, 16).rotateX(Math.PI / 2).translate(0, 22, 0),
      new THREE.SphereGeometry(3.2, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2.5).rotateX(Math.PI * 0.7).translate(0, 33, 1),
      new THREE.CylinderGeometry(0.15, 0.15, 8, 4).translate(0, 38, 0),
    ])!;
    const towers = new THREE.InstancedMesh(towerGeo, this.shade(new THREE.MeshStandardMaterial({ color: 0x1d262e, metalness: 0.8, roughness: 0.35, emissive: 0x0a3a2a, emissiveIntensity: 0.6, side: THREE.DoubleSide }), 0x8d9aa4, 0.6, 0.15), plazas.length);
    const beaconGeo = new THREE.CylinderGeometry(0.9, 0.9, 400, 8, 1, true).translate(0, 200, 0);
    plazas.forEach((p, i) => {
      m4.makeTranslation(p.x, 0, p.z);
      towers.setMatrixAt(i, m4);
      colliders.addRect(p.x, p.z, 7, 7, 40, "tower");
      const beacon = new THREE.Mesh(beaconGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 1.4, 0.7), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      beacon.position.set(p.x, 0, p.z);
      beacon.visible = false;
      this.group.add(beacon);
      this.uplinkTowers.push({ x: p.x, z: p.z, beacon });
    });
    this.group.add(towers);

    // ---- NULL Spire
    const spire = city.blocks.find((b) => b.kind === "spire")!;
    const spireMat = new THREE.MeshStandardMaterial({ color: 0x0a0a10, metalness: 0.9, roughness: 0.25, emissive: 0x330008, emissiveIntensity: 0.6, flatShading: true });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(17, 19, 5, 8), spireMat);
    base.position.set(spire.x, 2.5, spire.z);
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 11, 210, 6), spireMat);
    tower.position.set(spire.x, 110, spire.z);
    const stripes = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 11.2, 210, 6, 30, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 0.1, 0.25), wireframe: true, transparent: true, opacity: 0.35, toneMapped: false }));
    stripes.position.copy(tower.position);
    this.group.add(base, tower, stripes);
    for (const [h, r] of [[60, 16], [120, 11], [175, 7]]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.45, 6, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.15, 0.3), toneMapped: false }));
      ring.position.set(spire.x, h, spire.z);
      ring.rotation.x = Math.PI / 2;
      this.spireRings.push(ring);
      this.group.add(ring);
    }
    this.spireCore = new THREE.Mesh(new THREE.IcosahedronGeometry(6, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.2, 0.35), wireframe: true, toneMapped: false }));
    this.spireCore.position.set(spire.x, 228, spire.z);
    this.group.add(this.spireCore);
    colliders.addRect(spire.x, spire.z, 34, 34, 230, "tower");

    // ---- edge of the world: a curtain of falling code
    this.curtainMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uniforms.uTime, uGlyphs: this.uniforms.uGlyphs, uDay: this.uniforms.uDay },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vW = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform sampler2D uGlyphs; uniform float uDay; varying vec2 vUv; varying vec3 vW;
        ${GLSL_HASH}
        void main(){
          float u = (abs(vW.x) > ${(HALF + 19).toFixed(1)} ? vW.z : vW.x);
          float cx = floor(u / 2.0);
          float sp = 6.0 + 10.0 * gpH21(vec2(cx, 1.0));
          float yy = vW.y + uTime * sp;
          float row = floor(yy / 2.0);
          vec2 lf = vec2(fract(u / 2.0), fract(yy / 2.0));
          float gi = floor(gpH21(vec2(cx, row)) * 64.0);
          float g = texture2D(uGlyphs, (vec2(mod(gi, 8.0), floor(gi / 8.0)) + vec2(lf.x, 1.0 - lf.y)) / 8.0).r;
          float trail = fract(yy / (40.0 + 30.0 * gpH21(vec2(cx, 4.0))) + gpH21(vec2(cx, 2.0)));
          float fade = smoothstep(120.0, 10.0, vW.y);
          // By day the edge-of-the-city code wall is darker green so it reads against the bright sky.
          vec3 col = mix(vec3(0.2, 1.0, 0.45) * 1.5, vec3(0.05, 0.35, 0.12), uDay);
          gl_FragColor = vec4(col * g * pow(trail, 2.5) * fade, 1.0);
        }`,
    });
    const span = HALF * 2 + 40;
    for (const [x, z, ry] of [[0, -HALF - 20, 0], [0, HALF + 20, 0], [-HALF - 20, 0, Math.PI / 2], [HALF + 20, 0, Math.PI / 2]]) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(span, 140), this.curtainMat);
      wall.position.set(x, 70, z);
      wall.rotation.y = ry;
      this.group.add(wall);
    }
    for (const [x, z, w, d] of [[0, -HALF - 1, HALF * 2, 2], [0, HALF + 1, HALF * 2, 2], [-HALF - 1, 0, 2, HALF * 2], [HALF + 1, 0, 2, HALF * 2]]) {
      colliders.addRect(x, z, w, d, 200, "boundary");
    }
  }

  private lampPools: THREE.MeshBasicMaterial | null = null;

  /** 0 = night, 0.5 = sunset, 1 = day. */
  setDay(day: number): void {
    this.uniforms.uDay.value = day;
    for (const [m, night, dayC, gN, gD] of this.dayMats) {
      m.color.copy(night).lerp(dayC, day);
      if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial && (gN || gD)) (m as THREE.MeshStandardMaterial).emissiveIntensity = gN + (gD - gN) * day;
    }
    // Street-light pools only show after dark.
    if (this.lampPools) this.lampPools.opacity = 1 - day * 0.9;
  }

  setUplinkBeacon(x: number, z: number, on: boolean, color = new THREE.Color(0.2, 1.6, 0.8)): void {
    for (const t of this.uplinkTowers) {
      const active = on && Math.abs(t.x - x) < 1 && Math.abs(t.z - z) < 1;
      t.beacon.visible = active;
      (t.beacon.material as THREE.MeshBasicMaterial).color.copy(color);
    }
  }

  update(time: number, dt: number): void {
    this.uniforms.uTime.value = time;
    this.spireRings.forEach((r, i) => { r.rotation.z += dt * (0.2 + i * 0.15) * (i % 2 ? -1 : 1); });
    if (this.spireCore) {
      this.spireCore.rotation.y += dt * 0.4;
      this.spireCore.rotation.x += dt * 0.2;
      const s = 1 + Math.sin(time * 3) * 0.08 * this.uniforms.uCorrupt.value;
      this.spireCore.scale.setScalar(s);
    }
    for (const t of this.uplinkTowers) {
      if (!t.beacon.visible) continue;
      (t.beacon.material as THREE.MeshBasicMaterial).opacity = 0.18 + Math.sin(time * 4) * 0.06;
    }
  }
}

export const __city = { GRID };
export type { Building };
