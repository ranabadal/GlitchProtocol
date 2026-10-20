import * as THREE from "three";

/*
 * Night sky dome (gradient, stars, slow green aurora of falling code) and a box of
 * digital-rain streaks that follows the camera. Both run entirely on the GPU.
 */

export class Sky {
  dome: THREE.Mesh;
  rain: THREE.Points;
  private rainMat: THREE.ShaderMaterial;
  private domeMat: THREE.ShaderMaterial;

  constructor(glyphs: THREE.Texture, rainCount: number, uTime: { value: number }, uCorrupt: { value: number }) {
    this.domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { uTime, uCorrupt },
      vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uCorrupt; varying vec3 vDir;
        float h(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        void main(){
          float y = clamp(vDir.y, -0.2, 1.0);
          vec3 top = vec3(0.004, 0.012, 0.012);
          vec3 hor = mix(vec3(0.02, 0.09, 0.07), vec3(0.09, 0.02, 0.04), uCorrupt * 0.6);
          vec3 c = mix(hor, top, smoothstep(0.0, 0.55, y));
          // stars
          vec2 sp = vDir.xz / (vDir.y + 1.2) * 180.0;
          float s = step(0.997, h(floor(sp))) * smoothstep(0.1, 0.5, y);
          c += vec3(0.7, 1.0, 0.9) * s * (0.5 + 0.5 * sin(uTime * 2.0 + h(floor(sp)) * 40.0));
          // aurora of falling code
          float ang = atan(vDir.x, vDir.z);
          float col = floor(ang * 60.0);
          float fall = fract(vDir.y * 3.0 + uTime * (0.05 + 0.1 * h(vec2(col, 1.0))) + h(vec2(col, 2.0)));
          float band = smoothstep(0.05, 0.35, y) * smoothstep(0.75, 0.3, y);
          c += vec3(0.1, 0.8, 0.4) * pow(fall, 12.0) * band * 0.35 * step(0.6, h(vec2(col, 3.0)));
          // the NULL moon
          vec3 moonDir = normalize(vec3(0.5, 0.42, -0.75));
          float m = dot(vDir, moonDir);
          c += vec3(1.0, 0.25, 0.35) * smoothstep(0.9993, 0.9996, m) * 1.6;
          c += vec3(0.6, 0.1, 0.2) * pow(max(m, 0.0), 300.0) * 0.8;
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
      uniforms: { uTime, uCam: { value: new THREE.Vector3() }, uGlyphs: { value: glyphs }, uScale: { value: 1 } },
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
        uniform sampler2D uGlyphs; uniform float uTime; varying float vSeed; varying float vFade;
        void main(){
          float gi = floor(fract(vSeed * 13.7 + floor(uTime * 4.0 * (0.3 + vSeed)) * 0.137) * 64.0);
          vec2 uv = (vec2(mod(gi, 8.0), floor(gi / 8.0)) + vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y)) / 8.0;
          float g = texture2D(uGlyphs, uv).r;
          gl_FragColor = vec4(vec3(0.25, 1.0, 0.5) * g * vFade * 0.3, 1.0);
        }`,
    });
    this.rain = new THREE.Points(g, this.rainMat);
    this.rain.frustumCulled = false;
  }

  update(camera: THREE.Camera, pixelScale: number): void {
    this.dome.position.copy(camera.position);
    (this.rainMat.uniforms.uCam.value as THREE.Vector3).copy(camera.position);
    this.rainMat.uniforms.uScale.value = pixelScale;
  }
}
