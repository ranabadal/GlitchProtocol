import * as THREE from "three";
import { accessNodes, getCity, shortestPath } from "@/lib/shared/city";
import { coreIds, OP_INFO, type MissionPublic, type Pt, type Spawn, type VaultPublic } from "@/lib/shared/mission";
import type { Crowd } from "../actors/Crowd";
import type { Player } from "../actors/Player";
import type { HitBy, Robot, Robots } from "../actors/Robots";
import type { Heli, Metro } from "../actors/Rides";
import type { QuipKind } from "../audio/Voice";
import { DataTruck, Shards } from "./Extras";
import type { Vehicles } from "../actors/Vehicles";
import type { Colliders } from "../Colliders";
import type { Input } from "../Input";
import { BridgeError, type HackRequest, type MapMarker, type MissionBridge, type Notice, type ServerProgress, type Sync } from "../types";
import type { CityView } from "../world/City";
import { buildBarricades, Fences, Medkits, UplinkZone, VaultLobby, type VaultState } from "../world/MissionProps";
import { panFor, type World } from "../World";

/*
 * Runs one mission on the client: objectives, vault hacks, alarms, cores, the uplink,
 * lives and respawns. Every scoring event goes to the server through the bridge and
 * the server's answer is what counts; the client only decides what to show.
 */

const DEFAULT_VOICE = {
  onKill: ["Arre! Mera robot!", "Ek gaya, sau aur hain!"],
  onDown: ["Hahaha! System down!", "Ek life gayi, operator!"],
  onAlarm: ["ALARM! Pakdo isse!", "Galat code! Robots, attack!"],
  onCore: ["Mera core wapas karo!", "Chor! Data chor!"],
  onWin: "Nahiii! Mera system crash ho raha hai...",
  onLose: "Neon City mera hai! Phir try karna, operator.",
};

export const HACK_NAMES: Record<string, string> = { glitch: "Data Stream Breach", power: "Firewall Bypass", imposter: "Identity Scan" };

interface VaultRt {
  v: VaultPublic;
  lobby: VaultLobby;
  state: VaultState;
  bruteUntil: number | null;
  attemptsLeft: number;
}

export interface DirectorOptions {
  world: World;
  mission: MissionPublic;
  progress: ServerProgress | null;
  bridge: MissionBridge;
  player: Player;
  robots: Robots;
  vehicles: Vehicles;
  crowd: Crowd;
  city: CityView;
  colliders: Colliders;
  voice?: typeof DEFAULT_VOICE;
  deadline: number | null;
  /** Server time the mission clock started (for the data truck's position). */
  startAt?: number | null;
  firstTime: boolean;
  rides?: { helis: Heli[]; metro: Metro | null };
  onFinished: (outcome: "won" | "lost") => void;
  onError: (msg: string) => void;
}

export class Director {
  group = new THREE.Group();
  vaults: VaultRt[] = [];
  fences: Fences;
  uplink: UplinkZone;
  medkits: Medkits;
  phase: "intro" | "play" | "won" | "lost" = "intro";
  score = 0;
  lives: number;
  downs = 0;
  carried: string[] = [];
  uplinkStarted = false;
  uplinkProgress = 0;
  wave2 = false;
  hacking: string | null = null;
  slowmo = false;
  notices: Notice[] = [];
  nullLine: { text: string; at: number } | null = null;
  route: Pt[] = [];
  objective = "";
  objectiveDist: number | null = null;
  prompt: string | null = null;
  inLobby = false;
  truck: DataTruck | null = null;
  shards: Shards | null = null;
  /** Kills in quick succession, for the combo counter. */
  combo = { n: 0, at: -99 };
  heroLine: { text: string; at: number } | null = null;
  private recentKills: number[] = [];
  private startAt: number | null = null;
  private truckBusy = false;
  private killNow = false;
  private busy = false;
  private pendingKills: string[] = [];
  private killTimer = 0;
  private killBackoff = 0;
  private routeTimer = 0;
  private noticeId = 1;
  private checkpoint: { x: number; z: number; heading: number };
  private respawnAt = -1;
  private released = new Set<string>();
  private orbit: THREE.Mesh[] = [];
  private lastVoiceAt = -99;
  winT = -1;
  private loseT = -1;
  private uplinkBusy = false;
  private uplinkRetryAt = 0;
  private downQueue: number | null = null;
  private healR = 0;
  private m: MissionPublic;
  private voice: typeof DEFAULT_VOICE;
  private tmp = new THREE.Vector3();

