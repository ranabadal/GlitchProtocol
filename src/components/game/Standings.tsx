"use client";

import Link from "next/link";
import type { Room } from "@/lib/client/api";
import { racerColor, TEAM_COLORS, TEAM_NAMES } from "@/lib/shared/room";

/** Final results of a finished race. */
export function Standings({ room }: { room: Room }) {
  const teams = room.mode === "teams";
  const sorted = [...room.players].sort((a, b) => {
    if (a.outcome === "success" && b.outcome !== "success") return -1;
    if (b.outcome === "success" && a.outcome !== "success") return 1;
    if (a.outcome === "success" && b.outcome === "success") return (a.finishedAt ?? 0) - (b.finishedAt ?? 0);
    return b.score - a.score;
  });
  const w = room.winner;
  const you = room.players.find((p) => p.you);
  const youWon = teams ? !!(w?.team && you?.team === w.team) : !!(w?.userId && you?.userId === w.userId);
  const head = teams ? (w?.team ? `${TEAM_NAMES[w.team]} JEET GAYI!` : "BARABARI!") : w?.nickname ? `${w.nickname.toUpperCase()} JEET GAYA!` : "BARABARI!";
  return (
    <div className="standings">
      <div className="glitch standings-head" data-text={head} style={{ color: youWon ? "var(--green)" : teams && w?.team ? TEAM_COLORS[w.team] : "var(--amber)" }}>{head}</div>
      <div className="muted" style={{ textAlign: "center", marginBottom: 12 }}>
        {w?.reason === "first" ? "Sabse pehle mission complete kiya!" : w?.reason === "time" ? "Time khatam: sabse zyada score jeeta." : "Sab players ka mission khatam."}
        {you && (youWon ? " Tum jeet gaye!" : " Agli baar pakka!")}
      </div>
      {teams && room.teams && (
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          {(["A", "B"] as const).map((t) => (
            <div key={t} className="stat" style={{ borderColor: TEAM_COLORS[t] }}><b style={{ color: TEAM_COLORS[t] }}>{room.teams![t].toLocaleString("en-IN")}</b><span>{TEAM_NAMES[t]}</span></div>
          ))}
        </div>
      )}
      <div className="stack" style={{ gap: 6 }}>
        {sorted.map((p, i) => (
          <div key={p.userId} className="standing-row" style={{ borderColor: racerColor(p.team, room.players.indexOf(p)) }}>
            <b className="mono" style={{ width: 28 }}>#{i + 1}</b>
            <span style={{ flex: 1 }}><b>{p.nickname}</b>{p.you && <span className="green"> (tum)</span>}{teams && p.team && <span style={{ color: TEAM_COLORS[p.team] }}> · {TEAM_NAMES[p.team]}</span>}</span>
            <span className="muted">{p.cores}{room.coresTotal ? `/${room.coresTotal}` : ""} cores · {p.kills} robots</span>
            <span className={`chip ${p.outcome === "success" ? "green" : ""}`}>{p.outcome === "success" ? "FINISH" : p.outcome === "abandoned" ? "LEFT" : p.finished ? "OUT" : "..."}</span>
            <b style={{ fontFamily: "var(--font-head)", minWidth: 70, textAlign: "right" }}>{p.score.toLocaleString("en-IN")}</b>
          </div>
        ))}
      </div>
      <div className="row wrap" style={{ marginTop: 16, gap: 10, justifyContent: "center" }}>
        <Link className="btn primary" href="/hub">Hub pe naya room banao</Link>
      </div>
    </div>
  );
}
