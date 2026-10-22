"use client";

import { useEffect, useState } from "react";
import type { HudState } from "@/game/types";

/*
 * Heads-up display drawn over the 3D view. Reads 12 snapshots a second from the
 * engine; nothing here affects gameplay or scoring.
 */

const HACK_ICON: Record<string, string> = { glitch: "◈", power: "⚡", imposter: "☻", titan: "♛", truck: "⛟" };
const HACK_SHORT: Record<string, string> = { glitch: "Data Stream", power: "Firewall", imposter: "Identity", titan: "TITAN", truck: "Data Truck" };
const WEAPON_UI: { id: HudState["weapon"]; key: string; name: string; icon: string }[] = [
  { id: "blaster", key: "1", name: "Blaster", icon: "⌁" },
  { id: "scatter", key: "2", name: "Scatter", icon: "⁂" },
  { id: "bomb", key: "3", name: "Bomb", icon: "◉" },
  { id: "blade", key: "4", name: "Blade", icon: "⚔" },
];

function fmt(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function Hud({ hud, title, minimap, race }: { hud: HudState; title: string; minimap: React.ReactNode; race?: React.ReactNode }) {
  const now = performance.now();
  const [, force] = useState(0);
  // Re-render a few times a second so notices fade even when the game is paused.
  useEffect(() => { const t = setInterval(() => force((x) => x + 1), 250); return () => clearInterval(t); }, []);
  const low = hud.timeLeft !== null && hud.timeLeft < 30;
  const hpColor = hud.health > 60 ? "var(--green)" : hud.health > 30 ? "var(--amber)" : "var(--red)";
  const notices = hud.notices.filter((n) => now - n.at < 5000).slice(-4);
  const nullLine = hud.nullLine && now - hud.nullLine.at < 4500 ? hud.nullLine : null;
  const showCross = hud.mode === "foot" || hud.mode === "uplink" || hud.mode === "heli";
  const onFoot = hud.mode === "foot" || hud.mode === "uplink";
  const hero = hud.heroLine && now - hud.heroLine.at < 3000 ? hud.heroLine : null;
  const hit = hud.hitMarker > 0;
  const dmgAge = hud.damageDir !== null ? 1 : 0;

  return (
    <div className="hud">
      {/* Objective */}
      <div className="hud-tl">
        <div className="hud-card">
          <div className="hud-label">{title}</div>
          <div className="hud-objective">▸ {hud.objective || "..."}{hud.objectiveDist !== null && hud.objectiveDist > 8 && <span className="hud-dist">{hud.objectiveDist} m</span>}</div>
          <div className="hud-vaults">
            {hud.vaults.map((v) => (
              <div key={v.id} className={`hud-vault ${v.state}`} title={v.name}>
                <span className="ic">{v.state === "taken" ? "✔" : HACK_ICON[v.hackType]}</span>
                <span>{v.state === "taken" ? "Core mila" : v.state === "brute" ? "Brute-force" : v.state === "open" ? "Core uthao" : HACK_SHORT[v.hackType] ?? v.hackType}</span>
              </div>
            ))}
          </div>
          <div className="hud-cores">DATA CORES <b>{hud.cores}/{hud.coresTotal}</b>{hud.shards && hud.shards.total > 0 && <span className="hud-shards"> · SHARDS <b>{hud.shards.got}/{hud.shards.total}</b></span>}</div>
        </div>
      </div>

      {/* Timer, score, NULL */}
      <div className="hud-tc">
        <div className={`hud-timer ${low ? "low" : ""}`}>{hud.timeLeft !== null ? fmt(hud.timeLeft) : "--:--"}</div>
        <div className="hud-score">SCORE <b>{hud.score.toLocaleString("en-IN")}</b></div>
        {hud.uplinkProgress !== null && hud.mode !== "won" && (
          <div className="hud-uplink">
            <div className="hud-label">{hud.objective.startsWith("UPLOAD") ? "UPLOADING" : "UPLOAD PAUSED · ZONE MEIN JAO"}</div>
            <div className="bar wide"><i style={{ width: `${hud.uplinkProgress * 100}%` }} /></div>
          </div>
        )}
        {hud.bruteProgress !== null && (
          <div className="hud-uplink">
            <div className="hud-label amber">VAULT BRUTE-FORCE</div>
            <div className="bar wide amber"><i style={{ width: `${hud.bruteProgress * 100}%` }} /></div>
          </div>
        )}
        {hud.boss && (
          <div className="boss-bar">
            <div className="hud-label">{hud.boss.name}</div>
            <div className="bar wide boss"><i style={{ width: `${(hud.boss.hp / hud.boss.max) * 100}%` }} /></div>
          </div>
        )}
        {hud.combo >= 2 && <div key={hud.combo} className="combo">x{hud.combo} COMBO!</div>}
        {hud.inLobby && hud.mode === "foot" && <div className="lobby-tag">VAULT LOBBY · ANDAR ROBOTS HO SAKTE HAIN</div>}
        {nullLine && <div key={nullLine.at} className="null-line" data-text={nullLine.text}><span className="null-tag">NULL:</span> {nullLine.text}</div>}
      </div>

      {/* Minimap and lives */}
      <div className="hud-tr">
        {minimap}
        <div className="hud-lives" aria-label={`${hud.lives} lives`}>
          {Array.from({ length: Math.max(3, hud.lives) }).map((_, i) => <span key={i} className={i < hud.lives ? "on" : ""}>⬢</span>)}
        </div>
        <div className="hud-keys mono">Shift daudo · 1-4 weapon · V slap · C roll · F ride · M map · Esc</div>
        {race}
      </div>

      {/* Vitals */}
      <div className="hud-bl">
        <div className="hud-card vitals">
          <div className="vital"><span className="hud-label">HEALTH</span><div className="bar"><i style={{ width: `${hud.health}%`, background: hpColor, boxShadow: `0 0 10px ${hpColor}` }} /></div><b>{hud.health}</b></div>
          {hud.mode === "car" ? (
            <>
              <div className="vital"><span className="hud-label">{hud.carName?.toUpperCase()}</span><div className="bar"><i style={{ width: `${hud.carHealth}%`, background: hud.carHealth > 40 ? "var(--cyan)" : "var(--red)" }} /></div><b>{hud.carHealth}</b></div>
              <div className="speedo"><b>{hud.speedKmh}</b><span>km/h</span></div>
            </>
          ) : hud.mode === "heli" ? (
            <div className="speedo"><b>{hud.altitude ?? 0}</b><span>m upar · {hud.speedKmh} km/h</span></div>
          ) : hud.mode === "train" ? (
            <div className="speedo"><b>METRO</b><span>Skyline line</span></div>
          ) : (
            <>
              {(hud.weapon === "blaster" || hud.weapon === "scatter") && (
                <div className="vital"><span className="hud-label">{hud.overheated ? "OVERHEAT!" : hud.weapon === "scatter" ? "SCATTER" : "BLASTER"}</span><div className={`bar ${hud.overheated ? "hot" : ""}`}><i style={{ width: `${hud.heat * 100}%`, background: hud.heat > 0.75 ? "var(--red)" : "var(--amber)" }} /></div><b>{Math.round(hud.heat * 100)}°</b></div>
              )}
              {hud.weapon === "bomb" && <div className="vital"><span className="hud-label">PLASMA BOMB</span><div className="pips">{[0, 1, 2].map((i) => <i key={i} className={i < hud.bombs ? "on" : i === hud.bombs ? "charging" : ""} style={i === hud.bombs ? { ["--p" as string]: `${hud.bombCharge * 100}%` } : undefined} />)}</div><b>{hud.bombs}</b></div>}
              {hud.weapon === "blade" && <div className="vital"><span className="hud-label">ENERGY BLADE</span><span className="muted" style={{ fontSize: 13 }}>Paas jao + click · 3rd hit COMBO</span></div>}
              <div className="vital"><span className="hud-label">STAMINA</span><div className="bar thin"><i style={{ width: `${hud.stamina}%`, background: hud.stamina > 25 ? "var(--cyan)" : "var(--red)" }} /></div><b>{hud.stamina}</b></div>
            </>
          )}
          <div className={`emp ${hud.empReady >= 1 ? "ready" : ""}`}>
            <svg viewBox="0 0 40 40" width="40" height="40"><circle cx="20" cy="20" r="16" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="4" /><circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="4" strokeDasharray={`${hud.empReady * 100.5} 100.5`} transform="rotate(-90 20 20)" /></svg>
            <span>Q · EMP</span>
          </div>
        </div>
      </div>

      {onFoot && (
        <div className="weapon-bar">
          {WEAPON_UI.map((w) => (
            <div key={w.id} className={`wslot ${hud.weapon === w.id ? "on" : ""}`}>
              <span className="k">{w.key}</span><span className="ic">{w.icon}</span><span className="n">{w.name}</span>
              {w.id === "bomb" && <span className="cnt">{hud.bombs}</span>}
            </div>
          ))}
          <div className="wslot slap"><span className="k">V</span><span className="ic">✋</span><span className="n">Slap</span></div>
        </div>
      )}
      {hero && <div key={hero.at} className="hero-line"><span>TUM:</span> {hero.text}</div>}

      {/* Prompt and notices */}
      <div className="hud-bc">
        <div className="notices">
          {notices.map((n) => <div key={n.id} className={`notice ${n.tone}`} style={{ opacity: Math.min(1, (5000 - (now - n.at)) / 800) }}>{n.text}</div>)}
        </div>
        {hud.prompt && <div className="prompt">{hud.prompt.includes("·") ? <><span className="kbd">{hud.prompt.split("·")[0].trim()}</span> {hud.prompt.split("·").slice(1).join("·")}</> : hud.prompt}</div>}
      </div>

      {showCross && (
        <div className={`crosshair ${hit ? "hit" : ""} ${hud.overheated ? "hot" : ""}`}>
          <i /><i /><i /><i />
          {hit && <b />}
        </div>
      )}
      {dmgAge > 0 && hud.damageDir !== null && <div className="dmg-arc" style={{ transform: `translate(-50%, -50%) rotate(${-hud.damageDir}rad)` }} />}
    </div>
  );
}
