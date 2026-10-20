"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { avatarHue } from "@/components/Avatar";
import { HackOverlay, type Answer } from "@/components/game/HackOverlay";
import { Hud } from "@/components/game/Hud";
import { cityImage, drawMarker, toMap, MAP_PX } from "@/components/game/mapDraw";
import { BigMap, Minimap } from "@/components/game/Minimap";
import { Results } from "@/components/game/Results";
import type { Game } from "@/game/Game";
import { BridgeError, type HackRequest, type HackVerdict, type HudState, type MissionBridge, type QualityLevel, type Sync } from "@/game/types";
import { api, ApiError, getMe, type Me, type Mission } from "@/lib/client/api";
import "../play.css";

export default function PlayPage() {
  const { id } = useParams<{ id: string }>();
  return <PlayScreen key={id} id={id} />;
}

type Phase = "loading" | "briefing" | "playing" | "finishing" | "results" | "error";
type HackState = { req: HackRequest; verdict: (HackVerdict & { error?: string }) | null };

const HACK_INFO = [
  { k: "glitch", t: "Data Stream Breach", d: "Pattern todne wala node dhoondo" },
  { k: "power", t: "Firewall Bypass", d: "Circuit ghuma ke bijli lock tak le jao" },
  { k: "imposter", t: "Identity Scan", d: "Nakli security bot pakdo" },
];

