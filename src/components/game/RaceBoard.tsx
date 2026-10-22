"use client";

import type { Room } from "@/lib/client/api";
import { racerColor, TEAM_COLORS, TEAM_NAMES } from "@/lib/shared/room";

/** Live race scoreboard in the corner of the screen during a multiplayer match. */
export function RaceBoard({ room }: { room: Room }) {
  const teams = room.mode === "teams";
  const rows = room.players
    .map((p, i) => ({ ...p, color: racerColor(p.team, i) }))
    .sort((a, b) => (b.outcome === "success" ? 1 : 0) - (a.outcome === "success" ? 1 : 0) || b.cores - a.cores || b.score - a.score);
  const total = room.coresTotal ?? 0;
  return (
    <div className="race-board hud-card" aria-label="Race scoreboard">
      <div className="hud-label" style={{ marginBottom: 6 }}>{teams ? "TEAM RACE" : "RACE"} · {room.code}</div>
      {teams && room.teams && (
        <div className="race-teams">
          {(["A", "B"] as const).map((t) => (
            <div key={t} style={{ color: TEAM_COLORS[t] }}><b>{room.teams![t].toLocaleString("en-IN")}</b><span>{TEAM_NAMES[t]}</span></div>
          ))}
        </div>
      )}
      {rows.map((p, i) => (
        <div key={p.userId} className={`race-row ${p.you ? "you" : ""}`} style={{ borderLeftColor: p.color }}>
          <span className="race-pos">{i + 1}</span>
          <span className="race-name">{p.nickname}{p.you ? " (tum)" : ""}</span>
          <span className="race-cores">{p.outcome === "success" ? "FINISH" : `${p.cores}/${total}`}</span>
          <span className="race-score">{p.score.toLocaleString("en-IN")}</span>
          {!p.online && !p.finished && <span className="race-off" title="connection nahi">⚠</span>}
        </div>
      ))}
    </div>
  );
}
