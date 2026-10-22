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

/*
 * Building facades, all in one shader so the whole skyline is a single draw call.
 * Five looks (concrete office, glass curtain wall, sandstone apartments, ribbon-window
 * modern, dark "code" tower). Windows use interior mapping: every window shows a small
 * 3D room behind the glass (walls, floor, ceiling, furniture, blinds) that shifts with
 * the camera, and the glass itself is a low-roughness surface that reflects the sky.
 * Facades get panel joints, sills, rain streaks under windows, street grime and a roof
 * cap. Far away, the detail fades to its average colour so nothing shimmers.
 */
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
        float gpVN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(gpH21(i), gpH21(i + vec2(1.0, 0.0)), f.x), mix(gpH21(i + vec2(0.0, 1.0)), gpH21(i + vec2(1.0, 1.0)), f.x), f.y); }
        vec3 gpDayCol = vec3(0.5);
        float gpRoughF = 0.85;
        float gpMetalF = 0.0;
        vec3 gpGlassE = vec3(0.0);

        // A small room behind a window, seen through the glass. f = position in the window cell (0..1),
        // rd = view ray in facade space (x along the wall, y up, z into the building), size = cell size in metres.
        vec3 gpRoom(vec2 f, vec2 id, vec3 rd, vec2 size, float seed, out float blindsOut) {
          vec3 r = rd / vec3(size, 4.5);
          vec3 p = vec3(f, 0.0);
          vec3 t3;
          t3.x = ((r.x > 0.0 ? 1.0 : 0.0) - p.x) / (abs(r.x) < 1e-4 ? 1e-4 : r.x);
          t3.y = ((r.y > 0.0 ? 1.0 : 0.0) - p.y) / (abs(r.y) < 1e-4 ? 1e-4 : r.y);
          t3.z = (1.0 - p.z) / max(r.z, 1e-4);
          float t = min(min(t3.x, t3.y), t3.z);
          vec3 hp = p + r * t;
          float h1 = gpH21(id + seed), h2 = gpH21(id.yx + seed * 3.1), h3 = gpH21(id * 1.7 + seed);
          vec3 wall = h1 < 0.35 ? vec3(0.78, 0.74, 0.66) : h1 < 0.6 ? vec3(0.62, 0.68, 0.72) : h1 < 0.8 ? vec3(0.82, 0.8, 0.76) : vec3(0.55, 0.6, 0.52);
          vec3 c;
          if (t == t3.z) {
            c = wall;
            // Desk / sofa silhouette and a picture or screen on the back wall.
            float desk = step(hp.y, 0.3) * step(0.12 + h2 * 0.2, hp.x) * step(hp.x, 0.7 + h2 * 0.25);
            c = mix(c, vec3(0.22, 0.18, 0.15) * (0.7 + h3 * 0.6), desk);
            float pic = step(0.45, hp.y) * step(hp.y, 0.7) * step(0.3, hp.x) * step(hp.x, 0.55) * step(0.5, h3);
            c = mix(c, vec3(0.15, 0.25, 0.35), pic * 0.8);
          } else if (t == t3.y) {
            c = r.y > 0.0 ? vec3(0.9, 0.9, 0.88) : (h2 < 0.5 ? vec3(0.36, 0.27, 0.2) : vec3(0.45, 0.45, 0.46)) * (0.8 + 0.3 * h3);
          } else {
            c = wall * 0.82;
          }
          // Deeper inside is darker; a ceiling light near the window.
          c *= mix(1.0, 0.45, clamp(hp.z, 0.0, 1.0));
          // Blinds pulled down over part of the window.
          float bl = h3 < 0.45 ? 1.0 - h2 * 0.6 : 2.0;
          blindsOut = step(bl, f.y);
          return c;
        }

        vec3 gpFacade(out float panel) {
          panel = 1.0;
          // Screen-space derivatives must be taken before any branch or early return.
          vec3 gpFwW = fwidth(vGpWorld);
          vec3 n = abs(vGpN);
          int style = int(vGpStyle.x + 0.5);
          vec3 col = uPalette[style];
          float healed = smoothstep(uHealRadius, uHealRadius - 30.0, distance(vGpWorld.xz, uHealCenter));
          col = mix(col, vec3(0.75, 1.0, 1.0), healed * 0.6);
          float bseed = floor(vGpStyle.y * 997.0 + 0.5) * 0.01;
          float bh = gpH21(vec2(floor(vGpStyle.y * 997.0 + 0.5), 7.0));
          // Daylight materials: concrete, blue-green glass, sandstone, white/mauve panels; dark glass code towers.
          vec3 dayBase = style == 0 ? vec3(0.6, 0.6, 0.58) : style == 1 ? vec3(0.2, 0.27, 0.31) : style == 2 ? vec3(0.72, 0.6, 0.47) : style == 3 ? vec3(0.8, 0.79, 0.77) : vec3(0.07, 0.1, 0.1);
          if (style == 2 && bh > 0.55) dayBase = vec3(0.56, 0.32, 0.25);   // red brick
          if (style == 3 && bh > 0.6) dayBase = vec3(0.58, 0.55, 0.6);     // mauve panels
          if (style == 0 && bh > 0.7) dayBase = vec3(0.7, 0.66, 0.58);     // warm stone
          dayBase *= 0.9 + 0.2 * bh;
          if (n.y > 0.5) {
            // Roof: gravel with a darker parapet edge.
            float g = gpVN(vGpWorld.xz * 2.0) * 0.5 + gpVN(vGpWorld.xz * 9.0) * 0.5;
            gpDayCol = vec3(0.4, 0.4, 0.39) * (0.8 + 0.3 * g);
            gpRoughF = 0.95;
            vec2 gg = abs(fract(vGpWorld.xz / 3.0) - 0.5);
            return col * step(0.47, max(gg.x, gg.y)) * 0.12;
          }
          float u = n.x > 0.5 ? vGpWorld.z : vGpWorld.x;
          float v = vGpWorld.y;
          vec3 e = col * smoothstep(0.45, 0.0, abs(v - (vGpTop - 0.35))) * 1.8;
          e += col * smoothstep(0.3, 0.0, abs(v - 7.0)) * 0.8;
          // Corruption: some buildings glitch red for a moment.
          float glitch = step(1.0 - uCorrupt * 0.07, gpH21(vec2(bseed, floor(uTime * 1.3)))) * (1.0 - healed);
          float band = step(0.5, gpH21(vec2(floor(v * 0.4), floor(uTime * 12.0))));
          // View ray in facade space (x along the wall, y up, z into the building).
          vec3 outN = vec3(sign(vGpN.x) * step(0.5, n.x), 0.0, sign(vGpN.z) * step(0.5, n.z));
          vec3 rdW = normalize(vGpWorld - cameraPosition);
          vec3 tAx = n.x > 0.5 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
          vec3 rdF = vec3(dot(rdW, tAx), rdW.y, dot(rdW, -outN));
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
            // By day: a black glass tower with thin mullions, faint green code behind the glass.
            vec2 mf = fract(vec2(u / 1.5, v / 3.5));
            float mull = 1.0 - step(0.04, mf.x) * step(0.04, mf.y);
            gpDayCol = mix(vec3(0.03, 0.045, 0.045), vec3(0.2, 0.22, 0.22), mull);
            gpRoughF = mix(0.06, 0.5, mull);
            gpMetalF = mix(0.75, 0.6, mull);
            gpGlassE = vec3(0.05, 0.3, 0.12) * glyph * pow(trail, 3.0) * (1.0 - mull);
          } else {
            // Window grid: 3 m bays, 3.5 m floors (ribbon windows on style 3, full glass on style 1).
            vec2 cell = vec2(u / 3.0, v / 3.5);
            vec2 id = floor(cell);
            vec2 f = fract(cell);
            vec2 w0 = style == 1 ? vec2(0.03, 0.3) : style == 2 ? vec2(0.24, 0.26) : style == 3 ? vec2(0.0, 0.32) : vec2(0.14, 0.24);
            vec2 w1 = style == 1 ? vec2(0.97, 0.97) : style == 2 ? vec2(0.76, 0.8) : style == 3 ? vec2(1.0, 0.76) : vec2(0.86, 0.8);
            float win = step(w0.x, f.x) * step(f.x, w1.x) * step(w0.y, f.y) * step(f.y, w1.y);
            float r = gpH21(id + bseed * 17.0);
            float lit = step(0.5 - healed * 0.35, r);
            lit *= 1.0 - step(0.992, gpH21(id + floor(uTime * 0.6)));
            float tone = 0.45 + 0.55 * gpH21(id.yx + 3.1);
            vec3 wc = mix(col, vec3(1.0, 0.95, 0.85), 0.25 * step(0.8, gpH21(id + 5.0)));
            // Far away, windows are smaller than a pixel: blend to their average (no moire).
            vec2 gpFw = vec2((n.x > 0.5 ? gpFwW.z : gpFwW.x) / 3.0, gpFwW.y / 3.5);
            float gpFar = smoothstep(0.12, 0.45, max(gpFw.x, gpFw.y));
            float upper = v > 7.0 ? 1.0 : 0.0;
            // Inside the window: frame, glass, and the room behind it.
            vec2 wf = (f - w0) / (w1 - w0);
            float frameW = style == 1 ? 0.0 : 0.035;
            float frame = win * (1.0 - step(frameW, wf.x) * step(wf.x, 1.0 - frameW) * step(frameW * 1.3, wf.y) * step(wf.y, 1.0 - frameW * 1.3));
            // Ribbon windows get a mullion every 1.5 m; curtain walls every 1.5 m with a spandrel band at each floor.
            float mull = style == 1 || style == 3 ? step(fract(u / 1.5), 0.025) : 0.0;
            float blinds;
            vec3 room = gpRoom(f, id + bseed, rdF, vec2(3.0, 3.5), bseed, blinds);
            vec3 blindsC = vec3(0.82, 0.8, 0.74) * (0.85 + 0.15 * step(0.5, fract(f.y * 30.0)));
            vec3 inside = mix(room, blindsC, blinds);
            float glass = win * (1.0 - frame) * (1.0 - mull) * upper;
            float gpWin = mix(win * lit * tone, 0.37 * (0.5 + healed * 0.35) * 0.72, gpFar);
            // Night: lit rooms glow warm with the building's neon tint; blinds glow softer.
            e += mix(wc * gpWin * 0.8, (inside * 1.15 + wc * 0.2) * gpWin, (1.0 - gpFar) * 0.75) * upper;
            // Day colour of the wall itself: panel joints, weathering, grime.
            float joint = style == 0 ? step(0.985, fract(u / 1.5)) + step(0.97, fract(v / 3.5)) : style == 3 ? step(0.98, fract(v / 3.5)) * 1.0 : 0.0;
            float streak = gpVN(vec2(u * 1.7, v * 0.06)) * 0.6 + gpVN(vec2(u * 6.0, v * 0.2)) * 0.4;
            float underWin = step(w0.x, f.x) * step(f.x, w1.x) * smoothstep(w0.y, w0.y - 0.25, f.y) * step(0.02, f.y);
            vec3 wall = dayBase * (1.0 - 0.18 * clamp(joint, 0.0, 1.0)) * (0.92 + 0.12 * streak) * (1.0 - 0.12 * underWin * (style == 1 ? 0.0 : 1.0));
            // Sills under punched windows.
            float sill = (style == 0 || style == 2) ? step(w0.x - 0.03, f.x) * step(f.x, w1.x + 0.03) * step(w0.y - 0.04, f.y) * step(f.y, w0.y) : 0.0;
            wall = mix(wall, dayBase * 1.18 + 0.05, sill);
            if (style == 1) wall = mix(vec3(0.12, 0.16, 0.18), vec3(0.24, 0.27, 0.28), step(0.9, f.y)); // spandrel + slab edge
            // Street grime near the ground, roof cap at the top.
            wall *= mix(0.78, 1.0, smoothstep(0.5, 5.0, v));
            wall = mix(wall, vec3(0.75, 0.74, 0.72), step(vGpTop - 0.5, v) * (style == 1 ? 0.6 : 1.0));
            vec3 frameC = style == 2 ? vec3(0.86, 0.85, 0.82) : vec3(0.17, 0.18, 0.2);
            vec3 glassTint = style == 1 ? vec3(0.06, 0.11, 0.12) : vec3(0.05, 0.07, 0.08);
            gpDayCol = mix(wall, frameC, (frame + mull) * win * upper);
            gpDayCol = mix(gpDayCol, glassTint, glass);
            gpRoughF = mix(mix(0.88, 0.5, (frame + mull) * win), 0.05, glass);
            gpMetalF = mix(0.0, style == 1 ? 0.55 : 0.25, glass) + (frame + mull) * win * 0.5 * upper;
            // The room is seen through the glass (lit by daylight from the window).
            gpGlassE = inside * 0.32 * glass;
            // Distance: settle to the average facade colour.
            vec3 avg = mix(wall, glassTint + room * 0.15, (w1.x - w0.x) * (w1.y - w0.y) * upper);
            gpDayCol = mix(gpDayCol, avg, gpFar);
            gpRoughF = mix(gpRoughF, 0.45, gpFar);
            gpMetalF = mix(gpMetalF, style == 1 ? 0.35 : 0.1, gpFar);
            gpGlassE *= 1.0 - gpFar * 0.7;
            // Street level: shopfront glass with bright shops behind it, and an awning band.
            if (v < 6.0) {
              vec2 sc = vec2(u / 6.0, v / 5.0);
              vec2 sid = floor(sc);
              vec2 sf = fract(sc);
              float shop = step(0.06, sf.x) * step(sf.x, 0.94) * step(0.06, v) * step(v, 4.6);
              float sb;
              vec3 shopIn = gpRoom(vec2(sf.x, v / 4.6), sid + 31.0, rdF, vec2(6.0, 4.6), bseed + 3.0, sb);
              shopIn = mix(shopIn, uPalette[int(mod(sid.x + bseed * 100.0, 4.0))] * 0.6 + 0.3, 0.25);
              float awning = step(4.9, v) * step(v, 5.5) * step(0.04, sf.x) * step(sf.x, 0.96);
              vec3 awnC = mix(vec3(0.5, 0.12, 0.1), vec3(0.1, 0.25, 0.35), step(0.5, gpH21(sid + bseed)));
              gpDayCol = mix(vec3(0.16, 0.17, 0.18), vec3(0.04, 0.05, 0.06), shop);
              gpDayCol = mix(gpDayCol, awnC, awning);
              gpRoughF = mix(mix(0.7, 0.04, shop), 0.8, awning);
              gpMetalF = shop * 0.2;
              gpGlassE = shopIn * 0.55 * shop;
            }
            // Street-level storefront glow (night).
            e += col * step(v, 6.0) * step(0.8, v) * 0.22 * step(0.15, fract(u / 6.0));
            panel = 0.85 + 0.3 * step(0.5, fract(u / 3.0));
          }
          if (glitch > 0.5) e = mix(e, vec3(1.0, 0.08, 0.2) * band * 1.6, 0.85);
          return e;
        }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        float gpPanel; vec3 gpE = gpFacade(gpPanel);
        diffuseColor.rgb = mix(diffuseColor.rgb * gpPanel, gpDayCol, uDay);`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.45, gpRoughF, max(uDay, 0.35));`)
      .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>
        metalnessFactor = mix(0.45, gpMetalF, max(uDay, 0.35));`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        totalEmissiveRadiance += gpE * mix(1.0, 0.12, uDay) + gpGlassE * uDay;`);
  };
  m.customProgramCacheKey = () => "gp-building-2";
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
        float gpRoughDay = 0.9;
        float gpVN(vec2 q){ vec2 i = floor(q), f = fract(q); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(gpH21(i), gpH21(i + vec2(1.0, 0.0)), f.x), mix(gpH21(i + vec2(0.0, 1.0)), gpH21(i + vec2(1.0, 1.0)), f.x), f.y); }
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
            // Day: real asphalt. Grainy, darker tyre tracks along each lane, repair patches,
            // worn paint, manhole covers and a few rain puddles that mirror the sky.
            float n1 = gpVN(p * 0.3), n2 = gpVN(p * 2.1), n3 = gpVN(p * 13.0), n4 = gpVN(p * 47.0);
            vec3 asphalt = vec3(0.1, 0.103, 0.11) * (0.82 + 0.22 * n1 + 0.12 * n2 + 0.08 * n3 + 0.06 * n4);
            float tracks = 0.0;
            if (!inter) {
              for (int k = 0; k < 4; k++) {
                float lc = k == 0 ? 2.2 : k == 1 ? 3.8 : k == 2 ? 6.2 : 7.8;
                tracks += 1.0 - smoothstep(0.2, 0.55, abs(across - lc));
              }
            }
            asphalt *= 1.0 - 0.13 * clamp(tracks, 0.0, 1.0);
            vec2 pc = floor(p / 7.0);
            float patchA = step(0.86, gpH21(pc + 4.0)) * step(0.15, fract(p.x / 7.0)) * step(fract(p.x / 7.0), 0.75) * step(0.2, fract(p.y / 7.0)) * step(fract(p.y / 7.0), 0.7);
            // Patches: softer edges and only slightly darker, like resurfaced asphalt.
            asphalt = mix(asphalt, asphalt * 0.82, patchA * smoothstep(0.35, 0.65, gpVN(p * 0.9 + 3.0)));
            float paint = clamp(length(gpEmit) * 3.0, 0.0, 1.0) * step(0.22, n3 * 0.7 + n2 * 0.3);
            vec3 paintC = gpEmit.b < gpEmit.r * 0.5 ? vec3(0.78, 0.62, 0.2) : vec3(0.82, 0.82, 0.8);
            asphalt = mix(asphalt, paintC, paint);
            float mh = 1.0 - smoothstep(0.38, 0.42, length(vec2(across - 5.0, fract(along / 33.0 + 0.3) * 33.0 - 16.5)));
            asphalt = mix(asphalt, vec3(0.13, 0.12, 0.11) * (0.8 + 0.4 * step(0.5, fract((along + across) * 4.0))), mh * (inter ? 0.0 : 1.0));
            float wet = smoothstep(0.76, 0.82, gpVN(p * 0.07 + 17.0)) * smoothstep(0.3, 0.7, n2);
            gpDayG = mix(asphalt, asphalt * 0.55, wet);
            gpRoughDay = mix(mix(0.88 - 0.12 * tracks, 0.65, paint), 0.06, wet);
            return c;
          }
          if (dr.x < WALK || dr.y < WALK) {
            vec2 g = abs(fract(p / 2.0) - 0.5);
            float tile = step(0.47, max(g.x, g.y));
            gpRough = 0.7;
            float curb = (dr.x < HALFW + 0.25 || dr.y < HALFW + 0.25) ? 1.0 : 0.0;
            gpEmit += vec3(0.2, 0.9, 1.0) * curb * 0.35;
            // Day: concrete slabs with seams and stains; a lighter kerb and a dark gutter line.
            vec2 sl = p / 1.6;
            vec2 sg = abs(fract(sl) - 0.5);
            float seam = smoothstep(0.47, 0.49, max(sg.x, sg.y));
            float slab = gpH21(floor(sl));
            float st = gpVN(p * 0.6) * 0.6 + gpVN(p * 5.0) * 0.4;
            vec3 conc = vec3(0.56, 0.55, 0.52) * (0.86 + 0.1 * slab + 0.1 * st) * (1.0 - 0.35 * seam);
            float edge = min(dr.x < WALK ? dr.x : 99.0, dr.y < WALK ? dr.y : 99.0);
            float kerb = 1.0 - step(HALFW + 0.35, edge);
            float gutter = 1.0 - smoothstep(0.0, 0.12, abs(edge - (HALFW + 0.36)));
            conc = mix(conc, vec3(0.66, 0.65, 0.62) * (0.9 + 0.1 * st), kerb);
            conc *= 1.0 - 0.45 * gutter;
            // Grime near the building line.
            conc *= mix(0.86, 1.0, smoothstep(WALK, WALK - 1.2, edge));
            gpDayG = conc;
            gpRoughDay = 0.9;
            return vec3(0.07, 0.075, 0.085) * (0.85 + 0.15 * tile);
          }
          float bj = floor((p.x - R0) / PITCH);
          float bl = floor((p.y - R0) / PITCH);
          int idx = int(clamp(bj, 0.0, 6.0) + clamp(bl, 0.0, 6.0) * 7.0);
          float kind = uKinds[idx];
          if (kind > 3.5) {
            gpRough = 0.95;
            float n = gpH21(floor(p * 1.5));
            float gn = gpVN(p * 0.25) * 0.5 + gpVN(p * 1.7) * 0.3 + gpVN(p * 9.0) * 0.2;
            vec3 grass = mix(vec3(0.13, 0.26, 0.07), vec3(0.28, 0.38, 0.12), gn);
            grass = mix(grass, vec3(0.32, 0.27, 0.18), smoothstep(0.72, 0.8, gpVN(p * 0.12 + 5.0)) * 0.8);
            gpDayG = grass;
            gpRoughDay = 1.0;
            return vec3(0.01, 0.05, 0.03) * (0.7 + 0.6 * n);
          }
          if (kind > 2.5) {
            vec2 g = abs(fract(p / 4.0) - 0.5);
            float line = step(0.48, max(g.x, g.y));
            gpEmit += vec3(0.2, 1.0, 0.7) * line * 0.25;
            gpRough = 0.3;
            vec2 tq = p / 1.0;
            vec2 tg = abs(fract(tq) - 0.5);
            float tseam = smoothstep(0.46, 0.49, max(tg.x, tg.y));
            float chk = mod(floor(tq.x) + floor(tq.y), 2.0);
            gpDayG = mix(vec3(0.62, 0.6, 0.56), vec3(0.5, 0.48, 0.46), chk * 0.6) * (0.9 + 0.1 * gpVN(p * 3.0)) * (1.0 - 0.3 * tseam) * (1.0 - 0.15 * line);
            gpRoughDay = mix(0.55, 0.85, tseam);
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
          gpDayG = vec3(0.36, 0.36, 0.35) * (0.85 + 0.12 * gpVN(p * 0.8) + 0.08 * gpVN(p * 6.0)) * (1.0 - 0.2 * step(0.48, max(g.x, g.y)));
          gpRoughDay = 0.9;
          return vec3(0.045, 0.05, 0.055) * (0.85 + 0.15 * step(0.48, max(g.x, g.y)));
        }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        vec3 gpNight = gpGround();
        // By day, lane lines and curbs are paint rather than glow.
        diffuseColor.rgb = mix(gpNight, gpDayG, uDay);`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = mix(gpRough, gpRoughDay, uDay);`)
      .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>
        metalnessFactor = mix(0.06, 0.0, uDay);`)
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

    // ---- trees: parks plus a row of street trees along every sidewalk (not in front of doors)
    const doors = blds.filter((b) => b.door).map((b) => doorInfo(b).door);
    const allTrees: { x: number; z: number; h: number; street: boolean }[] = city.trees.map((t) => ({ x: t.x, z: t.z, h: t.h, street: false }));
    for (const e of city.edges) {
      for (const t of [0.2, 0.5, 0.8]) {
        for (const side of [-1, 1]) {
          const x = e.x0 + (e.x1 - e.x0) * t, z = e.z0 + (e.z1 - e.z0) * t;
          const off = ROAD / 2 + SIDEWALK * 0.62;
          const px = e.horizontal ? x : x + side * off;
          const pz = e.horizontal ? z + side * off : z;
          if (Math.abs(px) > HALF - 4 || Math.abs(pz) > HALF - 4) continue;
          if (doors.some((d) => Math.hypot(d.x - px, d.z - pz) < 9)) continue;
          allTrees.push({ x: px, z: pz, h: 6.5 + ((px * 13.1 + pz * 7.7) % 1 + 1) % 1 * 3, street: true });
        }
      }
    }
    this.addTrees(allTrees, colliders);

    // ---- traffic lights at every junction (they cycle; lamps glow)
    this.addTrafficLights(colliders);

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

  /** Leafy trees: a trunk and a clumpy canopy (green by day, a soft neon glow at night). */
  private addTrees(trees: { x: number; z: number; h: number; street: boolean }[], colliders: Colliders): void {
    const m4 = new THREE.Matrix4();
    const trunkGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.14, 0.24, 1, 7).translate(0, 0.5, 0),
      new THREE.CylinderGeometry(0.05, 0.09, 0.45, 5).rotateZ(0.7).translate(0.16, 0.82, 0),
      new THREE.CylinderGeometry(0.05, 0.09, 0.4, 5).rotateZ(-0.6).translate(-0.14, 0.88, 0.04),
    ])!;
    // Canopy: several overlapping, slightly lumpy blobs.
    const blob = (r: number, x: number, y: number, z: number, seed: number) => {
      const g = new THREE.IcosahedronGeometry(r, 1);
      const p = g.getAttribute("position");
      for (let i = 0; i < p.count; i++) {
        const k = 1 + 0.16 * Math.sin(p.getX(i) * 7.1 + seed) * Math.cos(p.getY(i) * 5.3 + seed * 2) + 0.08 * Math.sin(p.getZ(i) * 11.0 + seed);
        p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
      }
      g.computeVertexNormals();
      return g.translate(x, y, z);
    };
    const canopyGeo = mergeGeometries([blob(0.62, 0, 0.1, 0, 1), blob(0.48, 0.42, -0.08, 0.15, 2), blob(0.46, -0.38, -0.05, -0.2, 3), blob(0.44, 0.05, 0.38, -0.12, 4), blob(0.4, -0.1, -0.2, 0.42, 5)])!;
    const trunkMesh = new THREE.InstancedMesh(trunkGeo, this.shade(new THREE.MeshStandardMaterial({ color: 0x2a1f1a, roughness: 0.95 }), 0x4a3a2e), trees.length);
    const canopyMat = this.shade(new THREE.MeshStandardMaterial({ color: 0x0a2a1a, emissive: 0x1aff7a, emissiveIntensity: 0.12, roughness: 0.85 }), 0xffffff, 0.12, 0.0);
    const canopyMesh = new THREE.InstancedMesh(canopyGeo, canopyMat, trees.length);
    const greens = [0x3d6e2a, 0x4c7a2c, 0x35632f, 0x587f30, 0x2f5a2a].map((h) => new THREE.Color(h));
    const q = new THREE.Quaternion();
    trees.forEach((t, i) => {
      const s = t.street ? 1 : 1.25;
      m4.compose(new THREE.Vector3(t.x, 0, t.z), q.setFromEuler(new THREE.Euler(0, i * 1.7, 0)), new THREE.Vector3(s, t.h * 0.5, s));
      trunkMesh.setMatrixAt(i, m4);
      const cw = (t.street ? 2.3 : 3.0) * (0.85 + ((i * 0.618) % 1) * 0.3);
      m4.compose(new THREE.Vector3(t.x, t.h * 0.62 + cw * 0.2, t.z), q.setFromEuler(new THREE.Euler(0, i * 2.3, 0)), new THREE.Vector3(cw, cw * 0.9, cw));
      canopyMesh.setMatrixAt(i, m4);
      canopyMesh.setColorAt(i, greens[i % greens.length]);
      colliders.addRect(t.x, t.z, t.street ? 0.5 : 0.8, t.street ? 0.5 : 0.8, t.h, "prop");
    });
    trunkMesh.castShadow = canopyMesh.castShadow = true;
    trunkMesh.receiveShadow = canopyMesh.receiveShadow = true;
    this.group.add(trunkMesh, canopyMesh);
  }

  /** Traffic signals on the corners of every junction, cycling north-south / east-west. */
  private addTrafficLights(colliders: Colliders): void {
    const city = getCity();
    const m4 = new THREE.Matrix4();
    const spots: { x: number; z: number; rot: number; axis: number }[] = [];
    for (const n of city.nodes) {
      if ((city.adjacency[n.id]?.length ?? 0) < 3) continue;
      const o = ROAD / 2 + 0.9;
      // Each corner signal faces the traffic coming toward the junction on one road.
      spots.push({ x: n.x + o, z: n.z + o, rot: 0, axis: 0 });
      spots.push({ x: n.x - o, z: n.z - o, rot: Math.PI, axis: 0 });
      spots.push({ x: n.x - o, z: n.z + o, rot: -Math.PI / 2, axis: 1 });
      spots.push({ x: n.x + o, z: n.z - o, rot: Math.PI / 2, axis: 1 });
    }
    const poleGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.09, 0.12, 4.6, 8).translate(0, 2.3, 0),
      new THREE.BoxGeometry(0.34, 0.95, 0.26).translate(0, 3.9, 0.0),
      new THREE.BoxGeometry(0.42, 0.06, 0.3).translate(0, 4.4, 0.04),
    ])!;
    const poles = new THREE.InstancedMesh(poleGeo, this.shade(new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.55, metalness: 0.6 }), 0x2a2e33), spots.length);
    const lampGeo = new THREE.SphereGeometry(0.085, 10, 8);
    const aAxis = new Float32Array(spots.length * 3);
    const aSlot = new Float32Array(spots.length * 3);
    const lamps = new THREE.InstancedMesh(lampGeo, new THREE.ShaderMaterial({
      uniforms: { uTime: this.uniforms.uTime, uDay: this.uniforms.uDay },
      vertexShader: /* glsl */ `
        attribute float aAxis; attribute float aSlot; varying float vOn; varying float vSlot; uniform float uTime;
        void main(){
          // 24 s cycle: axis 0 green 0-10, amber 10-12, red 12-24; axis 1 the other way round.
          float t = mod(uTime + aAxis * 12.0, 24.0);
          float state = t < 10.0 ? 2.0 : t < 12.0 ? 1.0 : 0.0;
          vOn = abs(state - aSlot) < 0.5 ? 1.0 : 0.0;
          vSlot = aSlot;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying float vOn; varying float vSlot; uniform float uDay;
        void main(){
          vec3 c = vSlot < 0.5 ? vec3(1.0, 0.08, 0.05) : vSlot < 1.5 ? vec3(1.0, 0.55, 0.05) : vec3(0.1, 1.0, 0.45);
          gl_FragColor = vec4(c * mix(0.06, 3.2, vOn), 1.0);
        }`,
      toneMapped: false,
    }), spots.length * 3);
    const q = new THREE.Quaternion();
    spots.forEach((s, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.rot);
      m4.compose(new THREE.Vector3(s.x, 0, s.z), q, new THREE.Vector3(1, 1, 1));
      poles.setMatrixAt(i, m4);
      const fwd = new THREE.Vector3(0, 0, 0.14).applyQuaternion(q);
      for (let k = 0; k < 3; k++) {
        m4.compose(new THREE.Vector3(s.x + fwd.x, 4.2 - k * 0.28, s.z + fwd.z), q, new THREE.Vector3(1, 1, 1));
        lamps.setMatrixAt(i * 3 + k, m4);
        aAxis[i * 3 + k] = s.axis;
        aSlot[i * 3 + k] = k;
      }
      colliders.addRect(s.x, s.z, 0.3, 0.3, 4.6, "prop");
    });
    lampGeo.setAttribute("aAxis", new THREE.InstancedBufferAttribute(aAxis, 1));
    lampGeo.setAttribute("aSlot", new THREE.InstancedBufferAttribute(aSlot, 1));
    poles.castShadow = true;
    this.group.add(poles, lamps);
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
