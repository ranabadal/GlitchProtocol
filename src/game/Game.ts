import * as THREE from "three";
import { COUNTDOWN_MS } from "@/lib/shared/mission";
import { blockCenter, getCity, HALF, roadPos } from "@/lib/shared/city";
import { Crowd } from "./actors/Crowd";
import { Player, EMP_COOLDOWN } from "./actors/Player";
import { createRobotVisual, DroneVisual, loadRobotTemplate, TurretVisual, type RobotTemplate } from "./actors/RobotModel";
import { Robots } from "./actors/Robots";
import { Vehicles } from "./actors/Vehicles";
import { Sound } from "./audio/Sound";
import { Colliders } from "./Colliders";
import { Bubbles } from "./fx/Bubbles";
import { Effects } from "./fx/Effects";
import { PostFX } from "./fx/Post";
import { Input } from "./Input";
import { mulberry } from "./mathx";
import { Director } from "./mission/Director";
import { detectQuality, lowerQuality, QUALITY, saveQuality, type QualitySettings } from "./Quality";
import type { GameOptions, HudState, QualityLevel } from "./types";
import { CityView } from "./world/City";
import { Sky } from "./world/Sky";
import type { NoiseListener, World } from "./World";

/*
 * Owns the renderer and the frame loop, builds the city and every system, and runs
 * them in a fixed order each frame. The React page creates one Game per mission (or
 * one in attract mode for the welcome screen) and reads HUD snapshots from it.
 */

let sharedTemplate: Promise<RobotTemplate | null> | null = null;
function robotTemplate(): Promise<RobotTemplate | null> {
  sharedTemplate ??= loadRobotTemplate();
  return sharedTemplate;
}

export class Game {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  world!: World;
  input: Input;
  sound = new Sound();
  ready: Promise<void>;
  player: Player | null = null;
  director: Director | null = null;
  paused = false;
  private q: QualitySettings;
  private level: QualityLevel;
  private auto: boolean;
  private colliders = new Colliders();
  private city!: CityView;
  private sky!: Sky;
  private fx!: Effects;
  private post!: PostFX;
  private bubbles!: Bubbles;
  private vehicles!: Vehicles;
  private crowd!: Crowd;
  private robots!: Robots;
  private moon!: THREE.DirectionalLight;
  private raf = 0;
  private last = 0;
  private hudT = 0;
  private fpsFrames = 0;
  private fpsT = 0;
  private fps = 60;
  private slowFor = 0;
  private disposed = false;
  private startLocal = 0;
  private introDone = false;
  private attractPts: THREE.Vector3[] = [];
  private attractT = 0;
  private finished = false;
  private damagePulse = 0;
  private lockedOnce = false;
  /** Mission built but not begun: slow establishing shot while the briefing is read. */
  waiting = false;

