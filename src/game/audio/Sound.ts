import { Voice } from "./Voice";

/*
 * All game audio is synthesised with the Web Audio API: no sound files, works offline.
 * Browsers only allow audio after a click or key press; the first START press unlocks it.
 * Spoken lines (hero quips, NULL's taunts) use the browser's speech voice (Voice.ts).
 */

let muted = false;
try { muted = typeof localStorage !== "undefined" && localStorage.getItem("gp-muted") === "1"; } catch { /* storage blocked */ }

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private engine: { nodes: AudioScheduledSourceNode[]; osc: OscillatorNode; sub: OscillatorNode; lfo: OscillatorNode; rasp: BiquadFilterNode; filter: BiquadFilterNode; gain: GainNode; rpm: number; gear: number } | null = null;
  private rotor: { nodes: AudioScheduledSourceNode[]; lfo: OscillatorNode; whine: OscillatorNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  private rail: { nodes: AudioScheduledSourceNode[]; filter: BiquadFilterNode; gain: GainNode; clackT: number } | null = null;
  voice = new Voice(() => muted);
  private noiseBuf: AudioBuffer | null = null;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private ambience: AudioBufferSourceNode | null = null;
  private lastPlay = new Map<string, number>();

  get muted(): boolean { return muted; }

  setMuted(m: boolean): void {
    muted = m;
    try { localStorage.setItem("gp-muted", m ? "1" : "0"); } catch { /* ignore */ }
    if (this.master) this.master.gain.value = m ? 0 : 0.8;
  }

  unlock(): void {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!C) return;
      this.ctx = new C();
      this.master = this.ctx.createGain();
      this.master.gain.value = muted ? 0 : 0.8;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.connect(this.master);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 0.22;
      this.musicBus.connect(this.master);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  private ready(): AudioContext | null {
    return this.ctx && this.sfxBus ? this.ctx : null;
  }

  /** Avoid machine-gun stacking of the same sound. */
  private throttle(key: string, ms: number): boolean {
    const t = performance.now();
    if ((this.lastPlay.get(key) ?? 0) + ms > t) return false;
    this.lastPlay.set(key, t);
    return true;
  }

  private tone(freq: number, dur: number, o: { type?: OscillatorType; vol?: number; at?: number; slide?: number; pan?: number } = {}): void {
    const ctx = this.ready();
    if (!ctx) return;
    // Exponential ramps cannot target 0; very quiet sounds are skipped.
    if ((o.vol ?? 0.15) < 0.003) return;
    const t0 = ctx.currentTime + (o.at ?? 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = o.type ?? "square";
    osc.frequency.setValueAtTime(freq, t0);
    if (o.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.slide), t0 + dur);
    if (!(freq > 0)) return;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.vol ?? 0.15, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node: AudioNode = osc.connect(g);
    if (o.pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, o.pan));
      node = node.connect(p);
    }
    node.connect(this.sfxBus!);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  private noise(dur: number, o: { vol?: number; freq?: number; q?: number; type?: BiquadFilterType; at?: number; pan?: number; slide?: number } = {}): void {
    const ctx = this.ready();
    if (!ctx || !this.noiseBuf) return;
    if ((o.vol ?? 0.3) < 0.003) return;
    const t0 = ctx.currentTime + (o.at ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = o.type ?? "lowpass";
    f.frequency.setValueAtTime(o.freq ?? 1200, t0);
    if (o.slide) f.frequency.exponentialRampToValueAtTime(o.slide, t0 + dur);
    f.Q.value = o.q ?? 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(o.vol ?? 0.3, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node: AudioNode = src.connect(f).connect(g);
    if (o.pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, o.pan));
      node = node.connect(p);
    }
    node.connect(this.sfxBus!);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.05);
  }

  blaster(): void {
    this.tone(1400, 0.09, { type: "sawtooth", vol: 0.07, slide: 280 });
    this.tone(700, 0.06, { type: "square", vol: 0.04, slide: 200 });
    this.noise(0.05, { vol: 0.08, freq: 4000, type: "highpass" });
  }
  enemyShot(pan = 0, vol = 1): void {
    if (!this.throttle("enemy", 60)) return;
    this.tone(520, 0.16, { type: "square", vol: 0.05 * vol, slide: 160, pan });
  }
  hitMarker(): void { this.tone(1800, 0.03, { type: "triangle", vol: 0.06 }); }
  /** Scatter gun: a heavy, short boom. */
  scatter(): void {
    this.noise(0.28, { vol: 0.32, freq: 3200, slide: 260 });
    this.tone(95, 0.22, { type: "sine", vol: 0.26, slide: 38 });
    this.tone(2200, 0.03, { type: "square", vol: 0.03 });
  }
  /** Plasma bomb leaves the hand. */
  throwWhoosh(): void { this.noise(0.28, { vol: 0.13, freq: 400, slide: 1800, type: "bandpass", q: 1.2 }); }
  bombBeep(): void { if (this.throttle("bbeep", 120)) this.tone(1650, 0.05, { type: "square", vol: 0.05 }); }
  bigBoom(vol = 1, pan = 0): void {
    this.explosion(1.25 * vol, pan);
    this.tone(48, 1.1, { type: "sine", vol: 0.32 * vol, slide: 24, pan });
    this.noise(0.12, { vol: 0.25 * vol, freq: 6000, type: "highpass", pan });
  }
  /** Energy blade swing and hit. */
  swish(): void {
    this.noise(0.17, { vol: 0.16, freq: 1600, slide: 6500, type: "bandpass", q: 2 });
    this.tone(700, 0.14, { type: "triangle", vol: 0.04, slide: 2600 });
  }
  bladeHit(): void {
    this.tone(2500, 0.07, { type: "square", vol: 0.05, slide: 1400 });
    this.tone(1250, 0.14, { type: "triangle", vol: 0.06 });
    this.noise(0.06, { vol: 0.12, freq: 5000, type: "highpass" });
  }
  /** A sharp cartoon slap: CHATAAK! */
  slap(): void {
    this.noise(0.08, { vol: 0.6, freq: 2200, type: "highpass" });
    this.noise(0.05, { vol: 0.3, freq: 900, type: "bandpass", q: 3 });
    this.tone(320, 0.05, { type: "triangle", vol: 0.15 });
    this.tone(640, 0.3, { type: "sine", vol: 0.05, slide: 260, at: 0.05 });
  }
  slapMiss(): void { this.noise(0.12, { vol: 0.1, freq: 1200, type: "bandpass", q: 1 }); }
  roll(): void { this.noise(0.28, { vol: 0.09, freq: 900, slide: 300 }); }
  /** Footstep on pavement: a short soft thud with a little grit (louder when sprinting). */
  step(sprint: boolean): void {
    if (!this.throttle("step", 160)) return;
    const v = sprint ? 0.06 : 0.035;
    this.noise(0.05, { vol: v, freq: 180 + Math.random() * 80 });
    this.noise(0.03, { vol: v * 0.5, freq: 2400 + Math.random() * 900, type: "bandpass", q: 2 });
  }
  land(): void { if (this.throttle("land", 200)) this.noise(0.1, { vol: 0.09, freq: 260 }); }
  weaponSwitch(): void { this.tone(1400, 0.03, { type: "square", vol: 0.04 }); this.tone(900, 0.04, { type: "square", vol: 0.03, at: 0.04 }); }
  empty(): void { if (this.throttle("empty", 300)) this.tone(260, 0.06, { type: "square", vol: 0.04 }); }
  killConfirm(n = 1): void {
    if (!this.throttle("kc", 90)) return;
    const base = 660 * Math.pow(1.12, Math.min(6, n - 1));
    this.tone(base, 0.07, { type: "triangle", vol: 0.07 });
    this.tone(base * 1.5, 0.1, { type: "triangle", vol: 0.06, at: 0.06 });
  }
  shard(): void { [1046, 1318, 1568, 2093].forEach((f, i) => this.tone(f, 0.12, { type: "triangle", vol: 0.06, at: i * 0.05 })); }
  titanRoar(): void {
    this.tone(70, 1.3, { type: "sawtooth", vol: 0.18, slide: 38 });
    this.noise(1.1, { vol: 0.22, freq: 420, slide: 120, type: "bandpass", q: 1.5 });
  }
  stomp(vol = 1, pan = 0): void { if (this.throttle("stomp", 120)) { this.tone(55, 0.3, { type: "sine", vol: 0.3 * vol, slide: 30, pan }); this.noise(0.15, { vol: 0.12 * vol, freq: 300, pan }); } }
  truckHorn(): void { if (!this.throttle("thorn", 2500)) return; this.tone(185, 0.6, { type: "sawtooth", vol: 0.06 }); this.tone(233, 0.6, { type: "sawtooth", vol: 0.05 }); }
  stationBell(): void { this.tone(988, 0.35, { type: "sine", vol: 0.08 }); this.tone(784, 0.5, { type: "sine", vol: 0.08, at: 0.3 }); }
  ricochet(): void { if (this.throttle("rico", 40)) this.noise(0.06, { vol: 0.05, freq: 3000, type: "bandpass", q: 4 }); }
  explosion(vol = 1, pan = 0): void {
    this.noise(0.9, { vol: 0.45 * vol, freq: 900, slide: 80, pan });
    this.tone(70, 0.6, { type: "sine", vol: 0.35 * vol, slide: 30, pan });
  }
  hurt(): void {
    if (!this.throttle("hurt", 120)) return;
    this.tone(160, 0.18, { type: "sawtooth", vol: 0.12, slide: 70 });
    this.noise(0.12, { vol: 0.1, freq: 500 });
  }
  emp(): void {
    this.tone(90, 0.8, { type: "sawtooth", vol: 0.2, slide: 1600 });
    this.noise(0.7, { vol: 0.3, freq: 300, slide: 6000, type: "bandpass", q: 2 });
  }
  overheat(): void { this.noise(0.6, { vol: 0.15, freq: 5000, type: "highpass" }); this.tone(300, 0.3, { type: "square", vol: 0.05, slide: 150 }); }
  pickup(): void { [523, 659, 784, 1046, 1318].forEach((f, i) => this.tone(f, 0.18, { type: "square", vol: 0.08, at: i * 0.06 })); }
  hackBeep(): void { this.tone(1200, 0.05, { type: "square", vol: 0.04 }); }
  hackOk(): void { [880, 1175, 1568].forEach((f, i) => this.tone(f, 0.16, { type: "square", vol: 0.08, at: i * 0.08 })); }
  hackFail(): void { this.tone(220, 0.5, { type: "sawtooth", vol: 0.12, slide: 90 }); }
  alarm(): void {
    for (let i = 0; i < 6; i++) { this.tone(880, 0.25, { type: "square", vol: 0.06, at: i * 0.5, slide: 660 }); this.tone(660, 0.25, { type: "square", vol: 0.06, at: i * 0.5 + 0.25, slide: 880 }); }
  }
  crash(vol = 1): void { if (!this.throttle("crash", 150)) return; this.noise(0.35, { vol: 0.35 * vol, freq: 1500, slide: 200 }); this.tone(180, 0.3, { type: "triangle", vol: 0.1 * vol, slide: 90 }); }
  horn(): void { if (!this.throttle("horn", 400)) return; this.tone(415, 0.35, { type: "sawtooth", vol: 0.07 }); this.tone(523, 0.35, { type: "sawtooth", vol: 0.06 }); }
  door(): void { this.noise(0.2, { vol: 0.1, freq: 800 }); }
  countdown(go = false): void { this.tone(go ? 880 : 440, go ? 0.4 : 0.15, { type: "square", vol: 0.1 }); }
  uplinkTick(p: number): void { if (this.throttle("uplink", 400)) this.tone(300 + p * 900, 0.12, { type: "sine", vol: 0.08 }); }
  win(): void { [523, 659, 784, 1046, 784, 1046, 1318].forEach((f, i) => this.tone(f, 0.25, { type: "square", vol: 0.09, at: i * 0.13 })); }
  lose(): void { [392, 349, 311, 262, 196].forEach((f, i) => this.tone(f, 0.35, { type: "sawtooth", vol: 0.09, at: i * 0.22 })); }
  down(): void { this.tone(400, 1.2, { type: "sawtooth", vol: 0.15, slide: 40 }); this.noise(1.0, { vol: 0.2, freq: 2000, slide: 100 }); }

  /**
   * Car engine while driving: call every frame with speed 0..1 (of top speed) and throttle 0..1.
   * A small gearbox model makes the revs climb and drop at each shift ("vroom... vroom"), and a
   * low-pass filter plus a soft firing pulse keep it smooth rather than buzzy.
   */
  setEngine(on: boolean, speed = 0, throttle = 0): void {
    const ctx = this.ready();
    if (!ctx) return;
    if (on && !this.engine && this.noiseBuf) {
      const osc = ctx.createOscillator();
      const sub = ctx.createOscillator();
      const lfo = ctx.createOscillator();
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuf;
      noise.loop = true;
      osc.type = "sawtooth";
      sub.type = "sine";
      lfo.type = "sine";
      const rasp = ctx.createBiquadFilter();
      rasp.type = "bandpass";
      rasp.Q.value = 1.4;
      const raspGain = ctx.createGain();
      raspGain.gain.value = 0.35;
      const oscGain = ctx.createGain();
      oscGain.gain.value = 0.55;
      const subGain = ctx.createGain();
      subGain.gain.value = 0.9;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 0.9;
      filter.frequency.value = 300;
      // Firing pulse: the LFO wobbles the level a little, like individual cylinders.
      const pulse = ctx.createGain();
      pulse.gain.value = 0.75;
      const depth = ctx.createGain();
      depth.gain.value = 0.25;
      lfo.connect(depth).connect(pulse.gain);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(oscGain).connect(filter);
      sub.connect(subGain).connect(filter);
      noise.connect(rasp).connect(raspGain).connect(filter);
      filter.connect(pulse).connect(gain).connect(this.sfxBus!);
      for (const n of [osc, sub, lfo, noise]) n.start();
      this.engine = { nodes: [osc, sub, lfo, noise], osc, sub, lfo, rasp, filter, gain, rpm: 0.15, gear: 0 };
    }
    if (!this.engine) return;
    const e = this.engine;
    const t = ctx.currentTime;
    if (!on) {
      e.gain.gain.setTargetAtTime(0, t, 0.12);
      this.engine = null;
      setTimeout(() => { for (const n of e.nodes) { try { n.stop(); } catch { /* already stopped */ } } }, 500);
      return;
    }
    // Gearbox: five gears over the speed range; revs rise through each gear and drop on the shift.
    const GEARS = [0, 0.15, 0.31, 0.5, 0.72, 1.02];
    const v = Math.max(0, Math.min(1, speed));
    let g = 0;
    while (g < GEARS.length - 2 && v >= GEARS[g + 1]) g++;
    const within = (v - GEARS[g]) / (GEARS[g + 1] - GEARS[g]);
    const target = v < 0.03 ? 0.16 + throttle * 0.28 : 0.24 + within * 0.62 + throttle * 0.06;
    if (g > e.gear && v > 0.05) this.noise(0.07, { vol: 0.05, freq: 500 }); // exhaust blip on the upshift
    e.gear = g;
    e.rpm += (target - e.rpm) * 0.25;
    const f = 26 + e.rpm * 120;
    e.osc.frequency.setTargetAtTime(f, t, 0.06);
    e.sub.frequency.setTargetAtTime(f * 0.5, t, 0.06);
    e.lfo.frequency.setTargetAtTime(f * 0.5, t, 0.06);
    e.rasp.frequency.setTargetAtTime(f * 3, t, 0.08);
    e.filter.frequency.setTargetAtTime(220 + e.rpm * 1100 + throttle * 380, t, 0.08);
    e.gain.gain.setTargetAtTime(0.022 + throttle * 0.026 + e.rpm * 0.018, t, 0.1);
  }

  /** Helicopter: blade thump (faster with lift) and a turbine whine. */
  setRotor(on: boolean, lift = 0, speed = 0): void {
    const ctx = this.ready();
    if (!ctx) return;
    if (on && !this.rotor && this.noiseBuf) {
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuf;
      noise.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 380;
      const chop = ctx.createGain();
      chop.gain.value = 0.5;
      const lfo = ctx.createOscillator();
      lfo.type = "square";
      lfo.frequency.value = 9;
      const depth = ctx.createGain();
      depth.gain.value = 0.5;
      lfo.connect(depth).connect(chop.gain);
      const whine = ctx.createOscillator();
      whine.type = "sine";
      whine.frequency.value = 900;
      const wg = ctx.createGain();
      wg.gain.value = 0.012;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      noise.connect(filter).connect(chop).connect(gain);
      whine.connect(wg).connect(gain);
      gain.connect(this.sfxBus!);
      for (const n of [noise, lfo, whine]) n.start();
      this.rotor = { nodes: [noise, lfo, whine], lfo, whine, filter, gain };
    }
    if (!this.rotor) return;
    const r = this.rotor;
    const t = ctx.currentTime;
    if (!on) {
      r.gain.gain.setTargetAtTime(0, t, 0.3);
      this.rotor = null;
      setTimeout(() => { for (const n of r.nodes) { try { n.stop(); } catch { /* ignore */ } } }, 1200);
      return;
    }
    r.lfo.frequency.setTargetAtTime(8 + lift * 6 + speed * 3, t, 0.2);
    r.whine.frequency.setTargetAtTime(800 + lift * 500 + speed * 300, t, 0.2);
    r.filter.frequency.setTargetAtTime(300 + lift * 300, t, 0.2);
    r.gain.gain.setTargetAtTime(0.18 + lift * 0.12, t, 0.2);
  }

  /** Metro train: low rumble and wheel clacks over rail joints. */
  setTrain(on: boolean, speed = 0, dt = 0): void {
    const ctx = this.ready();
    if (!ctx) return;
    if (on && !this.rail && this.noiseBuf) {
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuf;
      noise.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 160;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      noise.connect(filter).connect(gain).connect(this.sfxBus!);
      noise.start();
      this.rail = { nodes: [noise], filter, gain, clackT: 0 };
    }
    if (!this.rail) return;
    const r = this.rail;
    const t = ctx.currentTime;
    if (!on) {
      r.gain.gain.setTargetAtTime(0, t, 0.3);
      this.rail = null;
      setTimeout(() => { try { r.nodes[0].stop(); } catch { /* ignore */ } }, 1200);
      return;
    }
    r.gain.gain.setTargetAtTime(0.08 + speed * 0.22, t, 0.3);
    r.filter.frequency.setTargetAtTime(120 + speed * 260, t, 0.3);
    r.clackT -= dt * speed;
    if (speed > 0.15 && r.clackT <= 0) {
      r.clackT = 0.55;
      this.tone(140, 0.05, { type: "square", vol: 0.04 });
      this.noise(0.05, { vol: 0.07, freq: 900, at: 0.09 });
    }
  }

  /** Low city drone plus a simple synthwave loop. */
  startMusic(): void {
    const ctx = this.ready();
    if (!ctx || this.musicTimer || !this.noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 140;
    const g = ctx.createGain();
    g.gain.value = 0.35;
    src.connect(f).connect(g).connect(this.musicBus!);
    src.start();
    this.ambience = src;
    const bass = [55, 55, 65.4, 49];
    const arp = [220, 261.6, 329.6, 392, 329.6, 261.6];
    let step = 0;
    const beat = 0.26;
    this.musicTimer = setInterval(() => {
      const c = this.ctx;
      if (!c || !this.musicBus) return;
      const t = c.currentTime + 0.05;
      const bar = Math.floor(step / 8) % bass.length;
      const o = c.createOscillator();
      const og = c.createGain();
      o.type = "sawtooth";
      o.frequency.value = bass[bar];
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      og.gain.exponentialRampToValueAtTime(0.0001, t + beat * 0.9);
      const lp = c.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 500;
      o.connect(lp).connect(og).connect(this.musicBus);
      o.start(t);
      o.stop(t + beat);
      if (step % 2 === 0) {
        const a = c.createOscillator();
        const ag = c.createGain();
        a.type = "square";
        a.frequency.value = arp[(step / 2) % arp.length] * (bar === 2 ? 1.19 : 1);
        ag.gain.setValueAtTime(0.0001, t);
        ag.gain.exponentialRampToValueAtTime(0.05, t + 0.01);
        ag.gain.exponentialRampToValueAtTime(0.0001, t + beat * 0.8);
        a.connect(ag).connect(this.musicBus);
        a.start(t);
        a.stop(t + beat);
      }
      step++;
    }, 260);
  }

  stopMusic(): void {
    if (this.musicTimer) clearInterval(this.musicTimer);
    this.musicTimer = null;
    try { this.ambience?.stop(); } catch { /* ignore */ }
    this.ambience = null;
  }

  dispose(): void {
    this.stopMusic();
    this.setEngine(false);
    this.setRotor(false);
    this.setTrain(false);
    this.voice.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}
