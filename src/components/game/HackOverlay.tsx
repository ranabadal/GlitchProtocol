"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HackRequest, HackVerdict } from "@/game/types";
import { BASE, coreReached, powered, type Board, type TileType } from "@/lib/shared/power";

/*
 * The three original challenge types, now as 10-16 second holographic hacks:
 *   glitch   -> DATA STREAM BREACH  (Pattern Breaker): find the corrupted data node
 *   power    -> FIREWALL BYPASS     (System Override): rotate circuits to route power
 *   imposter -> IDENTITY SCAN       (Spot the Contradiction): find the fake security bot
 * The overlay only collects the answer; the server judges it.
 */

interface Tile { c: number; s: number; z: number; n: number | null }
interface Bot { body: number; eyes: number; ant: number; mouth: number; badge: number; pose: number }
interface PowerRound { rows: number; cols: number; types: TileType[]; rot: number[]; source: number; core: number }

const COLORS = ["#29d9ff", "#ff3aa8", "#ffd84a", "#3cff9a", "#ff8a29", "#a86bff"];
const META: Record<string, { title: string; sub: string; how: string; color: string }> = {
  glitch: { title: "DATA STREAM BREACH", sub: "Pattern Breaker", how: "Ek node pattern tod raha hai. Colour, shape, size ya number dekho aur us node pe click karo.", color: "#29d9ff" },
  power: { title: "FIREWALL BYPASS", sub: "System Override", how: "Tiles pe click karke ghumao. Bijli ko left ke source se right ke LOCK tak pahunchao.", color: "#ffb229" },
  imposter: { title: "IDENTITY SCAN", sub: "Spot the Contradiction", how: "Saare security bots ek jaise hone chahiye. Jo bot alag hai (nakli) use pakdo.", color: "#ff3aa8" },
};

/** null = time ran out (the server records it as a timeout). */
export type Answer = { index: number | null } | { rot: number[] | null } | null;

