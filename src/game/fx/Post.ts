import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { FXAAPass } from "three/examples/jsm/postprocessing/FXAAPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

/*
 * Post-processing: neon bloom, then one combined "screen" pass for vignette, damage
 * flash, chromatic glitch, scanlines and a slight green grade. Disabled on the low
 * quality tier, where the renderer draws straight to the screen.
 */

const ScreenShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uDamage: { value: 0 },
    uGlitch: { value: 0 },
    uHeal: { value: 0 },
    uSpeed: { value: 0 },
    uDay: { value: 0 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uDamage; uniform float uGlitch; uniform float uHeal; uniform float uSpeed; uniform float uDay;
    varying vec2 vUv;
    float h(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    void main(){
      vec2 uv = vUv;
      // Glitch: horizontal tearing bands.
      float band = floor(uv.y * 24.0);
      float tear = step(1.0 - uGlitch * 0.35, h(vec2(band, floor(uTime * 20.0))));
      uv.x += tear * (h(vec2(band, uTime)) - 0.5) * 0.08 * uGlitch;
      vec2 c = uv - 0.5;
      float ca = 0.0015 + uDamage * 0.008 + uGlitch * 0.012 + uSpeed * 0.004;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ca).b;
      // Speed lines when driving fast.
      float r = length(c);
      float ang = atan(c.y, c.x);
      float lines = step(0.985, h(vec2(floor(ang * 80.0), floor(uTime * 30.0)))) * smoothstep(0.25, 0.6, r);
      col += vec3(0.6, 1.0, 0.9) * lines * uSpeed * 0.25;
      // Grade: lift greens a touch, crush blacks.
      col = mix(col, col * vec3(0.95, 1.03, 1.0), 0.4 * (1.0 - uDay));
      col = mix(col, col * vec3(1.05, 1.1, 1.15) + vec3(0.02, 0.03, 0.04), uHeal);
      // Scanlines (night only) and vignette.
      col *= 1.0 - (0.03 - 0.03 * sin(vUv.y * 900.0)) * (1.0 - uDay);
      float vig = smoothstep(0.95, 0.35, r);
      col *= mix(mix(0.55, 0.9, uDay), 1.0, vig);
      col = mix(col, vec3(0.9, 0.05, 0.12), uDamage * smoothstep(0.25, 0.75, r) * 0.65);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

/*
 * Final colour grade, in display space after tone mapping: a gentle filmic S-curve,
 * a touch more saturation, warm highlights and cool shadows by day (the "movie" look
 * of open-world games), plus fine film grain so flat surfaces don't band.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uDay: { value: 1 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uDay; uniform float uTime; varying vec2 vUv;
    float h(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    void main(){
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = src.rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // S-curve contrast around mid grey.
      vec3 s = c * c * (3.0 - 2.0 * c);
      c = mix(c, s, mix(0.18, 0.32, uDay));
      // Saturation.
      float l2 = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l2), c, mix(1.08, 1.14, uDay));
      // Split toning: warm highlights, teal shadows (daytime).
      vec3 warm = vec3(1.035, 1.0, 0.95), cool = vec3(0.95, 1.0, 1.04);
      c *= mix(vec3(1.0), mix(cool, warm, smoothstep(0.2, 0.75, l)), uDay * 0.9);
      // Grain.
      c += (h(vUv * 1000.0 + fract(uTime) * 37.0) - 0.5) * 0.012;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), src.a);
    }`,
};

export interface PostOptions {
  bloom: boolean;
  /** Edge smoothing (cheap): needed because the renderer runs without MSAA. */
  fxaa: boolean;
  /** Ambient occlusion in corners and under things (expensive: high quality only). */
  ao: boolean;
}

export class PostFX {
  composer: EffectComposer | null = null;
  screen: ShaderPass | null = null;
  bloom: UnrealBloomPass | null = null;
  grade: ShaderPass | null = null;
  fxaa: FXAAPass | null = null;
  gtao: GTAOPass | null = null;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, opts: PostOptions | boolean) {
    const o: PostOptions = typeof opts === "boolean" ? { bloom: opts, fxaa: opts, ao: false } : opts;
    if (!o.bloom && !o.fxaa) return;
    const size = renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    if (o.ao) {
      this.gtao = new GTAOPass(scene, camera as THREE.PerspectiveCamera, size.x, size.y);
      this.gtao.blendIntensity = 0.85;
      this.gtao.updateGtaoMaterial({ radius: 1.2, distanceExponent: 1.4, thickness: 1.5, scale: 1.0, samples: 12 });
      this.composer.addPass(this.gtao);
    }
    if (o.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.55, 0.35, 0.9);
      this.composer.addPass(this.bloom);
    }
    this.screen = new ShaderPass(ScreenShader);
    this.composer.addPass(this.screen);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    if (o.fxaa) {
      this.fxaa = new FXAAPass();
      this.composer.addPass(this.fxaa);
    }
  }

  /** Daylight needs gentler bloom (bright walls must not glow) and a lighter vignette. */
  setLight(strength: number, threshold: number, day: number): void {
    if (this.bloom) { this.bloom.strength = strength; this.bloom.threshold = threshold; }
    if (this.screen) this.screen.uniforms.uDay.value = day;
    if (this.grade) this.grade.uniforms.uDay.value = day;
  }

  setSize(w: number, h: number): void {
    this.composer?.setSize(w, h);
    this.bloom?.setSize(w / 2, h / 2);
  }

  set(values: { time: number; damage: number; glitch: number; heal: number; speed: number }): void {
    if (!this.screen) return;
    const u = this.screen.uniforms;
    u.uTime.value = values.time;
    u.uDamage.value = values.damage;
    u.uGlitch.value = values.glitch;
    u.uHeal.value = values.heal;
    u.uSpeed.value = values.speed;
    if (this.grade) this.grade.uniforms.uTime.value = values.time;
  }

  render(scene: THREE.Scene, camera: THREE.Camera, dt: number): void {
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(scene, camera);
  }

  dispose(): void {
    this.composer?.dispose();
  }
}
