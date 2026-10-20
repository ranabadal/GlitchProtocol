"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Mission } from "@/lib/client/api";

/*
 * After-action report: the server's final score breakdown, XP, threat-level change,
 * new badges, and a short personal debrief (AI-written when available, otherwise the
 * built-in text).
 */

const HEAD: Record<string, [string, string]> = {
  success: ["NEON CITY ONLINE", "var(--green)"],
  fail: ["SYSTEM DOWN", "var(--red)"],
  timeout: ["TIME UP", "var(--amber)"],
  abandoned: ["MISSION ABORTED", "var(--muted)"],
};

const BADGES: Record<string, string> = {
  FIRST_CLEAR: "City online", FLAWLESS: "Flawless", HACKERMAN: "Hackerman", SCRAPYARD: "Scrapyard", SPEED_DEMON: "Speed demon",
  ALL_HACKS: "Triple threat", AGENT: "Agent rank", LEGEND: "Legend", COMEBACK: "Comeback", EVENT_PLAYER: "Event player",
};

export function Results({ mission, onNext, busy }: { mission: Mission; onNext: () => void; busy: boolean }) {
  const r = mission.result!;
  const b = r.breakdown as Record<string, number> & { stars: number; newAchievements: string[]; bandChange?: string };
  const [fb, setFb] = useState<{ headline: string; feedback: string; next_tip: string; source: string } | null>(r.feedback?.source === "fallback" ? null : r.feedback);
  const [loadingFb, setLoadingFb] = useState(r.outcome !== "abandoned");

  useEffect(() => {
    if (r.outcome === "abandoned") { setFb(r.feedback); setLoadingFb(false); return; }
    let live = true;
    api<{ headline: string; feedback: string; next_tip: string; source: string } | null>(`/api/missions/${mission.id}/debrief`, { timeoutMs: 12000 })
      .then((x) => { if (live) setFb(x ?? r.feedback); })
      .catch(() => { if (live) setFb(r.feedback); })
      .finally(() => { if (live) setLoadingFb(false); });
    return () => { live = false; };
  }, [mission.id, r.feedback, r.outcome]);

  const [head, color] = HEAD[r.outcome] ?? HEAD.fail;
  const rows: [string, string, number][] = [
    ["Data cores", `${b.cores}/${b.coresTotal}`, b.corePoints],
    ["Hacks", `${b.hacksFirstTry} pehli try mein`, b.hackPoints],
    ["Robots scrap", `${b.kills}`, b.killPoints],
  ];
  if (r.cleared) {
    rows.push(["Mission clear", "", b.clear], ["Time bonus", `${b.secondsLeft}s bache`, b.time], ["Flawless", b.livesLost === 0 ? "koi life nahi gayi" : `${b.livesLost} life gayi`, b.flawless]);
  }
  return (
    <div className="results-veil">
      <div className="results panel rise">
        <div className="results-head" style={{ color }}>
          <div className="mono muted" style={{ fontSize: 13, letterSpacing: "0.3em" }}>{mission.narrative.title?.toUpperCase()} · {mission.bandLabel.toUpperCase()}{mission.event ? ` · EVENT ${mission.event.code}` : ""}</div>
          <h1 className="glitch" data-text={head} style={{ fontSize: "clamp(36px, 6vw, 64px)", color }}>{head}</h1>
          <div className="stars">{[0, 1, 2].map((i) => <span key={i} className={i < b.stars ? "on" : ""}>★</span>)}</div>
        </div>
        <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 22 }}>
          <div>
            <table className="board">
              <tbody>
                {rows.map(([k, d, v]) => (
                  <tr key={k}><td>{k}<div className="muted" style={{ fontSize: 13 }}>{d}</div></td><td style={{ textAlign: "right", fontFamily: "var(--font-head)", fontSize: 18 }}>+{(v ?? 0).toLocaleString("en-IN")}</td></tr>
                ))}
                <tr><td style={{ fontFamily: "var(--font-head)", fontSize: 18 }}>TOTAL</td><td style={{ textAlign: "right", fontFamily: "var(--font-head)", fontSize: 30, color: "var(--green)", fontWeight: 800 }}>{r.score.toLocaleString("en-IN")}</td></tr>
              </tbody>
            </table>
            <div className="row wrap" style={{ marginTop: 12, gap: 8 }}>
              <span className="chip cyan">+{r.xpAwarded.toLocaleString("en-IN")} XP</span>
              {b.levelAfter > b.levelBefore && <span className="chip green">LEVEL UP → {b.levelAfter}</span>}
              {b.bandChange === "up" && <span className="chip amber">Threat level badha → {b.bandAfter}</span>}
              {b.bandChange === "down" && <span className="chip">Threat level thoda kam → {b.bandAfter}</span>}
              {(b.newAchievements ?? []).map((a) => <span key={a} className="chip green">★ {BADGES[a] ?? a}</span>)}
            </div>
          </div>
          <div className="panel cyan" style={{ padding: 18 }}>
            <div className="panel-title" style={{ color: "var(--cyan)" }}>Debrief</div>
            {loadingFb && !fb ? (
              <div className="stack"><div className="skeleton" style={{ width: "60%" }} /><div className="skeleton" /><div className="skeleton" style={{ width: "80%" }} /><span className="muted mono" style={{ fontSize: 13 }}>Mission data analyse ho raha hai...</span></div>
            ) : fb ? (
              <div className="stack" style={{ gap: 8 }}>
                <b style={{ fontFamily: "var(--font-head)", fontSize: 20 }}>{fb.headline}</b>
                <p style={{ margin: 0 }}>{fb.feedback}</p>
                <p style={{ margin: 0 }} className="amber">▸ Agli baar: {fb.next_tip}</p>
                <span className="muted mono" style={{ fontSize: 12 }}>{fb.source === "ai" ? "AI debrief" : "Built-in debrief"}</span>
              </div>
            ) : null}
          </div>
        </div>
        <div className="row wrap" style={{ marginTop: 22, gap: 12 }}>
          {mission.mode === "personal" && <button className="btn primary big" onClick={onNext} disabled={busy}>{busy ? "Mission ban raha hai..." : "▶ Agla mission"}</button>}
          <Link className="btn big cyan" href="/hub">Hub</Link>
          <Link className="btn big amber" href="/leaderboard">Leaderboard</Link>
        </div>
      </div>
    </div>
  );
}