export function HackOverlay({ req, serverNow, onAnswer, verdict, onDone }: {
  req: HackRequest;
  serverNow: () => number;
  onAnswer: (pick: Answer) => void;
  verdict: (HackVerdict & { error?: string }) | null;
  onDone: () => void;
}) {
  const meta = META[req.type];
  const [left, setLeft] = useState(req.timeLimitMs);
  const [sent, setSent] = useState(false);
  const sentRef = useRef(false);
  const send = useCallback((a: Answer) => {
    if (sentRef.current) return;
    sentRef.current = true;
    setSent(true);
    onAnswer(a);
  }, [onAnswer]);

  // Countdown on the server's clock; at zero the empty answer goes in (counts as timeout).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const l = req.startedAt + req.timeLimitMs - serverNow();
      setLeft(l);
      if (l <= 0) { send(null); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [req, serverNow, send]);

  useEffect(() => {
    if (!verdict) return;
    const t = setTimeout(onDone, verdict.correct ? 1600 : 3200);
    return () => clearTimeout(t);
  }, [verdict, onDone]);

  const frac = Math.max(0, left / req.timeLimitMs);
  const reveal = (verdict?.reveal ?? null) as { answer?: number; path?: number[]; feature?: string } | null;
  return (
    <div className="hack-veil">
      <div className={`hack ${verdict ? (verdict.correct ? "ok" : "bad") : ""}`} style={{ "--hc": meta.color } as React.CSSProperties}>
        <div className="hack-head">
          <div>
            <div className="hack-title">{meta.title}</div>
            <div className="hack-sub">{meta.sub} · Attempt {req.attempt + 1}/3</div>
          </div>
          <div className={`hack-time ${left < 4000 ? "hot" : ""}`}>{Math.max(0, left / 1000).toFixed(1)}s</div>
        </div>
        <div className="hack-bar"><i style={{ width: `${frac * 100}%` }} /></div>
        <p className="hack-how">{meta.how}</p>
        <div className="hack-body">
          {req.type === "glitch" && <Glitch tiles={(req.round as { tiles: Tile[] }).tiles} disabled={sent} answer={reveal?.answer} onPick={(i) => send({ index: i })} />}
          {req.type === "imposter" && <Imposter round={req.round as { bots: Bot[]; cols: number }} disabled={sent} answer={reveal?.answer} onPick={(i) => send({ index: i })} />}
          {req.type === "power" && <Power round={req.round as PowerRound} disabled={sent} path={reveal?.path} onSubmit={(rot) => send({ rot })} />}
        </div>
        {verdict && (
          <div className="hack-result">
            <div className="hack-verdict">{verdict.error ? "CONNECTION ERROR" : verdict.correct ? "ACCESS GRANTED" : verdict.timeout ? "TIME OUT · ALARM!" : "ACCESS DENIED · ALARM!"}</div>
            {verdict.error ? <p>{verdict.error}</p> : <p>{verdict.correct ? `+${verdict.points} points! Core ka shield khul gaya.` : verdict.explain}</p>}
            {!verdict.correct && !verdict.error && <p className="muted">{verdict.bruteUntil ? "3 try khatam: vault ab brute-force hoga. Robots se bachte raho!" : `${verdict.attemptsLeft} try baaki.`}</p>}
            <button className="btn small" onClick={onDone}>Continue ▶</button>
          </div>
        )}
        {!verdict && sent && <div className="hack-result"><div className="spinner" /><p className="muted">Server check kar raha hai...</p></div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Data Stream Breach

function Shape({ s, size, color }: { s: number; size: number; color: string }) {
  const r = size;
  const glow = { filter: `drop-shadow(0 0 6px ${color})` };
  switch (s) {
    case 0: return <circle r={r} fill={color} style={glow} />;
    case 1: return <rect x={-r} y={-r} width={r * 2} height={r * 2} fill={color} style={glow} />;
    case 2: return <path d={`M0 ${-r * 1.1} L${r * 1.05} ${r * 0.8} L${-r * 1.05} ${r * 0.8} Z`} fill={color} style={glow} />;
    case 3: return <path d={`M0 ${-r * 1.2} L${r * 1.1} 0 L0 ${r * 1.2} L${-r * 1.1} 0 Z`} fill={color} style={glow} />;
    case 4: {
      const pts = Array.from({ length: 10 }, (_, i) => { const a = (i / 10) * Math.PI * 2 - Math.PI / 2; const rr = i % 2 ? r * 0.5 : r * 1.2; return `${Math.cos(a) * rr},${Math.sin(a) * rr}`; }).join(" ");
      return <polygon points={pts} fill={color} style={glow} />;
    }
    default: {
      const pts = Array.from({ length: 6 }, (_, i) => { const a = (i / 6) * Math.PI * 2; return `${Math.cos(a) * r * 1.1},${Math.sin(a) * r * 1.1}`; }).join(" ");
      return <polygon points={pts} fill={color} style={glow} />;
    }
  }
}

function Glitch({ tiles, disabled, answer, onPick }: { tiles: Tile[]; disabled: boolean; answer?: number; onPick: (i: number) => void }) {
  const [cur, setCur] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (disabled) return;
      if (e.key === "ArrowRight" || e.key === "d") setCur((c) => Math.min(tiles.length - 1, c + 1));
      else if (e.key === "ArrowLeft" || e.key === "a") setCur((c) => Math.max(0, c - 1));
      else if (e.key === "Enter" || e.key === " ") onPick(cur);
      else if (/^[1-9]$/.test(e.key) && Number(e.key) <= tiles.length) onPick(Number(e.key) - 1);
      else if (e.key === "0" && tiles.length >= 10) onPick(9);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cur, disabled, onPick, tiles.length]);
  const W = 92;
  return (
    <div className="glitch-row" style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, ${W}px))` }}>
      {tiles.map((t, i) => {
        const size = [11, 17, 24][t.z];
        return (
          <button key={i} className={`node ${cur === i ? "cur" : ""} ${answer === i ? "answer" : ""}`} disabled={disabled} onClick={() => onPick(i)} onMouseEnter={() => setCur(i)} aria-label={`Node ${i + 1}`}>
            <svg viewBox="-40 -40 80 80" width="100%">
              <polygon points="0,-38 33,-19 33,19 0,38 -33,19 -33,-19" fill="rgba(4,20,24,0.9)" stroke="currentColor" strokeWidth="2" />
              <Shape s={t.s} size={size} color={COLORS[t.c]} />
              {t.n !== null && <text y="5" textAnchor="middle" fontSize="20" fontWeight="800" fill="#021009" stroke="#eafff5" strokeWidth="0.6" style={{ fontFamily: "Oxanium Variable" }}>{t.n}</text>}
            </svg>
            <span className="node-i">{i + 1}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- Firewall Bypass

const SEG: Record<number, string> = { 1: "M32 32 L32 0", 2: "M32 32 L64 32", 4: "M32 32 L32 64", 8: "M32 32 L0 32" };

function Power({ round, disabled, path, onSubmit }: { round: PowerRound; disabled: boolean; path?: number[]; onSubmit: (rot: number[]) => void }) {
  const [rot, setRot] = useState(() => round.rot.slice());
  const [turns, setTurns] = useState(() => round.rot.slice());
  const [cur, setCur] = useState(round.source * round.cols);
  const board: Board = useMemo(() => ({ rows: round.rows, cols: round.cols, types: round.types, source: round.source, core: round.core }), [round]);
  const on = useMemo(() => powered(board, rot), [board, rot]);
  const done = useMemo(() => coreReached(board, rot), [board, rot]);
  const pathSet = useMemo(() => new Set(path ?? []), [path]);

  const turn = useCallback((i: number) => {
    if (disabled) return;
    setRot((r) => { const n = r.slice(); n[i] = (n[i] + 1) % 4; return n; });
    setTurns((t) => { const n = t.slice(); n[i] += 1; return n; });
  }, [disabled]);

  // Power reaches the lock: send automatically.
  useEffect(() => {
    if (done && !disabled) { const t = setTimeout(() => onSubmit(rot), 350); return () => clearTimeout(t); }
  }, [done, disabled, onSubmit, rot]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (disabled) return;
      const { rows, cols } = round;
      if (e.key === "ArrowRight") setCur((c) => (c % cols < cols - 1 ? c + 1 : c));
      else if (e.key === "ArrowLeft") setCur((c) => (c % cols > 0 ? c - 1 : c));
      else if (e.key === "ArrowDown") setCur((c) => (c + cols < rows * cols ? c + cols : c));
      else if (e.key === "ArrowUp") setCur((c) => (c - cols >= 0 ? c - cols : c));
      else if (e.key === " " || e.key === "r") { e.preventDefault(); turn(cur); }
      else if (e.key === "Enter") onSubmit(rot);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cur, disabled, onSubmit, rot, round, turn]);

  const S = 64;
  return (
    <div className="power">
      <div className="power-grid" style={{ gridTemplateColumns: `28px repeat(${round.cols}, ${S}px) 40px`, gridTemplateRows: `repeat(${round.rows}, ${S}px)` }}>
        {Array.from({ length: round.rows }).map((_, r) => (
          <div key={`s${r}`} className={`power-end ${r === round.source ? "src" : ""}`} style={{ gridRow: r + 1, gridColumn: 1 }}>{r === round.source ? "⚡" : ""}</div>
        ))}
        {round.types.map((type, i) => {
          const r = Math.floor(i / round.cols), c = i % round.cols;
          const lit = on.has(i);
          return (
            <button key={i} className={`ptile ${lit ? "lit" : ""} ${cur === i ? "cur" : ""} ${pathSet.has(i) ? "answer" : ""}`} style={{ gridRow: r + 1, gridColumn: c + 2 }} disabled={disabled} onClick={() => { setCur(i); turn(i); }} aria-label={`Tile ${r + 1}-${c + 1}`}>
              <svg viewBox="0 0 64 64" width={S} height={S} style={{ transform: `rotate(${turns[i] * 90}deg)` }}>
                {[1, 2, 4, 8].filter((b) => BASE[type] & b).map((b) => <path key={b} d={SEG[b]} strokeWidth="9" strokeLinecap="round" />)}
                <circle cx="32" cy="32" r="7" />
              </svg>
            </button>
          );
        })}
        {Array.from({ length: round.rows }).map((_, r) => (
          <div key={`e${r}`} className={`power-end lock ${r === round.core ? "core" : ""} ${r === round.core && done ? "open" : ""}`} style={{ gridRow: r + 1, gridColumn: round.cols + 2 }}>{r === round.core ? (done ? "🔓" : "🔒") : ""}</div>
        ))}
      </div>
      {!disabled && <button className="btn small amber" style={{ marginTop: 12 }} onClick={() => onSubmit(rot)}>Submit (Enter)</button>}
    </div>
  );
}

// ---------------------------------------------------------------- Identity Scan

const BODY = ["#29d9ff", "#ff3aa8", "#ffd84a", "#3cff9a", "#ff8a29", "#a86bff"];
const BADGE = ["#3cff9a", "#ff3d6e", "#29d9ff", "#ffd84a"];

function SecBot({ b }: { b: Bot }) {
  const body = BODY[b.body];
  const tilt = [0, -6, 6, 0][b.pose];
  const arm = [0, 20, -20, 35][b.pose];
  return (
    <svg viewBox="0 0 100 120" width="100%" style={{ transform: `rotate(${tilt}deg)` }}>
      {/* antenna */}
      {b.ant === 0 && <><line x1="50" y1="22" x2="50" y2="6" stroke="#cfe" strokeWidth="3" /><circle cx="50" cy="6" r="5" fill={body} /></>}
      {b.ant === 1 && <><line x1="40" y1="22" x2="32" y2="6" stroke="#cfe" strokeWidth="3" /><line x1="60" y1="22" x2="68" y2="6" stroke="#cfe" strokeWidth="3" /></>}
      {b.ant === 2 && <path d="M38 22 L50 4 L62 22" fill="none" stroke="#cfe" strokeWidth="3" />}
      {b.ant === 3 && <rect x="44" y="8" width="12" height="14" fill={body} />}
      {/* head */}
      <rect x="26" y="22" width="48" height="38" rx="8" fill="#0d1a1e" stroke={body} strokeWidth="3" />
      {/* eyes */}
      {b.eyes === 0 && <><circle cx="40" cy="38" r="5" fill="#eafff5" /><circle cx="60" cy="38" r="5" fill="#eafff5" /></>}
      {b.eyes === 1 && <rect x="34" y="34" width="32" height="7" rx="3" fill="#eafff5" />}
      {b.eyes === 2 && <><rect x="35" y="34" width="10" height="8" fill="#eafff5" /><rect x="55" y="34" width="10" height="8" fill="#eafff5" /></>}
      {b.eyes === 3 && <><path d="M35 41 L40 33 L45 41" stroke="#eafff5" strokeWidth="3" fill="none" /><path d="M55 41 L60 33 L65 41" stroke="#eafff5" strokeWidth="3" fill="none" /></>}
      {/* mouth */}
      {b.mouth === 0 && <line x1="40" y1="51" x2="60" y2="51" stroke="#eafff5" strokeWidth="3" />}
      {b.mouth === 1 && <path d="M40 49 Q50 57 60 49" stroke="#eafff5" strokeWidth="3" fill="none" />}
      {b.mouth === 2 && <rect x="42" y="48" width="16" height="6" fill="none" stroke="#eafff5" strokeWidth="2" />}
      {b.mouth === 3 && <path d="M40 52 L45 48 L50 52 L55 48 L60 52" stroke="#eafff5" strokeWidth="2" fill="none" />}
      {/* body and arms */}
      <rect x="30" y="64" width="40" height="36" rx="6" fill="#0d1a1e" stroke={body} strokeWidth="3" />
      <g transform={`rotate(${arm} 28 70)`}><rect x="18" y="66" width="9" height="26" rx="4" fill={body} /></g>
      <g transform={`rotate(${-arm} 72 70)`}><rect x="73" y="66" width="9" height="26" rx="4" fill={body} /></g>
      {/* chest light */}
      {b.badge === 0 && <circle cx="50" cy="80" r="6" fill={BADGE[0]} />}
      {b.badge === 1 && <rect x="44" y="74" width="12" height="12" fill={BADGE[1]} />}
      {b.badge === 2 && <path d="M50 73 L57 86 L43 86 Z" fill={BADGE[2]} />}
      {b.badge === 3 && <path d="M50 72 L58 80 L50 88 L42 80 Z" fill={BADGE[3]} />}
      <rect x="36" y="100" width="10" height="14" fill={body} /><rect x="54" y="100" width="10" height="14" fill={body} />
    </svg>
  );
}

function Imposter({ round, disabled, answer, onPick }: { round: { bots: Bot[]; cols: number }; disabled: boolean; answer?: number; onPick: (i: number) => void }) {
  const [cur, setCur] = useState(0);
  const n = round.bots.length;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (disabled) return;
      const c = round.cols;
      if (e.key === "ArrowRight") setCur((x) => Math.min(n - 1, x + 1));
      else if (e.key === "ArrowLeft") setCur((x) => Math.max(0, x - 1));
      else if (e.key === "ArrowDown") setCur((x) => Math.min(n - 1, x + c));
      else if (e.key === "ArrowUp") setCur((x) => Math.max(0, x - c));
      else if (e.key === "Enter" || e.key === " ") onPick(cur);
      else if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) onPick(Number(e.key) - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cur, disabled, n, onPick, round.cols]);
  return (
    <div className="bots" style={{ gridTemplateColumns: `repeat(${round.cols}, minmax(0, 104px))` }}>
      {round.bots.map((b, i) => (
        <button key={i} className={`bot ${cur === i ? "cur" : ""} ${answer === i ? "answer" : ""}`} disabled={disabled} onClick={() => onPick(i)} onMouseEnter={() => setCur(i)} aria-label={`Bot ${i + 1}`}>
          <SecBot b={b} />
          <span className="node-i">{i + 1}</span>
        </button>
      ))}
    </div>
  );
}
