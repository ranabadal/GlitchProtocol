import * as THREE from "three";

/*
 * Sky dome and a box of digital-rain streaks that follows the camera, both on the GPU.
 * uDay blends between night (stars, green aurora of falling code, the NULL moon),
 * sunset and a bright blue day sky with a sun and soft clouds.
 */

export class Sky {
  dome: THREE.Mesh;
  rain: THREE.Points;
  private rainMat: THREE.ShaderMaterial;
  private domeMat: THREE.ShaderMaterial;
  uDay = { value: 0 };
  uSunDir = { value: new THREE.Vector3(0.4, 0.7, -0.5).normalize() };

  constructor(glyphs: THREE.Texture, rainCount: number, uTime: { value: number }, uCorrupt: { value: number }) {
    this.domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { uTime, uCorrupt, uDay: this.uDay, uSunDir: this.uSunDir },
      vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uCorrupt; uniform float uDay; uniform vec3 uSunDir; varying vec3 vDir;
        float h(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1.0, 0.0)), f.x), mix(h(i + vec2(0.0, 1.0)), h(i + vec2(1.0, 1.0)), f.x), f.y); }
        void main(){
          float y = clamp(vDir.y, -0.2, 1.0);
          float night = 1.0 - smoothstep(0.0, 0.5, uDay);
          vec3 top = vec3(0.004, 0.012, 0.012);
          vec3 hor = mix(vec3(0.02, 0.09, 0.07), vec3(0.09, 0.02, 0.04), uCorrupt * 0.6);
          vec3 nightC = mix(hor, top, smoothstep(0.0, 0.55, y));
          vec3 duskC = mix(vec3(1.0, 0.52, 0.28), vec3(0.16, 0.12, 0.34), smoothstep(-0.02, 0.5, y));
          vec3 dayC = mix(vec3(0.78, 0.88, 0.97), vec3(0.24, 0.5, 0.9), smoothstep(-0.02, 0.6, y));
          vec3 c = uDay < 0.5 ? mix(nightC, duskC, uDay * 2.0) : mix(duskC, dayC, uDay * 2.0 - 1.0);
          // Sun and soft clouds (day / sunset).
          float sd = max(dot(vDir, uSunDir), 0.0);
          vec3 sunCol = mix(vec3(1.0, 0.55, 0.25), vec3(1.0, 0.95, 0.85), smoothstep(0.5, 1.0, uDay));
          c += sunCol * (smoothstep(0.9995, 0.9998, sd) * 3.0 + pow(sd, 60.0) * 0.6 + pow(sd, 6.0) * 0.12) * (1.0 - night);
          vec2 cp = vDir.xz / (vDir.y + 0.25) * 2.2 + vec2(uTime * 0.01, 0.0);
          float cl = smoothstep(0.55, 0.85, vn(cp) * 0.65 + vn(cp * 2.3) * 0.35) * smoothstep(0.02, 0.25, y);
          c = mix(c, mix(vec3(1.0, 0.75, 0.6), vec3(1.0), smoothstep(0.5, 1.0, uDay)), cl * 0.55 * (1.0 - night));
          // stars
          vec2 sp = vDir.xz / (vDir.y + 1.2) * 180.0;
          float s = step(0.997, h(floor(sp))) * smoothstep(0.1, 0.5, y);
          c += vec3(0.7, 1.0, 0.9) * s * (0.5 + 0.5 * sin(uTime * 2.0 + h(floor(sp)) * 40.0)) * night;
          // aurora of falling code
          float ang = atan(vDir.x, vDir.z);
          float col = floor(ang * 60.0);
          float fall = fract(vDir.y * 3.0 + uTime * (0.05 + 0.1 * h(vec2(col, 1.0))) + h(vec2(col, 2.0)));
          float band = smoothstep(0.05, 0.35, y) * smoothstep(0.75, 0.3, y);
          c += vec3(0.1, 0.8, 0.4) * pow(fall, 12.0) * band * 0.35 * step(0.6, h(vec2(col, 3.0))) * night;
          // the NULL moon
          vec3 moonDir = normalize(vec3(0.5, 0.42, -0.75));
          float m = dot(vDir, moonDir);
          c += vec3(1.0, 0.25, 0.35) * smoothstep(0.9993, 0.9996, m) * 1.6 * (1.0 - uDay * 0.8);
          c += vec3(0.6, 0.1, 0.2) * pow(max(m, 0.0), 300.0) * 0.8 * night;
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), this.domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;

    // Rain streaks: positions wrap inside a box around the camera in the shader.
    const pos = new Float32Array(rainCount * 3);
    const seed = new Float32Array(rainCount);
    for (let i = 0; i < rainCount; i++) {
      pos[i * 3] = Math.random() * 80 - 40;
      pos[i * 3 + 1] = Math.random() * 40;
      pos[i * 3 + 2] = Math.random() * 80 - 40;
      seed[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    this.rainMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime, uCam: { value: new THREE.Vector3() }, uGlyphs: { value: glyphs }, uScale: { value: 1 }, uDay: this.uDay },
      vertexShader: /* glsl */ `
        uniform float uTime; uniform vec3 uCam; uniform float uScale; attribute float aSeed; varying float vSeed; varying float vFade;
        void main(){
          vec3 p = position;
          p.y = mod(p.y - uTime * (8.0 + aSeed * 10.0), 40.0);
          vec3 w = vec3(uCam.x + mod(p.x - uCam.x + 40.0, 80.0) - 40.0, uCam.y - 15.0 + p.y, uCam.z + mod(p.z - uCam.z + 40.0, 80.0) - 40.0);
          vSeed = aSeed;
          vec4 mv = viewMatrix * vec4(w, 1.0);
          vFade = smoothstep(42.0, 6.0, length(w - uCam));
          gl_PointSize = uScale * (110.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uGlyphs; uniform float uTime; uniform float uDay; varying float vSeed; varying float vFade;
        void main(){
          float gi = floor(fract(vSeed * 13.7 + floor(uTime * 4.0 * (0.3 + vSeed)) * 0.137) * 64.0);
          vec2 uv = (vec2(mod(gi, 8.0), floor(gi / 8.0)) + vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y)) / 8.0;
          float g = texture2D(uGlyphs, uv).r;
          gl_FragColor = vec4(vec3(0.25, 1.0, 0.5) * g * vFade * 0.3 * (1.0 - uDay * 0.85), 1.0);
        }`,
    });
    this.rain = new THREE.Points(g, this.rainMat);
    this.rain.frustumCulled = false;
  }

  setDay(day: number, sun: THREE.Vector3): void {
    this.uDay.value = day;
    this.uSunDir.value.copy(sun).normalize();
  }

  update(camera: THREE.Camera, pixelScale: number): void {
    this.dome.position.copy(camera.position);
    (this.rainMat.uniforms.uCam.value as THREE.Vector3).copy(camera.position);
    this.rainMat.uniforms.uScale.value = pixelScale;
  }
}