function PlayScreen({ id }: { id: string }) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const hudRef = useRef<HudState | null>(null);
  const offsetRef = useRef(0);
  const hackResolve = useRef<((v: HackVerdict & { sync: Sync }) => void) | null>(null);
  const hackSync = useRef<Sync | null>(null);
  const finishedRef = useRef(false);
  const phaseRef = useRef<Phase>("loading");
  const [phase, setPhaseState] = useState<Phase>("loading");
  const [mission, setMission] = useState<Mission | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hud, setHud] = useState<HudState | null>(null);
  const [hack, setHack] = useState<HackState | null>(null);
  const [paused, setPaused] = useState(false);
  const [locked, setLocked] = useState(false);
  const [bigMap, setBigMap] = useState(false);
  const [ready, setReady] = useState(false);
  const [starting, setStarting] = useState(false);
  const [nextBusy, setNextBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [quality, setQuality] = useState<QualityLevel>("medium");
  const [aiStory, setAiStory] = useState<"idle" | "loading" | "done">("idle");

  const setPhase = (p: Phase) => { phaseRef.current = p; setPhaseState(p); };
  const serverNow = useCallback(() => Date.now() + offsetRef.current, []);

  const trackClock = (m: Mission) => { offsetRef.current = m.serverNow - Date.now(); };

  // ------------------------------------------------------------ server bridge

  const post = useCallback(async (body: unknown): Promise<Mission> => {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const m = await api<Mission>(`/api/missions/${id}/event`, { method: "POST", json: body, timeoutMs: 9000 });
        trackClock(m);
        return m;
      } catch (e) {
        lastErr = e;
        if (!(e instanceof ApiError) || (e.status !== 0 && e.status < 500)) break;
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    if (lastErr instanceof ApiError) throw new BridgeError(lastErr.code, lastErr.message, lastErr.status === 0 || lastErr.status >= 500);
    throw lastErr;
  }, [id]);

  const sync = (m: Mission): Sync => ({ score: m.progress.score, lives: m.progress.lives, status: m.status });

  const bridge: MissionBridge = useMemo(() => ({
    clockOffset: () => offsetRef.current,
    hackStart: async (vault) => {
      const m = await post({ type: "hack_start", vault });
      const h = m.outcome?.hack;
      if (!h) throw new BridgeError("NO_HACK", "Terminal ne jawab nahi diya. Dobara E dabao.");
      return { ...h, type: h.type as HackRequest["type"] };
    },
    runHack: (req) => new Promise((resolve) => {
      hackResolve.current = resolve;
      hackSync.current = null;
      setHack({ req, verdict: null });
      gameRef.current?.releaseLock();
    }),
    pickup: async (vault) => { const m = await post({ type: "pickup", vault }); return { ...sync(m), points: m.outcome?.points ?? 0 }; },
    kills: async (ids) => { const m = await post({ type: "kill", robots: ids }); return { killed: m.outcome?.killed ?? [], sync: sync(m) }; },
    down: async (n) => sync(await post({ type: "down", n })),
    uplinkStart: async () => sync(await post({ type: "uplink_start" })),
    uplinkDone: async () => sync(await post({ type: "uplink_done" })),
  }), [post]);

  // ------------------------------------------------------------ load

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [m, who] = await Promise.all([api<Mission>(`/api/missions/${id}`), getMe()]);
        if (cancelled) return;
        trackClock(m);
        setMission(m);
        setMe(who);
        if (m.result) { setPhase("results"); return; }
        if (m.status !== "briefing" && m.status !== "active") { setError("Ye mission ab available nahi hai."); setPhase("error"); return; }
        setPhase(m.status === "briefing" ? "briefing" : "playing");
        if (m.status === "briefing" && m.narrative.source === "fallback") {
          setAiStory("loading");
          api<Mission["narrative"]>(`/api/missions/${id}/briefing`, { timeoutMs: 9000 })
            .then((n) => { if (!cancelled) setMission((prev) => (prev ? { ...prev, narrative: n } : prev)); })
            .catch(() => {})
            .finally(() => { if (!cancelled) setAiStory("done"); });
        }
        await bootGame(m, who);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) { router.replace("/login"); return; }
        setError(e instanceof Error ? e.message : "Mission load nahi hua.");
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
      gameRef.current?.dispose();
      gameRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function bootGame(m: Mission, who: Me) {
    const [{ Game }, { ensureFonts }, { savedQuality }] = await Promise.all([import("@/game/Game"), import("@/game/fonts"), import("@/game/Quality")]);
    await ensureFonts();
    if (!canvasRef.current) return;
    const g = new Game({
      canvas: canvasRef.current,
      mission: m.mission,
      bridge,
      progress: m.progress,
      voice: m.narrative.voice,
      hue: avatarHue(who.user.avatarId),
      firstTime: who.skill.attempts === 0,
      startAt: m.status === "active" ? m.startedAt : null,
      deadline: m.deadline,
      timeLimit: m.timeLimitSec,
      quality: savedQuality() ?? "auto",
      callbacks: {
        onHud: (h) => { hudRef.current = h; setHud(h); },
        onFinished: () => void finish(),
        onPointerLockChange: (l) => {
          setLocked(l);
          if (!l && phaseRef.current === "playing" && !hackResolve.current && !finishedRef.current) {
            gameRef.current?.setPaused(true);
            setPaused(true);
          }
        },
        onError: (msg) => setError(msg),
      },
    });
    gameRef.current = g;
    setMuted(g.sound.muted);
    await g.ready;
    setQuality(g.quality);
    setReady(true);
  }

  async function finish() {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setPhase("finishing");
    gameRef.current?.releaseLock();
    for (let i = 0; i < 14; i++) {
      try {
        const m = await api<Mission>(`/api/missions/${id}`);
        if (m.result) { setMission(m); setPhase("results"); return; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    setError("Result abhi server se nahi aaya. Hub se dobara check karo.");
    setPhase("error");
  }

  // ------------------------------------------------------------ actions

  async function begin() {
    if (!gameRef.current || starting) return;
    setStarting(true);
    gameRef.current.requestLock();
    try {
      const m = await api<Mission>(`/api/missions/${id}/begin`, { method: "POST", json: {} });
      trackClock(m);
      setMission(m);
      gameRef.current.setTiming(m.startedAt!, m.deadline);
      setPhase("playing");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mission start nahi hua.");
    } finally {
      setStarting(false);
    }
  }

  function resume() {
    gameRef.current?.requestLock();
    gameRef.current?.setPaused(false);
    setPaused(false);
  }

  async function quit() {
    if (!confirm("Mission chhod doge? Ab tak ke points save honge, par clear bonus nahi milega.")) return;
    try {
      const m = await api<Mission>(`/api/missions/${id}/abort`, { method: "POST", json: {} });
      finishedRef.current = true;
      gameRef.current?.setPaused(true);
      setMission(m);
      setPaused(false);
      setPhase("results");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nahi hua.");
    }
  }

  async function nextMission() {
    setNextBusy(true);
    try {
      const m = await api<Mission>("/api/missions/start", { method: "POST", json: { mode: "personal" } });
      router.push(`/play/${m.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Naya mission nahi bana.");
      setNextBusy(false);
    }
  }

  const answerHack = useCallback(async (pick: Answer) => {
    const h = hack;
    if (!h) return;
    gameRef.current?.requestLock();
    try {
      const m = await post({ type: "hack_answer", vault: h.req.vault, attempt: h.req.attempt, pick });
      const j = m.outcome?.judge;
      hackSync.current = sync(m);
      if (!j) throw new Error("Server ne hack ka result nahi bheja.");
      setHack({ req: h.req, verdict: { correct: j.correct, timeout: j.timeout, points: j.points, explain: j.explain, reveal: j.reveal, attemptsLeft: j.attemptsLeft, bruteUntil: j.bruteUntil } });
    } catch (e) {
      setHack({ req: h.req, verdict: { correct: false, timeout: false, points: 0, explain: "", reveal: null, attemptsLeft: 0, bruteUntil: null, error: e instanceof Error ? e.message : "Connection error" } });
    }
  }, [hack, post]);

  const hackDone = useCallback(() => {
    const h = hack;
    const resolve = hackResolve.current;
    hackResolve.current = null;
    setHack(null);
    if (!h || !resolve) return;
    const v = h.verdict ?? { correct: false, timeout: true, points: 0, explain: "", reveal: null, attemptsLeft: 0, bruteUntil: null };
    resolve({ ...v, sync: hackSync.current ?? { score: hudRef.current?.score ?? 0, lives: hudRef.current?.lives ?? 3, status: "active" } });
  }, [hack]);

  // Keyboard: map, pause.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phaseRef.current !== "playing" || hack) return;
      if (e.code === "KeyM" || e.code === "Tab") { e.preventDefault(); setBigMap((b) => !b); }
      if (e.code === "Escape" && paused) resume();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hack, paused]);

  // Debug hooks for automated end-to-end checks (only when explicitly enabled at build time).
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_GP_DEBUG !== "1") return;
    (window as unknown as { __gp: unknown }).__gp = { game: () => gameRef.current, hud: () => hudRef.current, hack: () => hack, answer: (p: Answer) => answerHack(p), phase: () => phaseRef.current };
  }, [hack, answerHack]);

  const pose = useCallback(() => gameRef.current?.pose() ?? null, []);
  const vaultBuildings = useMemo(() => mission?.mission.vaults.map((v) => v.buildingId) ?? [], [mission?.mission]);
  const minimap = useMemo(() => <Minimap hudRef={hudRef} pose={pose} vaultBuildings={vaultBuildings} />, [pose, vaultBuildings]);

  // ------------------------------------------------------------ render

  const playing = phase === "playing";
  const showClick = playing && ready && !locked && !paused && !hack && hud?.mode !== "won" && hud?.mode !== "lost";
  const countdown = hud?.mode === "intro" && mission?.startedAt ? Math.ceil((mission.startedAt - serverNow()) / 1000) : null;

  return (
    <div className="play-root">
      <canvas ref={canvasRef} className="play-canvas" onClick={() => { if (playing && !paused && !hack) gameRef.current?.requestLock(); }} />
      {(phase === "loading" || (!ready && phase !== "error" && phase !== "results")) && (
        <div className="play-loading">
          <div className="spinner" />
          <div className="mono">NEON CITY LOAD HO RAHI HAI...</div>
          <div className="muted" style={{ fontSize: 14 }}>Robots, gaadiyan aur buildings ready ho rahe hain</div>
        </div>
      )}

      {phase === "briefing" && mission && <Briefing mission={mission} me={me} ready={ready} starting={starting} aiStory={aiStory} onStart={begin} />}

      {playing && hud && hud.mode !== "intro" && <Hud hud={hud} title={mission?.narrative.title ?? "Mission"} minimap={minimap} />}
      {playing && countdown !== null && countdown > 0 && <div className="countdown" key={countdown}>{countdown}</div>}
      {playing && hud && hud.mode !== "intro" && hud.timeLeft !== null && hud.timeLeft > hud.timeLimit - 1.6 && <div className="go-banner">GO!</div>}
      {playing && hud?.mode === "dead" && (
        <div className="downed"><div className="glitch" data-text="SYSTEM DOWN">SYSTEM DOWN</div><p>{hud.lives > 0 ? `Reboot ho rahe ho... ${hud.lives} ${hud.lives === 1 ? "life" : "lives"} baaki` : "Koi life nahi bachi"}</p></div>
      )}
      {playing && hud?.mode === "won" && <div className="win-banner"><div className="glitch" data-text="CITY ONLINE">CITY ONLINE</div><p>NULL ka system crash ho raha hai!</p></div>}
      {playing && hud?.mode === "lost" && <div className="downed"><div className="glitch" data-text="MISSION FAILED">MISSION FAILED</div></div>}
      {phase === "finishing" && <div className="play-loading"><div className="spinner" /><div className="mono">Score calculate ho raha hai...</div></div>}

      {showClick && (
        <button className="clicklock" onClick={() => gameRef.current?.requestLock()}>
          <b>CLICK KARO</b><span>mouse se nishana lagane ke liye · Esc = pause</span>
        </button>
      )}

      {bigMap && hud && playing && <BigMap hud={hud} vaultBuildings={vaultBuildings} onClose={() => setBigMap(false)} />}

      {hack && <HackOverlay req={hack.req} serverNow={serverNow} onAnswer={answerHack} verdict={hack.verdict} onDone={hackDone} />}

      {paused && playing && (
        <div className="pause-veil">
          <div className="panel pause">
            <div className="panel-title">Paused</div>
            <p className="amber" style={{ marginTop: 0 }}>⚠ Mission ka timer server pe chal raha hai, pause mein bhi!</p>
            <button className="btn primary big" onClick={resume}>▶ Resume</button>
            <div className="row wrap" style={{ gap: 8, marginTop: 16 }}>
              <span className="muted">Graphics:</span>
              {(["low", "medium", "high"] as QualityLevel[]).map((q) => (
                <button key={q} className={`btn small ${quality === q ? "primary" : ""}`} onClick={() => { gameRef.current?.setQuality(q); setQuality(q); }}>{q}</button>
              ))}
            </div>
            <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
              <span className="muted">Sound:</span>
              <button className="btn small cyan" onClick={() => { const m = !muted; gameRef.current?.setMuted(m); setMuted(m); }}>{muted ? "Off" : "On"}</button>
            </div>
            <Controls />
            <button className="btn red" style={{ marginTop: 16 }} onClick={quit}>Mission chhodo</button>
          </div>
        </div>
      )}

      {phase === "results" && mission?.result && <Results mission={mission} onNext={nextMission} busy={nextBusy} />}

      {error && (
        <div className="play-error">
          <div className="error-box">{error}</div>
          {phase === "error" ? <Link href="/hub" className="btn small">Hub</Link> : <button className="btn small" onClick={() => setError(null)}>OK</button>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- briefing

function MapPreview({ mission }: { mission: Mission }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const S = 300, dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = c.height = S * dpr;
    const g = c.getContext("2d")!;
    const k = (S * dpr) / MAP_PX;
    g.drawImage(cityImage(mission.mission.vaults.map((v) => v.buildingId)), 0, 0, S * dpr, S * dpr);
    const m = mission.mission;
    const put = (kind: Parameters<typeof drawMarker>[1]["kind"], x: number, z: number) => { const [px, pz] = toMap(x, z); drawMarker(g, { kind, x, z }, px * k, pz * k, 9 * dpr, kind === "vault"); };
    for (const b of m.barricades) put("barricade", b.x, b.z);
    for (const f of m.fences) put("fence", f.x, f.z);
    for (const v of m.vaults) put("vault", v.door.x, v.door.z);
    put("uplink", m.uplink.x, m.uplink.z);
    put("start", m.start.x, m.start.z);
  }, [mission]);
  return <canvas ref={ref} style={{ width: 300, height: 300, border: "1px solid var(--line)" }} aria-label="Mission map" />;
}

function Briefing({ mission, me, ready, starting, aiStory, onStart }: { mission: Mission; me: Me | null; ready: boolean; starting: boolean; aiStory: string; onStart: () => void }) {
  const n = mission.narrative;
  const m = mission.mission;
  const types = Array.from(new Set(m.vaults.map((v) => v.hackType)));
  const [touchOnly, setTouchOnly] = useState(false);
  useEffect(() => { setTouchOnly(window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(any-pointer: fine)").matches); }, []);
  return (
    <div className="briefing-veil">
      <div className="briefing panel rise">
        <div className="row wrap" style={{ gap: 10 }}>
          <span className="chip red">MISSION BRIEFING</span>
          <span className="chip">{mission.bandLabel} · Threat {mission.band}</span>
          {mission.event && <span className="chip cyan">EVENT {mission.event.code}</span>}
          {aiStory === "loading" && <span className="chip amber" style={{ animation: "pulse 1.2s infinite" }}>AI story aa rahi hai...</span>}
          {n.source !== "fallback" && <span className="chip green">AI story</span>}
        </div>
        <h1 className="glitch" data-text={n.title} style={{ fontSize: "clamp(30px, 4.5vw, 52px)", margin: "12px 0 6px" }}>{n.title}</h1>
        <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) 300px", gap: 22, alignItems: "start" }}>
          <div className="stack" style={{ gap: 12 }}>
            <p style={{ fontSize: 19, margin: 0 }}>{n.briefing}</p>
            <p className="null-quote">NULL: “{n.threat}”</p>
            {n.personal && <div className="ok-box">{n.personal}</div>}
            {touchOnly && <div className="error-box">Ye game keyboard + mouse ke liye bana hai. Laptop ya PC pe khelo.</div>}
            <div className="grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 10, textAlign: "center" }}>
              {[["Data cores", m.vaults.length], ["Time", `${Math.floor(m.timeLimitSec / 60)}:${String(m.timeLimitSec % 60).padStart(2, "0")}`], ["Lives", m.lives], ["Upload", `${m.uploadSec}s`]].map(([k, v]) => (
                <div key={k as string} className="stat"><b>{v}</b><span>{k}</span></div>
              ))}
            </div>
            <div>
              <div className="hud-label" style={{ marginBottom: 6 }}>Is mission ke hacks</div>
              <div className="row wrap" style={{ gap: 8 }}>
                {HACK_INFO.filter((h) => types.includes(h.k as never)).map((h) => <span key={h.k} className="chip cyan" title={h.d}>{h.t}: {h.d}</span>)}
              </div>
            </div>
            <Controls compact />
          </div>
          <div className="stack" style={{ gap: 8, alignItems: "center" }}>
            <MapPreview mission={mission} />
            <div className="row wrap muted" style={{ gap: 10, fontSize: 13, justifyContent: "center" }}>
              <span style={{ color: "#29d9ff" }}>◆ Vault</span><span style={{ color: "#3cff9a" }}>▲ Uplink</span><span style={{ color: "#a86bff" }}>■ Start</span><span style={{ color: "#ff4d4d" }}>✕ Barricade</span>
            </div>
          </div>
        </div>
        <div className="row wrap" style={{ marginTop: 18, gap: 14 }}>
          <button className="btn primary big" disabled={!ready || starting} onClick={onStart}>{!ready ? "City load ho rahi hai..." : starting ? "Starting..." : "▶ START MISSION"}</button>
          <Link href="/hub" className="btn cyan">Wapas hub</Link>
          {me && <span className="muted">Operator: <b className="green">{me.user.nickname}</b></span>}
        </div>
      </div>
    </div>
  );
}

function Controls({ compact = false }: { compact?: boolean }) {
  const rows: [string, string][] = [
    ["W A S D", "chalo / gaadi chalao"], ["Mouse", "nishana / camera"], ["Left click", "blaster fire"], ["Right click", "aim (zoom)"],
    ["Shift", "daudo / nitro"], ["Space", "jump / handbrake"], ["F", "gaadi mein baitho / utro"], ["E", "terminal hack"],
    ["Q", "EMP blast"], ["M / Tab", "bada map"], ["H", "horn"], ["Esc", "pause"],
  ];
  return (
    <div className="controls" style={{ gridTemplateColumns: compact ? "repeat(3, minmax(0, 1fr))" : "repeat(2, minmax(0, 1fr))" }}>
      {rows.map(([k, d]) => <div key={k}><span className="kbd">{k}</span> <span className="muted">{d}</span></div>)}
    </div>
  );
}