  constructor(private o: DirectorOptions) {
    const w = o.world;
    const m = o.mission;
    this.m = m;
    this.voice = { ...DEFAULT_VOICE, ...(o.voice ?? {}) };
    this.lives = o.progress?.lives ?? m.lives;
    this.downs = o.progress?.downs ?? 0;
    this.score = o.progress?.score ?? 0;
    this.checkpoint = { x: m.start.x, z: m.start.z, heading: m.start.heading };
    this.startAt = o.startAt ?? null;

    for (const v of m.vaults) {
      const lobby = new VaultLobby(v, o.colliders, w.uTime);
      this.group.add(lobby.group);
      this.vaults.push({ v, lobby, state: "locked", bruteUntil: null, attemptsLeft: 3 });
    }
    this.group.add(buildBarricades(m.barricades, o.colliders, w.uTime));
    this.fences = new Fences(m.fences, o.colliders);
    this.fences.onDisabled = (f) => {
      const p = f.pylons[0].pos.clone().lerp(f.pylons[1].pos, 0.5).setY(1.5);
      w.fx.explosion(f.pylons.find((x) => x.hp <= 0)?.pos.clone().setY(1.6) ?? p, 1);
      const sp = panFor(w, p.x, p.z);
      w.sound.explosion(Math.max(0.4, sp.vol), sp.pan);
      w.shake(0.3);
      this.notice("Laser fence band! Rasta saaf.", "good");
      o.vehicles.blocked.delete(f.edge);
    };
    this.group.add(this.fences.group);
    this.uplink = new UplinkZone(m.uplink.x, m.uplink.z, m.uplink.radius, w.uTime);
    this.group.add(this.uplink.group);
    // Repair kits: outside every vault and at the uplink plaza.
    const kits: Pt[] = [];
    for (const v of m.vaults) {
      const b = getCity().buildingById.get(v.buildingId)!;
      const [nx, nz] = v.side === "px" ? [1, 0] : v.side === "nx" ? [-1, 0] : v.side === "pz" ? [0, 1] : [0, -1];
      const ax = nz !== 0 ? 1 : 0, az = nx !== 0 ? 1 : 0;
      const off = (nz !== 0 ? b.w : b.d) / 2 - 2;
      kits.push({ x: v.door.x + nx * 2.2 + ax * off, z: v.door.z + nz * 2.2 + az * off });
    }
    kits.push({ x: m.uplink.x + 20, z: m.uplink.z + 20 }, { x: m.uplink.x - 20, z: m.uplink.z - 20 });
    this.medkits = new Medkits(kits);
    this.group.add(this.medkits.group);
    // Data truck and bonus shards.
    if (m.courier) {
      this.truck = new DataTruck(m.courier, w, o.robots, m.band);
      this.truck.onDestroyed = () => this.onTruckDestroyed();
      this.group.add(this.truck.group);
      o.player.extraTargets.push(this.truck);
    }
    if (m.shards?.length) {
      this.shards = new Shards(m.shards, new Set(o.progress?.shards ?? []));
      this.group.add(this.shards.group);
    }
    w.scene.add(this.group);

    for (const b of m.barricades) o.vehicles.blocked.add(b.edge);
    for (const f of m.fences) o.vehicles.blocked.add(f.edge);

    // Restore progress after a page refresh.
    const pr = o.progress;
    const killed = new Set(pr?.killed ?? []);
    for (const key of pr?.released ?? ["start"]) this.release(key, false, killed);
    if (!this.released.has("start")) this.release("start", false, killed);
    for (const t of m.turrets) if (!killed.has(t.id)) o.robots.spawn({ id: t.id, kind: "turret", x: t.x, z: t.z }, { group: "turrets" });
    if (pr) {
      for (const vr of this.vaults) {
        const h = pr.hacks[vr.v.id];
        if (h) { vr.bruteUntil = h.bruteUntil; vr.attemptsLeft = 3 - h.attempt; }
        if (pr.picked.includes(vr.v.id)) { vr.state = "taken"; this.carried.push(vr.v.id); }
        else if (vr.v.lock === "titan" && vr.v.guard && pr.killed.includes(vr.v.guard)) vr.state = "open";
        else if (pr.unlocked.includes(vr.v.id)) vr.state = "open";
        else if (vr.bruteUntil) vr.state = "brute";
        vr.lobby.setState(vr.state);
      }
      if (this.truck && m.courier && pr.killed.includes(m.courier.id)) {
        const drop = pr.courierDrop ?? { x: this.truck.pos.x, z: this.truck.pos.z };
        if (pr.picked.includes(m.courier.id)) { this.truck.collected = true; this.carried.push(m.courier.id); }
        this.truck.dropAt(drop.x, drop.z);
      }
      if (pr.uplink.startedAt) {
        this.uplinkStarted = true;
        this.uplinkProgress = Math.min(m.uploadSec - 0.5, Math.max(0, (this.serverNow() - pr.uplink.startedAt) / 1000 - 2));
        this.wave2 = this.released.has("uplink:2") && this.uplinkProgress > m.uploadSec * 0.4;
      }
      // Respawn next to the last thing completed.
      const last = this.vaults.filter((x) => x.state === "taken").pop();
      if (this.uplinkStarted) this.checkpoint = { x: m.uplink.x + m.uplink.radius * 0.5, z: m.uplink.z, heading: 0 };
      else if (last) this.checkpoint = this.outside(last.v);
    }
    this.syncOrbit();

    o.robots.onKilled = (r, by) => this.onRobotKilled(r, by);
    o.player.onDeath = () => this.onPlayerDown();
    o.player.onRide = (kind) => { if (kind !== "car") this.quip(kind, 1); };
  }

  /** Total cores this mission needs (vaults plus the data truck). */
  get coresTotal(): number {
    return coreIds(this.m).length;
  }

  setStart(startAt: number | null): void {
    this.startAt = startAt;
  }