  constructor(private opts: GameOptions) {
    this.renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: false, powerPreference: "high-performance", stencil: false });
    this.level = opts.quality && opts.quality !== "auto" ? opts.quality : detectQuality(this.renderer);
    this.auto = !opts.quality || opts.quality === "auto";
    this.q = QUALITY[this.level];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.q.pixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = this.q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, this.q.farClip);
    this.input = new Input(opts.canvas, (locked) => opts.callbacks?.onPointerLockChange?.(locked));
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const template = await robotTemplate();
    if (this.disposed) return;
    const opts = this.opts;
    const m = opts.mission;
    const scene = this.scene;
    scene.background = new THREE.Color(0x010405);
    scene.fog = new THREE.FogExp2(0x03090b, this.level === "low" ? 0.0062 : 0.0042);

    const listeners: NoiseListener[] = [];
    this.fx = new Effects(this.q.lights);
    const world: World = {
      scene,
      camera: this.camera,
      colliders: this.colliders,
      fx: this.fx,
      sound: this.sound,
      q: this.q,
      uTime: { value: 0 },
      time: 0,
      attract: !!opts.attract,
      player: null,
      listeners,
      noise: (x, z, r, kind) => { for (const l of listeners) l.onNoise(x, z, r, kind); },
      shake: (a) => this.player?.addShake(a),
      listenerPos: new THREE.Vector3(),
    };
    this.world = world;

    // Lights: soft sky fill, a cool moonlight, and the city's own neon does the rest.
    scene.add(new THREE.HemisphereLight(0x2a4258, 0x07090c, 0.7));
    this.moon = new THREE.DirectionalLight(0x9fb8ff, 0.7);
    this.moon.position.set(60, 120, -90);
    if (this.q.shadows) {
      this.moon.castShadow = true;
      this.moon.shadow.mapSize.set(2048, 2048);
      const c = this.moon.shadow.camera;
      c.left = c.bottom = -45;
      c.right = c.top = 45;
      c.near = 1;
      c.far = 300;
      this.moon.shadow.bias = -0.0008;
    }
    scene.add(this.moon, this.moon.target);
    scene.environment = this.neonEnvironment();
    scene.environmentIntensity = 0.45;

    // City and sky.
    const hollow = new Set((m?.vaults ?? []).map((v) => v.buildingId));
    this.city = new CityView(this.colliders, { hollow });
    world.uTime = this.city.uniforms.uTime;
    scene.add(this.city.group);
    this.sky = new Sky(this.city.uniforms.uGlyphs.value, this.q.rainParticles, world.uTime, this.city.uniforms.uCorrupt);
    scene.add(this.sky.dome, this.sky.rain);
    scene.add(this.fx.group);
    this.bubbles = new Bubbles(4);
    scene.add(this.bubbles.group);

    // People, cars, robots.
    const capacity = this.q.traffic + 12;
    this.vehicles = new Vehicles(world, this.q.traffic, capacity);
    scene.add(this.vehicles.group);
    this.crowd = new Crowd(world, this.q.crowd, this.vehicles, this.bubbles);
    scene.add(this.crowd.group);
    this.vehicles.onDriverEjected = (x, z, ax, az) => this.crowd.ejectDriver(x, z, ax, az);
    this.robots = new Robots(world, template);
    scene.add(this.robots.group);

    if (m && opts.bridge && !opts.attract) {
      this.player = new Player(world, this.vehicles, this.robots, opts.hue ?? 150);
      world.player = this.player;
      this.director = new Director({
        world, mission: m, progress: opts.progress ?? null, bridge: opts.bridge, player: this.player, robots: this.robots,
        vehicles: this.vehicles, crowd: this.crowd, city: this.city, colliders: this.colliders, voice: opts.voice,
        deadline: opts.deadline ?? null, firstTime: !!opts.firstTime,
        onFinished: (o) => { if (!this.finished) { this.finished = true; opts.callbacks?.onFinished?.(o); } },
        onError: (msg) => opts.callbacks?.onError?.(msg),
      });
      // The player's blaster can hit fence pylons.
      this.player.fences = this.director.fences;
      this.vehicles.onBoxHit = (car, kind) => {
        if (kind === "fence" && car.driver === "player") {
          car.takeDamage(14, car.pos);
          this.fx.sparks(car.pos.clone().setY(1), null, new THREE.Color(1, 0.2, 0.3), 20, 10);
          this.sound.overheat();
        }
      };
      const sp = this.director.spawnPoint;
      this.player.spawn(sp.x, sp.z, sp.heading);
      this.player.shieldUntil = 0;
      // Your car waits outside the safehouse (or near the checkpoint after a refresh).
      const resumed = sp.x !== m.start.x || sp.z !== m.start.z;
      if (!resumed) this.vehicles.addParked(m.startCar.x, m.startCar.z, m.startCar.heading, m.startCar.variant, new THREE.Color(0.07, 0.11, 0.13), new THREE.Color().setHSL((opts.hue ?? 150) / 360, 1, 0.5));
      this.vehicles.populate(sp.x, sp.z, 6);
      if (resumed) this.vehicles.addParked(sp.x + 4, sp.z + 4, sp.heading, m.startCar.variant);
      world.listenerPos.set(sp.x, 0, sp.z);
      if (opts.startAt) this.setTiming(opts.startAt, opts.deadline ?? null);
      else this.waiting = true;
    } else {
      this.setupAttract();
    }

    this.resize();
    window.addEventListener("resize", this.resize);
    this.post = new PostFX(this.renderer, scene, this.camera, this.q.bloom);
    this.resize();
    await this.prewarm(template);
    if (this.disposed) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  /** A tiny dark scene with neon strips, baked into reflections for cars and robots. */
  private neonEnvironment(): THREE.Texture {
    const env = new THREE.Scene();
    env.add(new THREE.Mesh(new THREE.SphereGeometry(50, 16, 8), new THREE.MeshBasicMaterial({ color: 0x050a0d, side: THREE.BackSide })));
    const strip = (color: number, x: number, y: number, z: number, w: number, h: number, d: number, k = 1) => {
      const mm = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k) }));
      mm.position.set(x, y, z);
      env.add(mm);
    };
    strip(0x2bff9a, 0, 18, -30, 60, 1.5, 1, 3);
    strip(0x29d9ff, -30, 10, 0, 1, 1.2, 60, 3);
    strip(0xff3aa8, 30, 14, 0, 1, 1, 50, 2.5);
    strip(0xffb229, 0, 6, 30, 40, 1, 1, 2);
    strip(0x9fb8ff, 0, 40, 0, 30, 1, 30, 1.2);
    strip(0x113322, 0, -20, 0, 80, 1, 80, 1);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const rt = pmrem.fromScene(env, 0.03);
    pmrem.dispose();
    return rt.texture;
  }

  /** Compile every shader before the first frame so nothing stutters when robots appear. */
  private async prewarm(template: RobotTemplate | null): Promise<void> {
    const temp: THREE.Object3D[] = [];
    const uTime = this.world.uTime;
    const visuals = [createRobotVisual(template, "walker", uTime), createRobotVisual(template, "brute", uTime), new DroneVisual(uTime), new TurretVisual(uTime)];
    for (const v of visuals) {
      v.object.position.set(this.camera.position.x, -50, this.camera.position.z);
      this.scene.add(v.object);
      temp.push(v.object);
    }
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch {
      this.renderer.compile(this.scene, this.camera);
    }
    this.post.render(this.scene, this.camera, 0.016);
    for (const o of temp) this.scene.remove(o);
    for (const v of visuals) v.dispose();
  }

  // ------------------------------------------------------------ attract mode

  private setupAttract(): void {
    const city = getCity();
    const rand = mulberry(9);
    // Camera path that only ever flies above street centre lines, so it never clips a tower.
    const loop: [number, number][] = [[1, 1], [1, 4], [2, 4], [2, 6], [5, 6], [5, 4], [6, 4], [6, 2], [4, 2], [4, 1]];
    const pts: THREE.Vector3[] = [];
    loop.forEach(([i, k], n) => {
      const [i2, k2] = loop[(n + 1) % loop.length];
      const h = 17 + 13 * Math.sin(n * 1.9) ** 2;
      const h2 = 17 + 13 * Math.sin((n + 1) * 1.9) ** 2;
      const x0 = roadPos(i), z0 = roadPos(k), x1 = roadPos(i2), z1 = roadPos(k2);
      // Corner point, then evenly spaced points along the straight so the spline hugs the road.
      const len = Math.hypot(x1 - x0, z1 - z0);
      const steps = Math.max(2, Math.round(len / 40));
      for (let s2 = 0; s2 < steps; s2++) {
        const t = s2 / steps;
        pts.push(new THREE.Vector3(x0 + (x1 - x0) * t, h + (h2 - h) * t, z0 + (z1 - z0) * t));
      }
    });
    this.attractPts = pts;
    this.vehicles.populate(0, 0, 4);
    // Robots marching down the streets, drones overhead.
    for (let i = 0; i < 12; i++) {
      const e = city.edges[Math.floor(rand() * city.edges.length)];
      const a = city.nodes[e.a], b = city.nodes[e.b];
      const side = (rand() < 0.5 ? -1 : 1) * 10.5;
      const ox = e.horizontal ? 0 : side, oz = e.horizontal ? side : 0;
      this.robots.spawn({ id: `a${i}`, kind: rand() < 0.15 ? "brute" : "walker", x: a.x + (b.x - a.x) * 0.5 + ox, z: a.z + (b.z - a.z) * 0.5 + oz, patrol: [{ x: a.x + ox, z: a.z + oz }, { x: b.x + ox, z: b.z + oz }] });
    }
    for (let i = 0; i < 6; i++) {
      const n = city.nodes[Math.floor(rand() * city.nodes.length)];
      const n2 = city.nodes[Math.floor(rand() * city.nodes.length)];
      this.robots.spawn({ id: `d${i}`, kind: "drone", x: n.x, z: n.z, y: 12 + rand() * 8, patrol: [{ x: n.x, z: n.z }, { x: n2.x, z: n2.z }] });
    }
    this.robots.passive = true;
  }

  /** Closed uniform Catmull-Rom path through the attract points. */
  private pathPoint(u: number, out: THREE.Vector3): THREE.Vector3 {
    const P = this.attractPts;
    const n = P.length;
    const f = (((u % 1) + 1) % 1) * n;
    const i = Math.floor(f), t = f - i;
    const p0 = P[(i - 1 + n) % n], p1 = P[i % n], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
    const t2 = t * t, t3 = t2 * t;
    const k = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
    return out.set(k(p0.x, p1.x, p2.x, p3.x), k(p0.y, p1.y, p2.y, p3.y), k(p0.z, p1.z, p2.z, p3.z));
  }

  private attractCamera(dt: number): void {
    if (!this.attractPts.length) return;
    this.attractT = (this.attractT + dt / 95) % 1;
    const p = this.pathPoint(this.attractT, new THREE.Vector3());
    const ahead = this.pathPoint(this.attractT + 0.012, new THREE.Vector3());
    this.camera.position.copy(p);
    const look = ahead.lerp(new THREE.Vector3(blockCenter(3), 40, blockCenter(3)), 0.12);
    look.y = Math.min(look.y, p.y) - 4;
    this.camera.lookAt(look);
    this.world.listenerPos.copy(p);
  }

  // ------------------------------------------------------------ loop

  private resize = (): void => {
    const c = this.opts.canvas;
    const w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post?.setSize(w, h);
    this.fx?.setPixelScale(h / 900 * Math.min(window.devicePixelRatio, this.q.pixelRatio));
  };

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    let dt = Math.min(this.debugRealtime ? 1 : 0.05, (now - this.last) / 1000);
    this.last = now;
    this.trackFps(dt);
    if (this.paused) dt = 0;
    const w = this.world;
    const d = this.director;
    if (d?.slowmo) dt *= 0.12;
    w.time += dt;
    w.uTime.value = w.time;
    const controls = !!this.player && this.introDone && !this.paused && (this.input.locked || this.lockedOnce) && d?.phase === "play";

    // Establishing shot while the briefing is open, then the swoop during 3-2-1.
    if (this.player && this.waiting) {
      const a = w.time * 0.08 + this.player.camYaw;
      const p0 = this.player.pos;
      this.camera.position.set(p0.x - Math.sin(a) * 60, 48, p0.z - Math.cos(a) * 60);
      this.camera.lookAt(p0.x, 4, p0.z);
      this.player.introCamera(0);
      this.camera.position.set(p0.x - Math.sin(a) * 60, 48, p0.z - Math.cos(a) * 60);
      this.camera.lookAt(p0.x, 4, p0.z);
    } else if (this.player && d && !this.introDone) {
      const t = 1 - Math.max(0, this.startLocal - Date.now()) / COUNTDOWN_MS;
      this.player.introCamera(Math.min(1, Math.max(0, t)));
      if (Date.now() >= this.startLocal) {
        this.introDone = true;
        d.begin();
        this.sound.startMusic();
      }
    }

    if (this.player && this.introDone) this.player.update(dt, this.input, controls);
    if (this.player) w.listenerPos.copy(this.player.pos);
    else this.attractCamera(dt);

    // Robots in the road make traffic wait; robots nearby scare the crowd.
    const alive = this.robots.list.filter((r) => r.alive && r.kind !== "drone");
    this.vehicles.extraObstacles = alive.map((r) => ({ x: r.pos.x, z: r.pos.z, r: r.kind === "brute" ? 1 : 0.6 }));
    this.crowd.threats = alive.map((r) => r.pos);

    this.vehicles.update(dt);
    if (this.player && this.introDone) this.player.postUpdate(dt);
    const pc = this.player?.car;
    if (pc && pc.driver === "player") {
      const hit = this.robots.carImpact(pc.pos, pc.heading, pc.vel);
      if (hit.hit && hit.carDamage > 0) { pc.takeDamage(hit.carDamage, pc.pos); pc.vel.multiplyScalar(1 - hit.slow); }
    }
    this.robots.update(dt);
    this.crowd.update(dt);
    d?.update(dt, this.input, controls);

    this.city.update(w.time, dt);
    this.sky.update(this.camera, h(this.opts.canvas));
    this.fx.update(dt);
    this.bubbles.update(w.time);
    if (this.q.shadows && this.player) {
      const p = this.player.pos;
      this.moon.position.set(p.x + 60, 120, p.z - 90);
      this.moon.target.position.set(p.x, 0, p.z);
    }

    // Screen effects.
    const p = this.player;
    const hurtRecent = p ? Math.max(0, 1 - (w.time - p.lastDamageAt) * 2.5) : 0;
    const lowHp = p && p.alive ? Math.max(0, (35 - p.health) / 35) : p && !p.alive ? 1 : 0;
    this.damagePulse = Math.max(hurtRecent * 0.7, lowHp * (0.45 + 0.25 * Math.sin(w.time * 6)));
    const glitch = (d?.slowmo ? 0.15 : 0) + (d?.phase === "lost" ? 0.8 : 0) + (p && !p.alive ? 0.5 : 0) + (this.introDone || !p ? 0 : 0.4 * Math.max(0, 1 - (Date.now() - (this.startLocal - COUNTDOWN_MS)) / 1500));
    const speed = pc ? Math.min(1, Math.max(0, (Math.abs(pc.speed) - 18) / 22)) : 0;
    this.post.set({ time: w.time, damage: this.damagePulse, glitch, heal: d?.phase === "won" ? Math.min(1, d.winT / 2) : 0, speed });
    if (!this.debugNoRender) this.post.render(this.scene, this.camera, dt);

    this.hudT -= dt || 1 / 60;
    if (this.player && this.hudT <= 0 && !this.waiting) {
      this.hudT = 1 / 12;
      this.opts.callbacks?.onHud(this.hud());
    }
    this.input.endFrame();
  };

  private trackFps(dt: number): void {
    this.fpsFrames++;
    this.fpsT += dt;
    if (this.fpsT < 1) return;
    this.fps = Math.round(this.fpsFrames / this.fpsT);
    this.fpsFrames = 0;
    this.fpsT = 0;
    if (!this.auto || this.paused) return;
    this.slowFor = this.fps < 28 ? this.slowFor + 1 : 0;
    if (this.slowFor >= 4) {
      this.slowFor = 0;
      const lower = lowerQuality(this.level);
      if (lower) this.setQuality(lower, false);
    }
  }

  setQuality(level: QualityLevel, save = true): void {
    if (save) { saveQuality(level); this.auto = false; }
    this.level = level;
    const q = QUALITY[level];
    Object.assign(this.q, { ...q, crowd: this.q.crowd, traffic: this.q.traffic, rainParticles: this.q.rainParticles });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    if (this.renderer.shadowMap.enabled !== q.shadows) {
      this.renderer.shadowMap.enabled = q.shadows;
      this.moon.castShadow = q.shadows;
    }
    this.post.dispose();
    this.post = new PostFX(this.renderer, this.scene, this.camera, q.bloom);
    (this.scene.fog as THREE.FogExp2).density = level === "low" ? 0.0062 : 0.0042;
    this.camera.far = q.farClip;
    this.camera.updateProjectionMatrix();
    this.resize();
  }

  get quality(): QualityLevel {
    return this.level;
  }

  private hud(): HudState {
    const p = this.player!;
    const d = this.director!;
    const car = p.car;
    const t = this.world.time;
    return {
      mode: d.phase === "won" ? "won" : d.phase === "lost" ? "lost" : !this.introDone || this.waiting ? "intro" : this.paused ? "paused" : !p.alive ? "dead" : d.hacking ? "hack" : car ? "car" : d.uplinkStarted && d.phase === "play" ? "uplink" : "foot",
      health: Math.round(p.health),
      lives: d.lives,
      heat: p.heat,
      overheated: p.overheated,
      empReady: 1 - p.empCd / EMP_COOLDOWN,
      carHealth: car ? Math.round((car.health / car.v.health) * 100) : 0,
      speedKmh: car ? Math.round(Math.abs(car.speed) * 3.6) : 0,
      objective: d.objective,
      objectiveDist: d.objectiveDist,
      cores: d.carried.length,
      coresTotal: d.vaults.length,
      vaults: d.vaults.map((v) => ({ id: v.v.id, name: v.v.name, state: v.state, hackType: v.v.hackType })),
      prompt: d.prompt,
      uplinkProgress: d.uplinkStarted ? d.uplinkProgress / (this.opts.mission?.uploadSec ?? 1) : null,
      inUplinkZone: false,
      bruteProgress: d.bruteProgress(),
      score: d.score,
      hitMarker: t - p.hitMarkerAt < 0.15 ? p.hitMarkerAt : 0,
      damageDir: t - p.lastDamageAt < 1 ? p.damageDir : null,
      damageAt: p.lastDamageAt,
      notices: [...d.notices],
      nullLine: d.nullLine,
      fps: this.fps,
      quality: this.level,
      player: { x: p.pos.x, z: p.pos.z, heading: car ? car.heading : p.camYaw },
      route: d.route,
      markers: d.markers(),
      timeLeft: d.timeLeft(),
      timeLimit: this.opts.timeLimit ?? this.opts.mission?.timeLimitSec ?? 300,
      carName: car ? car.v.name : null,
      inLobby: d.inLobby,
      firstTime: !!this.opts.firstTime,
      slowmo: d.slowmo,
    };
  }

  // ------------------------------------------------------------ page API

  /** Start (or resume) the mission clock: startAt/deadline are server timestamps. */
  setTiming(startAt: number, deadline: number | null): void {
    const offset = this.opts.bridge?.clockOffset() ?? 0;
    this.startLocal = startAt - offset;
    this.waiting = false;
    this.director?.setDeadline(deadline);
    this.introDone = Date.now() >= this.startLocal;
    if (this.introDone) { this.director?.begin(); this.sound.startMusic(); }
  }

  /** Live position for the minimap (read every animation frame). */
  pose(): { x: number; z: number; heading: number; car: boolean } | null {
    const p = this.player;
    if (!p) return null;
    return p.car ? { x: p.car.pos.x, z: p.car.pos.z, heading: p.car.heading, car: true } : { x: p.pos.x, z: p.pos.z, heading: p.camYaw, car: false };
  }

  private debugRealtime = false;
  private debugNoRender = false;

  /** Test helpers, only reachable when the page exposes them (NEXT_PUBLIC_GP_DEBUG=1). */
  debug = {
    /** Let game time follow the wall clock even at very low frame rates (software GPUs in CI). */
    realtime: (on: boolean) => { this.debugRealtime = on; },
    /** Skip drawing (keeps the last frame on screen) so slow software GPUs can screenshot overlays quickly. */
    renderOff: (on: boolean) => { this.debugNoRender = on; },
    god: (on: boolean) => { if (this.player) this.player.god = on; },
    teleport: (x: number, z: number) => {
      const p = this.player;
      if (!p) return;
      if (p.car) p.exitCar(true);
      p.pos.set(x, 0, z);
      p.vel.set(0, 0, 0);
    },
    face: (yaw: number) => { if (this.player) { this.player.camYaw = yaw; this.player.yaw = yaw; } },
    robots: () => this.robots.list.filter((r) => r.alive).map((r) => ({ id: r.id, kind: r.kind, x: r.pos.x, z: r.pos.z })),
    killNear: (radius: number) => {
      const p = this.player;
      if (!p) return 0;
      let n = 0;
      for (const r of this.robots.list) if (r.alive && r.pos.distanceTo(p.pos) < radius) { this.robots.damage(r, 9999, null, "gun"); n++; }
      return n;
    },
    heal: () => { if (this.player) this.player.health = 100; },
    fire: (on: boolean) => { this.input.fire = on; },
    aimAt: (x: number, y: number, z: number) => {
      const p = this.player;
      if (!p) return;
      p.camYaw = Math.atan2(x - p.pos.x, z - p.pos.z);
      p.camPitch = Math.atan2(y - 1.6, Math.hypot(x - p.pos.x, z - p.pos.z));
    },
    key: (code: string, down: boolean) => {
      const keys = (this.input as unknown as { keys: Set<string>; pressed: Set<string> });
      if (down) { keys.keys.add(code); keys.pressed.add(code); } else keys.keys.delete(code);
    },
    cam: () => ({ cam: this.camera.position.toArray().map((v) => +v.toFixed(2)), car: this.player?.car ? [this.player.car.pos.x, this.player.car.pos.z, this.player.car.heading].map((v) => +v.toFixed(2)) : null, camDist: (this.player as unknown as { camDist: number })?.camDist, yaw: this.player?.camYaw }),
    state: () => ({ fps: this.fps, quality: this.level, calls: this.renderer.info.render.calls, tris: this.renderer.info.render.triangles, cars: this.vehicles.cars.length, robots: this.robots.list.length }),
  };

  get started(): boolean {
    return this.introDone;
  }

  requestLock(): void {
    this.sound.unlock();
    this.input.requestLock();
    this.lockedOnce = true;
  }

  releaseLock(): void {
    this.input.releaseLock();
  }

  setPaused(p: boolean): void {
    this.paused = p;
    if (p) this.sound.setEngine(false);
  }

  setMuted(m: boolean): void {
    this.sound.setMuted(m);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    this.input.dispose();
    this.sound.dispose();
    this.post?.dispose();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
      for (const m of mats) {
        for (const v of Object.values(m as unknown as Record<string, unknown>)) if (v instanceof THREE.Texture) v.dispose();
        m.dispose();
      }
    });
    this.renderer.dispose();
    // Free the GPU once the canvas is really gone (a new mission or the menu city makes its own).
    // React's development double-mount reuses the same canvas, so it must keep its context.
    const canvas = this.opts.canvas, renderer = this.renderer;
    setTimeout(() => { if (!canvas.isConnected) renderer.forceContextLoss(); }, 250);
  }
}

function h(canvas: HTMLCanvasElement): number {
  return (canvas.clientHeight || 900) / 900;
}
