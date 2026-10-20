/*
 * All game audio is synthesised with the Web Audio API: no sound files, works offline.
 * Browsers only allow audio after a click or key press; the first START press unlocks it.
 */

let muted = false;
try { muted = typeof localStorage !== "undefined" && localStorage.getItem("gp-muted") === "1"; } catch { /* storage blocked */ }

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private engine: { osc: OscillatorNode; osc2: OscillatorNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
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

  /** Continuous engine hum while driving; call every frame with speed 0..1 and throttle 0..1. */
  setEngine(on: boolean, speed = 0, throttle = 0): void {
    const ctx = this.ready();
    if (!ctx) return;
    if (on && !this.engine) {
      const osc = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      osc.type = "sawtooth";
      osc2.type = "square";
      filter.type = "lowpass";
      filter.frequency.value = 600;
      gain.gain.value = 0;
      osc.connect(filter);
      osc2.connect(filter);
      filter.connect(gain).connect(this.sfxBus!);
      osc.start();
      osc2.start();
      this.engine = { osc, osc2, filter, gain };
    }
    if (!this.engine) return;
    const t = ctx.currentTime;
    if (!on) {
      this.engine.gain.gain.setTargetAtTime(0, t, 0.1);
      const e = this.engine;
      this.engine = null;
      setTimeout(() => { try { e.osc.stop(); e.osc2.stop(); } catch { /* already stopped */ } }, 400);
      return;
    }
    const f = 45 + speed * 140 + throttle * 20;
    this.engine.osc.frequency.setTargetAtTime(f, t, 0.08);
    this.engine.osc2.frequency.setTargetAtTime(f * 0.5, t, 0.08);
    this.engine.filter.frequency.setTargetAtTime(400 + speed * 1600 + throttle * 600, t, 0.1);
    this.engine.gain.gain.setTargetAtTime(0.05 + throttle * 0.05 + speed * 0.04, t, 0.1);
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
    void this.ctx?.close();
    this.ctx = null;
  }
}