  /** Seconds since the mission clock started (server time). */
  missionSec(): number {
    return this.startAt ? Math.max(0, (this.serverNow() - this.startAt) / 1000) : 0;
  }

  private quip(kind: QuipKind, chance = 0.45, force = false): void {
    const text = this.o.world.sound.voice.hero(kind, chance, force);
    if (text) this.heroLine = { text, at: performance.now() };
  }

  private outside(v: VaultPublic): { x: number; z: number; heading: number } {
    const [nx, nz] = v.side === "px" ? [1, 0] : v.side === "nx" ? [-1, 0] : v.side === "pz" ? [0, 1] : [0, -1];
    return { x: v.door.x + nx * 5, z: v.door.z + nz * 5, heading: Math.atan2(-nx, -nz) };
  }

  setDeadline(deadline: number | null): void {
    this.o.deadline = deadline;
  }

  get spawnPoint(): { x: number; z: number; heading: number } {
    return this.checkpoint;
  }

  serverNow(): number {
    return Date.now() + this.o.bridge.clockOffset();
  }

  timeLeft(): number | null {
    return this.o.deadline ? Math.max(0, (this.o.deadline - this.serverNow()) / 1000) : null;
  }

  // ------------------------------------------------------------ messages

  notice(text: string, tone: Notice["tone"] = "info"): void {
    this.notices.push({ id: this.noticeId++, text, tone, at: performance.now() });
    if (this.notices.length > 5) this.notices.shift();
  }

  say(lines: string[] | string, force = false): void {
    const w = this.o.world;
    if (!force && w.time - this.lastVoiceAt < 6) return;
    this.lastVoiceAt = w.time;
    const text = Array.isArray(lines) ? lines[Math.floor(Math.random() * lines.length)] : lines;
    this.nullLine = { text, at: performance.now() };
    w.sound.voice.nullSay(text);
  }

  // ------------------------------------------------------------ robots

  private release(key: string, materialize: boolean, skip: ReadonlySet<string> = new Set()): void {
    if (this.released.has(key)) return;
    this.released.add(key);
    const p = this.o.player;
    for (const g of this.m.groups) {
      if (g.release !== key) continue;
      const alarm = key !== "start";
      g.spawns.forEach((s: Spawn, i) => {
        if (skip.has(s.id)) return;
        const spawn = () => {
          if (this.phase === "won" || this.phase === "lost") return;
          this.o.robots.spawn(s, { materialize, alert: alarm, group: g.id, hp: s.kind === "titan" ? 650 + this.m.band * 110 : undefined });
        };
        if (materialize) setTimeout(spawn, i * 260);
        else spawn();
      });
    }
    if (key !== "start" && materialize) this.o.world.noise(p.pos.x, p.pos.z, 60, "alarm");
  }

  private onRobotKilled(r: Robot, by: HitBy): void {
    if (this.phase !== "play" && this.phase !== "intro") return;
    const w = this.o.world;
    this.pendingKills.push(r.id);
    if (by !== "emp") this.o.crowd.cheerKill(r.pos.x, r.pos.z);
    // Combo counter and the hero's quips.
    const t = w.time;
    this.combo = t - this.combo.at < 3 ? { n: this.combo.n + 1, at: t } : { n: 1, at: t };
    this.recentKills = [...this.recentKills.filter((x) => t - x < 1.6), t];
    w.sound.killConfirm(this.combo.n);
    if (r.kind === "titan") {
      this.killNow = true;
      const vr = this.vaults.find((x) => x.v.guard === r.id);
      if (vr && vr.state === "locked") { vr.state = "open"; vr.lobby.setState("open"); }
      this.notice("TITAN GIRA! Vault ka lock toot gaya. Core uthao!", "good");
      w.fx.word(r.pos.clone().setY(7), "TITAN DOWN!", "#ff6ad8", 2);
      this.quip("titan", 1, true);
      this.say(["Mera Titan! Yeh namumkin hai!", "Titan... offline?!"], true);
      return;
    }
    if (this.recentKills.length >= 2) this.quip("multi", 0.9);
    else if (by === "slap") this.quip("slap", 0.8);
    else if (by === "blade") this.quip("blade", 0.5);
    else if (by === "bomb") this.quip("bomb", 0.6);
    else if (by === "scatter") this.quip("scatter", 0.4);
    else if (by === "car") this.quip("car", 0.4);
    else if (by === "gun") this.quip("gun", 0.35);
    if (Math.random() < 0.3) this.say(this.voice.onKill);
  }

  private onTruckDestroyed(): void {
    const c = this.m.courier;
    if (!c || (this.phase !== "play" && this.phase !== "intro")) return;
    this.pendingKills.push(c.id);
    this.killNow = true;
    this.notice(`${c.name} tabaah! Uska DATA CORE utha lo!`, "good");
    this.quip("truck", 1, true);
    this.say(["Mera truck! Mera data!", "Nahi! Woh core mera hai!"], true);
  }

