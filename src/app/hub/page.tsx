"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Loading, TopBar, useMe } from "@/components/Shell";
import { api, ApiError, type Mission } from "@/lib/client/api";

const BAND_COLORS = ["", "var(--green)", "var(--cyan)", "var(--violet)", "var(--amber)", "var(--red)"];
const OUTCOME: Record<string, [string, string]> = { success: ["CLEAR", "green"], fail: ["DOWN", "red"], timeout: ["TIME UP", "amber"], abandoned: ["LEFT", ""] };

export default function Hub() {
  const router = useRouter();
  const { me, loading, error } = useMe();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [event, setEvent] = useState<{ code: string; name: string; bandLabel: string; live: boolean; playedInstanceId: string | null } | null>(null);

  async function start(body: { mode: "personal" } | { mode: "event"; eventCode: string }) {
    setBusy(true);
    setMsg(null);
    try {
      const m = await api<Mission>("/api/missions/start", { method: "POST", json: body });
      router.push(`/play/${m.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "OPEN_MISSION" && typeof e.extra.instanceId === "string") {
        setMsg("Tumhara ek mission pehle se chalu hai. Use resume karo ya chhodo.");
      } else setMsg(e instanceof Error ? e.message : "Mission start nahi hua.");
      setBusy(false);
    }
  }

  async function checkEvent(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setEvent(null);
    try {
      setEvent(await api(`/api/events/${encodeURIComponent(code.trim())}`));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Event nahi mila.");
    }
  }

  async function abandon(id: string) {
    if (!confirm("Ye mission chhod doge? Iska score 'LEFT' ki tarah save hoga.")) return;
    try { await api(`/api/missions/${id}/abort`, { method: "POST", json: {} }); location.reload(); } catch (e) { setMsg(e instanceof Error ? e.message : "Nahi hua."); }
  }

  if (loading || !me) return <div className="page"><TopBar /><main className="container">{error ? <div className="error-box" style={{ marginTop: 40 }}>{error}</div> : <Loading />}</main></div>;
  const u = me.user;
  const xpFrac = (u.xp - u.levelFloorXp) / Math.max(1, u.nextLevelXp - u.levelFloorXp);
  const band = me.skill.band;

  return (
    <div className="page">
      <TopBar me={me} />
      <main className="container" style={{ padding: "28px 0 60px" }}>
        <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.25fr) minmax(0, 1fr)", alignItems: "start" }}>
          <div className="stack" style={{ gap: 18 }}>
            {/* Operator card */}
            <div className="panel rise">
              <div className="panel-title">Operator</div>
              <div className="row" style={{ gap: 20, alignItems: "center" }}>
                <Avatar id={u.avatarId} photoUrl={u.showPhoto ? u.photoUrl : null} size={96} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h1 style={{ fontSize: 34, lineHeight: 1.1 }}>{u.nickname}</h1>
                  <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
                    <span className="chip green mono">ID {u.participantId}</span>
                    <span className="chip cyan">Level {u.level}</span>
                    <span className="chip" style={{ color: BAND_COLORS[band], borderColor: BAND_COLORS[band] }}>Threat {band} · {me.skill.bandLabel}</span>
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <div className="row" style={{ justifyContent: "space-between", fontSize: 14 }}><span className="muted">XP {u.xp.toLocaleString("en-IN")}</span><span className="muted">Level {u.level + 1}: {u.nextLevelXp.toLocaleString("en-IN")}</span></div>
                    <div className="bar" style={{ marginTop: 4 }}><i style={{ width: `${Math.min(100, xpFrac * 100)}%` }} /></div>
                  </div>
                </div>
              </div>
              <div className="grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginTop: 18, textAlign: "center" }}>
                {[["Missions", me.stats.missions], ["Jeete", me.stats.wins], ["Best score", me.stats.best], ["Robots scrap", me.stats.kills]].map(([k, v]) => (
                  <div key={k as string}><div style={{ fontFamily: "var(--font-head)", fontSize: 26, fontWeight: 800 }}>{Number(v).toLocaleString("en-IN")}</div><div className="muted" style={{ fontSize: 13 }}>{k}</div></div>
                ))}
              </div>
            </div>

            {/* Launch */}
            <div className="panel rise" style={{ animationDelay: "0.08s" }}>
              <div className="panel-title">Mission control</div>
              {me.openMission ? (
                <div className="stack">
                  <p style={{ margin: 0 }}>Tumhara ek mission abhi chalu hai{me.openMission.mode === "event" ? " (event)" : ""}.</p>
                  <div className="row wrap">
                    <Link className="btn primary big" href={`/play/${me.openMission.id}`}>▶ Resume mission</Link>
                    <button className="btn red" onClick={() => abandon(me.openMission!.id)}>Chhod do</button>
                  </div>
                </div>
              ) : (
                <div className="stack">
                  <p style={{ margin: 0 }} className="muted">Har mission naya hota hai: alag vaults, alag raste, alag hacks. Threat level tumhare performance se apne aap badalta hai.</p>
                  {me.skill.tipOffered && <div className="ok-box">Tip: pichhle missions mushkil lage? Profile mein pace “Steady” kar sakte ho. Agla mission tumhari galtiyon pe practice karayega.</div>}
                  <button className="btn primary big" disabled={busy} onClick={() => start({ mode: "personal" })}>{busy ? "Mission ban raha hai..." : "▶ Naya mission"}</button>
                </div>
              )}
              <form onSubmit={checkEvent} className="row wrap" style={{ marginTop: 18, gap: 10 }}>
                <input className="input" placeholder="EVENT CODE" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={12} style={{ flex: 1, minWidth: 160, letterSpacing: "0.2em" }} aria-label="Event code" />
                <button className="btn cyan" disabled={code.trim().length < 4}>Event check karo</button>
              </form>
              {event && (
                <div className="panel cyan" style={{ marginTop: 14, padding: 16 }}>
                  <div className="row wrap">
                    <div><b style={{ fontFamily: "var(--font-head)", fontSize: 20 }}>{event.name}</b><div className="muted">Threat: {event.bandLabel} · sabko ek hi mission milega</div></div>
                    <span className="spacer" />
                    {event.playedInstanceId ? <span className="chip amber">Pehle khel chuke ho</span> : event.live ? (
                      <button className="btn primary cyan" disabled={busy || !!me.openMission} onClick={() => start({ mode: "event", eventCode: event.code })}>▶ Join event</button>
                    ) : <span className="chip red">Abhi band hai</span>}
                  </div>
                </div>
              )}
              {msg && <div className="error-box" style={{ marginTop: 12 }} role="alert">{msg}</div>}
            </div>
          </div>

          <div className="stack" style={{ gap: 18 }}>
            <div className="panel rise" style={{ animationDelay: "0.12s" }}>
              <div className="panel-title">Recent missions</div>
              {me.recent.length === 0 ? <p className="muted" style={{ margin: 0 }}>Abhi tak koi mission nahi. Pehla mission shuru karo!</p> : (
                <div className="stack" style={{ gap: 8 }}>
                  {me.recent.map((r) => (
                    <div key={r.instanceId} className="row" style={{ padding: "8px 10px", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.05)" }}>
                      <span className={`chip ${OUTCOME[r.outcome]?.[1] ?? ""}`}>{OUTCOME[r.outcome]?.[0] ?? r.outcome}</span>
                      <span className="muted" style={{ fontSize: 14 }}>T{r.band} · {r.cores}/{r.coresTotal} cores{r.mode === "event" ? " · event" : ""}</span>
                      <span className="spacer" />
                      <b style={{ fontFamily: "var(--font-head)" }}>{r.score.toLocaleString("en-IN")}</b>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="panel rise" style={{ animationDelay: "0.16s" }}>
              <div className="panel-title">Badges · {me.achievements.length}/{me.achievementCount}</div>
              {me.achievements.length === 0 ? <p className="muted" style={{ margin: 0 }}>Mission jeeto aur badges kamao: Flawless, Hackerman, Scrapyard...</p> : (
                <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {me.achievements.map((a) => (
                    <div key={a.code} style={{ padding: 10, border: "1px solid var(--line)", background: "rgba(60,255,154,0.05)" }}>
                      <div style={{ fontFamily: "var(--font-head)", color: "var(--green)" }}>★ {a.title}</div>
                      <div className="muted" style={{ fontSize: 13 }}>{a.description}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="panel rise" style={{ animationDelay: "0.2s", padding: 16 }}>
              <div className="row wrap" style={{ gap: 10 }}>
                <span className="muted" style={{ fontSize: 14 }}>NULL narrator (AI):</span>
                <span className={`chip ${me.narrator.state === "online" ? "green" : me.narrator.state === "off" ? "" : "amber"}`}>{me.narrator.state === "off" ? "offline · built-in story" : me.narrator.state}</span>
                <span className="spacer" />
                <Link href="/rules" className="btn small amber">Controls</Link>
              </div>
            </div>
          </div>
        </div>
      </main>
      <style>{`@media (max-width: 900px) { main .grid[style*="1.25fr"] { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}