  private async pickupTruckCore(): Promise<void> {
    const { world: w, bridge, player } = this.o;
    const t = this.truck!;
    if (this.truckBusy || t.collected) return;
    this.truckBusy = true;
    try {
      const r = await bridge.pickup(this.m.courier!.id);
      this.applySync(r);
      t.collect();
      this.carried.push(this.m.courier!.id);
      this.syncOrbit();
      w.fx.dataBurst(player.pos.clone().setY(1.4));
      w.sound.pickup();
      const left = this.coresTotal - this.carried.length;
      this.notice(`TRUCK KA CORE mila! +${r.points}`, "good");
      this.notice(left ? `${left} core aur baaki.` : "Saare cores mil gaye! Ab uplink tower pe jao!", "info");
    } catch (err) {
      // Usually the kill report hasn't landed yet: try again in a moment.
      if (!(err instanceof BridgeError && err.code === "TRUCK_RUNNING")) this.notice(err instanceof Error ? err.message : "Core uthane mein dikkat.", "bad");
      this.killNow = true;
      await new Promise((res) => setTimeout(res, 1200));
    } finally {
      this.truckBusy = false;
    }
  }

  private async collectShard(it: NonNullable<ReturnType<Shards["near"]>>): Promise<void> {
    const w = this.o.world;
    it.busy = true;
    try {
      const r = await this.o.bridge.shard(it.s.id);
      this.applySync(r);
      it.taken = true;
      it.mesh.visible = false;
      w.sound.shard();
      w.fx.dataBurst(new THREE.Vector3(it.s.x, 1.3, it.s.z));
      const n = this.shards!.count;
      this.notice(r.allShards ? `SAARE SHARDS! Bonus +${r.points}` : `DATA SHARD +${r.points} (${n.got}/${n.total})`, "good");
      if (r.allShards) this.quip("shard", 1, true);
    } catch (err) {
      this.notice(err instanceof Error ? err.message : "Shard nahi mila.", "bad");
      await new Promise((res) => setTimeout(res, 2000));
    } finally {
      it.busy = false;
    }
  }

  private flushKills(dt: number): void {
    this.killTimer -= dt;
    this.killBackoff = Math.max(0, this.killBackoff - dt);
    if (!this.pendingKills.length || this.killBackoff > 0 || (this.killTimer > 0 && !this.killNow)) return;
    this.killNow = false;
    this.killTimer = 0.7;
    const batch = this.pendingKills.splice(0, 10);
    this.o.bridge.kills(batch).then((r) => {
      this.applySync(r.sync);
      const pts = r.killed.reduce((n, k) => n + k.points, 0);
      if (pts > 0) this.notice(`+${pts} robot${r.killed.length > 1 ? ` x${r.killed.length}` : ""} scrap`, "good");
    }).catch((err: unknown) => {
      if (err instanceof BridgeError && !err.retryable) return;
      this.pendingKills.unshift(...batch);
      this.killBackoff = 2;
    });
  }

  private applySync(s: Sync): void {
    this.score = s.score;
    this.lives = s.lives;
    if (s.status === "failed" && this.phase === "play") this.lose();
  }

  // ------------------------------------------------------------ hacking

  private async startHack(vr: VaultRt): Promise<void> {
    const { player, world: w, bridge } = this.o;
    if (this.busy) return;
    this.busy = true;
    this.hacking = vr.v.id;
    player.frozen = true;
    player.hacking = true;
    player.shielded = true;
    w.sound.hackBeep();
    let req: HackRequest;
    try {
      req = await bridge.hackStart(vr.v.id);
    } catch (err) {
      this.endHack();
      const msg = err instanceof Error ? err.message : "Hack shuru nahi hua.";
      this.notice(msg, "bad");
      if (err instanceof BridgeError && err.code === "BRUTE_FORCING") this.refreshBrute(vr);
      return;
    }
    if (this.phase !== "play") { this.endHack(); return; }
    this.slowmo = true;
    try {
      const verdict = await bridge.runHack(req);
      this.applySync(verdict.sync);
      vr.attemptsLeft = verdict.attemptsLeft;
      if (verdict.correct) {
        vr.state = "open";
        vr.lobby.setState("open");
        w.sound.hackOk();
        this.notice(`Hack successful! +${verdict.points}`, "good");
        w.fx.dataBurst(vr.lobby.corePos(this.tmp).clone());
      } else {
        w.sound.hackFail();
        w.sound.alarm();
        this.say(this.voice.onAlarm, true);
        this.notice(verdict.timeout ? "Time khatam! ALARM baj gaya!" : "Galat! ALARM baj gaya! Robots aa rahe hain!", "bad");
        this.release(`alarm:${vr.v.id}:${req.attempt + 1}`, true);
        if (verdict.bruteUntil) {
          vr.bruteUntil = verdict.bruteUntil;
          vr.state = "brute";
          vr.lobby.setState("brute", 0);
          this.notice(`Vault brute-force ho raha hai: ${this.m.bruteForceSec} second bachao!`, "info");
        } else {
          this.notice(`Aur ${verdict.attemptsLeft} try baaki. Terminal pe phir se E dabao.`, "info");
        }
      }
    } catch (err) {
      this.notice(err instanceof Error ? err.message : "Hack ka jawab server tak nahi pahuncha.", "bad");
    } finally {
      this.endHack();
    }
  }

  private endHack(): void {
    const p = this.o.player;
    this.slowmo = false;
    this.hacking = null;
    this.busy = false;
    p.frozen = false;
    p.hacking = false;
    p.shieldUntil = this.o.world.time + 1.5;
  }

  private refreshBrute(vr: VaultRt): void {
    if (!vr.bruteUntil) vr.bruteUntil = this.serverNow() + this.m.bruteForceSec * 1000;
    vr.state = "brute";
    vr.lobby.setState("brute", 0);
  }

  private async pickup(vr: VaultRt): Promise<void> {
    const { world: w, bridge, player } = this.o;
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await bridge.pickup(vr.v.id);
      this.applySync(r);
      vr.state = "taken";
      vr.lobby.setState("taken");
      this.carried.push(vr.v.id);
      this.syncOrbit();
      w.fx.dataBurst(player.pos.clone().setY(1.4));
      w.sound.pickup();
      this.checkpoint = this.outside(vr.v);
      const left = this.coresTotal - this.carried.length;
      this.notice(`DATA CORE mila! +${r.points}`, "good");
      this.notice(left ? `${left} core aur baaki.` : "Saare cores mil gaye! Ab uplink tower pe jao!", "info");
      this.say(this.voice.onCore);
    } catch (err) {
      this.notice(err instanceof Error ? err.message : "Core uthane mein dikkat.", "bad");
      await new Promise((res) => setTimeout(res, 1500));
    } finally {
      this.busy = false;
    }
  }

  /** Little glowing cores orbiting the player, one per core carried. */
  private syncOrbit(): void {
    while (this.orbit.length < this.carried.length) {
      const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 2.6, 1.6), toneMapped: false }));
      this.o.world.scene.add(mesh);
      this.orbit.push(mesh);
    }
  }

  // ------------------------------------------------------------ lives

  private onPlayerDown(): void {
    if (this.phase !== "play") return;
    this.downs += 1;
    this.lives = Math.max(0, this.lives - 1);
    this.say(this.voice.onDown, true);
    this.downQueue = this.downs;
    this.sendDown();
    if (this.lives <= 0) {
      this.notice("Saari lives khatam!", "bad");
      this.lose();
    } else {
      this.notice(`SYSTEM DOWN! ${this.lives} ${this.lives === 1 ? "life" : "lives"} baaki. Reboot ho rahe ho...`, "bad");
      this.respawnAt = this.o.world.time + 3.5;
    }
  }

  private sendDown(): void {
    const n = this.downQueue;
    if (n === null) return;
    this.o.bridge.down(n).then((s) => {
      if (this.downQueue === n) this.downQueue = null;
      this.applySync(s);
    }).catch(() => setTimeout(() => this.sendDown(), 2000));
  }

  // ------------------------------------------------------------ uplink

  private async uplinkStart(): Promise<void> {
    if (this.uplinkBusy) return;
    this.uplinkBusy = true;
    const w = this.o.world;
    try {
      const s = await this.o.bridge.uplinkStart();
      this.applySync(s);
      this.uplinkStarted = true;
      this.checkpoint = { x: this.m.uplink.x + this.m.uplink.radius * 0.5, z: this.m.uplink.z, heading: 0 };
      this.o.city.setUplinkBeacon(this.m.uplink.x, this.m.uplink.z, true);
      w.sound.alarm();
      this.notice("UPLOAD SHURU! Zone mein raho, robots aa rahe hain!", "info");
      this.say(["Upload? Main hone nahi dunga!", "Saare robots, uplink pe chalo!"], true);
      this.release("uplink:1", true);
    } catch (err) {
      this.notice(err instanceof Error ? err.message : "Upload shuru nahi hua.", "bad");
      this.uplinkRetryAt = w.time + 2;
    } finally {
      this.uplinkBusy = false;
    }
  }

  private async uplinkDone(): Promise<void> {
    if (this.uplinkBusy) return;
    this.uplinkBusy = true;
    try {
      const s = await this.o.bridge.uplinkDone();
      this.applySync(s);
      this.win();
    } catch (err) {
      // Usually "upload still running" because of clock drift: try again shortly.
      this.uplinkRetryAt = this.o.world.time + 1;
      if (!(err instanceof BridgeError && err.code === "UPLOAD_RUNNING")) this.notice(err instanceof Error ? err.message : "Upload confirm nahi hua.", "bad");
    } finally {
      this.uplinkBusy = false;
    }
  }

  // ------------------------------------------------------------ win / lose

  private win(): void {
    if (this.phase === "won") return;
    this.phase = "won";
    this.winT = 0;
    const w = this.o.world;
    w.sound.win();
    w.sound.stopMusic();
    this.say(this.voice.onWin, true);
    this.notice("NEON CITY ONLINE! Mission complete!", "good");
    this.o.robots.passive = true;
    this.o.crowd.startCheering();
    this.o.city.setUplinkBeacon(this.m.uplink.x, this.m.uplink.z, true, new THREE.Color(0.6, 1.6, 2));
  }

  lose(): void {
    if (this.phase === "lost" || this.phase === "won") return;
    this.phase = "lost";
    this.loseT = 0;
    const w = this.o.world;
    w.sound.lose();
    w.sound.stopMusic();
    this.say(this.voice.onLose, true);
    this.o.robots.passive = true;
  }

  begin(): void {
    if (this.phase !== "intro") return;
    this.phase = "play";
    const op = OP_INFO[this.m.op ?? "classic"];
    if (this.o.firstTime) {
      this.notice("WASD se chalo, Shift se daudo, mouse se nishana, left click se fire!", "info");
      setTimeout(() => this.notice("1-4 se weapon badlo · V = thappad · C = roll · F = gaadi/heli/metro", "info"), 3500);
      setTimeout(() => this.notice("Q = EMP blast. M = bada map.", "info"), 7000);
    } else {
      this.notice(`${op.title.toUpperCase()}! ${op.blurb}`, "info");
    }
    if (this.m.courier) setTimeout(() => this.notice(`${this.m.courier!.name} shehar mein ghoom raha hai. Map pe magenta truck dekho!`, "info"), 9000);
  }

  // ------------------------------------------------------------ frame

  update(dt: number, input: Input, controls: boolean): void {
    const { world: w, player, robots, city } = this.o;
    const now = this.serverNow();
    for (const vr of this.vaults) vr.lobby.update(w.time, dt);
    this.fences.update(w.time, dt);
    this.medkits.update(w.time);
    this.shards?.update(w.time);
    this.truck?.update(dt, this.phase === "play" ? this.missionSec() : this.phase === "intro" ? 0 : this.missionSec(), this.phase === "play" ? player : null);

    // Orbiting cores.
    this.orbit.forEach((m, i) => {
      const a = w.time * 2.2 + (i / Math.max(1, this.orbit.length)) * Math.PI * 2;
      const c = player.car ? player.car.pos : player.pos;
      m.position.set(c.x + Math.cos(a) * 0.9, (player.car ? 1.8 : 1.3) + Math.sin(w.time * 3 + i) * 0.15, c.z + Math.sin(a) * 0.9);
      m.rotation.y += dt * 3;
      m.visible = player.alive && this.phase !== "won";
    });

    if (this.phase === "won") {
      this.winT += dt;
      this.healR = Math.min(1200, this.healR + dt * (60 + this.healR * 0.9));
      city.uniforms.uHealCenter.value.set(this.m.uplink.x, this.m.uplink.z);
      city.uniforms.uHealRadius.value = this.healR;
      city.uniforms.uCorrupt.value = Math.max(0, 1 - this.winT / 3);
      // NULL's robots shut down one after another.
      if (Math.random() < dt * 8) {
        const r = robots.aliveList()[0];
        if (r) robots.damage(r, 9999, null, "emp");
      }
      if (this.winT > 6.5 && this.winT - dt <= 6.5) this.o.onFinished("won");
      this.prompt = null;
      this.objective = "NEON CITY ONLINE!";
      return;
    }
    if (this.phase === "lost") {
      this.loseT += dt;
      city.uniforms.uCorrupt.value = Math.min(2.5, city.uniforms.uCorrupt.value + dt);
      if (this.loseT > 3.5 && this.loseT - dt <= 3.5) this.o.onFinished("lost");
      this.prompt = null;
      return;
    }
    if (this.phase !== "play") return;

    const left = this.timeLeft();
    if (left !== null && left <= 0) { this.notice("Time khatam!", "bad"); this.lose(); return; }

    this.flushKills(dt);

    // Respawn after going down.
    if (!player.alive && this.respawnAt > 0 && w.time >= this.respawnAt) {
      this.respawnAt = -1;
      const cp = this.checkpoint;
      player.spawn(cp.x, cp.z, cp.heading);
      w.fx.materialize(new THREE.Vector3(cp.x, 0, cp.z), new THREE.Color(0.3, 1, 0.6));
      w.sound.pickup();
    }

    // Ramming the data truck, grabbing its core, bonus shards.
    const truck = this.truck;
    if (truck && player.car && player.car.driver === "player") {
      const dmg = truck.ram(player.car.pos, player.car.vel);
      if (dmg > 0) { player.car.takeDamage(dmg, truck.pos); player.car.vel.multiplyScalar(0.4); }
    }
    if (truck && !truck.alive && truck.dropped && !truck.collected && player.alive && !player.heli && !player.train) {
      if (Math.hypot(player.pos.x - truck.dropped.x, player.pos.z - truck.dropped.z) < (player.car ? 5 : 3)) void this.pickupTruckCore();
    }
    if (this.shards && player.alive && !player.train && player.pos.y < 3) {
      const it = this.shards.near(player.pos, player.car ? 3.6 : 2.2);
      if (it) void this.collectShard(it);
    }

    // Repair kits.
    const onGround = player.alive && !player.car && !player.heli && !player.train;
    if (onGround && player.health < 100 && this.medkits.tryPickup(player.pos, w.time)) {
      player.health = Math.min(100, player.health + 45);
      w.sound.pickup();
      this.notice("Repair kit: +45 health", "good");
    }

    this.prompt = null;
    this.inLobby = false;
    const foot = player.alive && !player.car && !player.heli && !player.train;
    for (const vr of this.vaults) {
      if (vr.state === "brute" && vr.bruteUntil) {
        const total = this.m.bruteForceSec * 1000;
        const prog = Math.min(1, 1 - (vr.bruteUntil - now) / total);
        vr.lobby.setState("brute", prog);
        if (now >= vr.bruteUntil) { vr.state = "open"; vr.lobby.setState("open"); w.sound.hackOk(); this.notice("Brute-force poora! Core uthao!", "good"); }
      }
      const b = getCity().buildingById.get(vr.v.buildingId)!;
      if (Math.abs(player.pos.x - b.x) < b.w / 2 && Math.abs(player.pos.z - b.z) < b.d / 2) this.inLobby = true;
      if (!foot || this.busy) continue;
      const dT = Math.hypot(player.pos.x - vr.v.terminal.x, player.pos.z - vr.v.terminal.z);
      const dC = Math.hypot(player.pos.x - vr.v.core.x, player.pos.z - vr.v.core.z);
      if (vr.v.lock === "titan" && vr.state === "locked") {
        if (dT < 3 || dC < 4) this.prompt = "Is vault ka lock TITAN ke paas hai: pehle use giraao!";
        continue;
      }
      if (vr.state === "locked" && dT < 2.6) {
        this.prompt = `E · ${HACK_NAMES[vr.v.hackType]} hack karo`;
        if (controls && input.hit("KeyE")) void this.startHack(vr);
      } else if (vr.state === "brute" && dT < 2.6) {
        this.prompt = "Brute-force chal raha hai... ruko!";
      } else if (vr.state === "open" && dC < 2.4) {
        void this.pickup(vr);
      } else if (vr.state === "open" && dC < 6) {
        this.prompt = "Core ke paas jao";
      }
    }

    // Ride prompts (helicopter, metro), then cars.
    if (!this.prompt && player.ridePrompt) this.prompt = player.ridePrompt;
    if (!this.prompt && foot) {
      const car = this.o.vehicles.nearestEnterable(player.pos, 3.0);
      if (car) this.prompt = `F · ${car.v.name} chalao`;
    } else if (!this.prompt && player.car && Math.abs(player.car.speed) < 3) {
      this.prompt = "F · Gaadi se utro";
    }

    // Uplink.
    const all = this.carried.length >= this.coresTotal;
    const inside = Math.hypot(player.pos.x - this.m.uplink.x, player.pos.z - this.m.uplink.z) < this.m.uplink.radius && !player.train && player.pos.y < 6;
    if (all && !this.uplinkStarted && inside && player.alive && w.time >= this.uplinkRetryAt) void this.uplinkStart();
    if (this.uplinkStarted && player.alive && inside) {
      this.uplinkProgress = Math.min(this.m.uploadSec, this.uplinkProgress + dt);
      w.sound.uplinkTick(this.uplinkProgress / this.m.uploadSec);
      if (!this.wave2 && this.uplinkProgress > this.m.uploadSec * 0.4) { this.wave2 = true; this.release("uplink:2", true); }
      if (this.uplinkProgress >= this.m.uploadSec && w.time >= this.uplinkRetryAt) void this.uplinkDone();
    }
    this.uplink.set(this.uplinkProgress / this.m.uploadSec, all, inside);
    if (all && !this.uplinkStarted) city.setUplinkBeacon(this.m.uplink.x, this.m.uplink.z, true);

    // Objective + route.
    this.routeTimer -= dt;
    let target: Pt | null = null;
    if (!all) {
      const open = this.vaults.filter((x) => x.state !== "taken");
      let best: VaultRt | null = null, bd = Infinity;
      for (const vr of open) { const d = Math.hypot(vr.v.door.x - player.pos.x, vr.v.door.z - player.pos.z); if (d < bd) { bd = d; best = vr; } }
      // The data truck competes for "nearest objective" too.
      const tk = truck && !truck.collected ? (truck.alive ? truck.pos : truck.dropped) : null;
      const td = tk ? Math.hypot(tk.x - player.pos.x, tk.z - player.pos.z) : Infinity;
      if (tk && (td < bd || !best)) {
        target = { x: tk.x, z: tk.z };
        this.objective = truck!.alive ? `${this.m.courier!.name} ka peecha karo aur use todo!` : "Truck ka core uthao!";
      } else if (best) {
        const inThis = this.inLobby && bd < 30;
        const titan = best.v.lock === "titan" && best.state === "locked";
        const boss = titan ? this.o.robots.byId.get(best.v.guard!) : undefined;
        target = titan ? (boss?.alive ? { x: boss.pos.x, z: boss.pos.z } : best.v.door) : inThis ? (best.state === "locked" ? best.v.terminal : best.v.core) : best.v.door;
        this.objective = titan
          ? `TITAN ko giraao: ${best.v.name} ke bahar`
          : best.state === "locked"
            ? (inThis ? `Terminal pe E dabao: ${HACK_NAMES[best.v.hackType]}` : `Vault tak pahuncho: ${best.v.name}`)
            : best.state === "brute" ? "Brute-force chal raha hai! Robots se bacho." : `Core uthao: ${best.v.name}`;
      }
    } else if (this.uplinkStarted) {
      target = this.m.uplink;
      this.objective = inside ? `UPLOAD ${Math.floor((this.uplinkProgress / this.m.uploadSec) * 100)}%  ·  zone mein raho!` : "Upload ruka hai! Zone mein wapas jao!";
    } else {
      target = this.m.uplink;
      this.objective = `Cores ko ${this.m.uplink.name} tower tak le jao`;
    }
    if (target) {
      this.objectiveDist = Math.round(Math.hypot(target.x - player.pos.x, target.z - player.pos.z));
      if (this.routeTimer <= 0) { this.routeTimer = 0.5; this.route = this.computeRoute(player.pos, target); }
    } else this.objectiveDist = null;
  }

  /** Road route from a point to a target, avoiding barricades. */
  computeRoute(from: THREE.Vector3, to: Pt): Pt[] {
    if (Math.hypot(from.x - to.x, from.z - to.z) < 45) return [{ x: from.x, z: from.z }, to];
    const blocked = new Set(this.m.barricades.map((b) => b.edge));
    const city = getCity();
    let best: { nodes: number[]; total: number } | null = null;
    for (const a of accessNodes(from.x, from.z)) {
      for (const b of accessNodes(to.x, to.z)) {
        const p = shortestPath(a, b, blocked);
        if (!p) continue;
        const na = city.nodes[a], nb = city.nodes[b];
        const total = p.length + Math.hypot(from.x - na.x, from.z - na.z) + Math.hypot(to.x - nb.x, to.z - nb.z);
        if (!best || total < best.total) best = { nodes: p.nodes, total };
      }
    }
    if (!best) return [{ x: from.x, z: from.z }, to];
    return [{ x: from.x, z: from.z }, ...best.nodes.map((n) => ({ x: city.nodes[n].x, z: city.nodes[n].z })), to];
  }

  markers(): MapMarker[] {
    const out: MapMarker[] = [];
    for (const vr of this.vaults) out.push({ kind: vr.state === "taken" ? "vault-done" : vr.v.lock === "titan" && vr.state === "locked" ? "titan" : "vault", x: vr.v.door.x, z: vr.v.door.z, label: vr.v.name });
    const tk = this.truck;
    if (tk && !tk.collected) out.push({ kind: tk.alive ? "truck" : "core", x: tk.alive ? tk.pos.x : tk.dropped!.x, z: tk.alive ? tk.pos.z : tk.dropped!.z, label: this.m.courier!.name });
    for (const it of this.shards?.items ?? []) if (!it.taken) out.push({ kind: "shard", x: it.s.x, z: it.s.z });
    for (const h of this.o.rides?.helis ?? []) if (!h.occupied) out.push({ kind: "heli", x: h.pos.x, z: h.pos.z, label: "Helicopter" });
    for (const st of this.o.rides?.metro?.stations ?? []) out.push({ kind: "metro", x: st.pad.x, z: st.pad.z, label: st.name });
    out.push({ kind: "uplink", x: this.m.uplink.x, z: this.m.uplink.z, label: this.m.uplink.name });
    for (const b of this.m.barricades) out.push({ kind: "barricade", x: b.x, z: b.z });
    for (const f of this.fences.list) if (f.active) out.push({ kind: "fence", x: f.h.x, z: f.h.z });
    const p = this.o.player.pos;
    for (const r of this.o.robots.list) {
      if (!r.alive) continue;
      if (r.kind !== "titan" && Math.hypot(r.pos.x - p.x, r.pos.z - p.z) > 140) continue;
      out.push({ kind: r.kind === "turret" ? "turret" : r.kind === "titan" ? "titan" : "robot", x: r.pos.x, z: r.pos.z });
    }
    return out;
  }

  /** Big health bar for the Titan or the data truck when the player is close. */
  boss(): { name: string; hp: number; max: number } | null {
    const p = this.o.player.pos;
    for (const r of this.o.robots.list) {
      if (r.kind === "titan" && r.alive && Math.hypot(r.pos.x - p.x, r.pos.z - p.z) < 75) return { name: "TITAN", hp: Math.max(0, r.hp), max: r.maxHp };
    }
    const t = this.truck;
    if (t && t.alive && Math.hypot(t.pos.x - p.x, t.pos.z - p.z) < 70) return { name: this.m.courier!.name.toUpperCase(), hp: Math.max(0, t.hp), max: t.maxHp };
    return null;
  }

  /** Tracker list for the HUD: vaults, plus the data truck. */
  hudCores(): { id: string; name: string; state: "locked" | "open" | "taken" | "brute"; hackType: string }[] {
    const list = this.vaults.map((v) => ({ id: v.v.id, name: v.v.name, state: v.state, hackType: v.v.lock === "titan" ? "titan" : v.v.hackType }));
    const t = this.truck;
    if (t) list.push({ id: this.m.courier!.id, name: this.m.courier!.name, state: t.collected ? "taken" : t.alive ? "locked" : "open", hackType: "truck" });
    return list;
  }

  bruteProgress(): number | null {
    const vr = this.vaults.find((x) => x.state === "brute" && x.bruteUntil);
    if (!vr || !vr.bruteUntil) return null;
    return Math.min(1, 1 - (vr.bruteUntil - this.serverNow()) / (this.m.bruteForceSec * 1000));
  }
}
