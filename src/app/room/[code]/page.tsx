"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Loading, TopBar, useMe } from "@/components/Shell";
import { api, ApiError, type Room } from "@/lib/client/api";
import { Standings } from "@/components/game/Standings";
import { racerColor, TEAM_COLORS, TEAM_NAMES } from "@/lib/shared/room";

/*
 * Multiplayer lobby: share the code, pick a team, and the host starts the race. When the
 * race begins every player's page jumps straight into the same mission.
 */

export default function RoomPage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const { me } = useMe();
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const going = useRef(false);
  const upper = String(code ?? "").toUpperCase();

  const load = useCallback(async () => {
    try {
      const r = await api<Room>(`/api/rooms/${encodeURIComponent(upper)}`, { timeoutMs: 8000 });
      setRoom(r);
      setError(null);
      if (r.status === "playing" && r.yourInstanceId && !going.current) {
        going.current = true;
        router.push(`/play/${r.yourInstanceId}`);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { router.replace("/login"); return; }
      if (e instanceof ApiError && e.status === 404) setRoom(null);
      setError(e instanceof Error ? e.message : "Room load nahi hua.");
    }
  }, [upper, router]);

  // Join on arrival (a shared link works too), then keep the lobby fresh.
  useEffect(() => {
    let live = true;
    (async () => {
      try { await api<Room>(`/api/rooms/${encodeURIComponent(upper)}/join`, { method: "POST", json: {} }); } catch (e) {
        if (live && e instanceof ApiError && e.code !== "ROOM_STARTED") setError(e.message);
      }
      if (live) await load();
    })();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 1200);
    return () => { live = false; clearInterval(t); };
  }, [upper, load]);

  async function act(path: string, json: unknown = {}) {
    setBusy(true);
    try {
      const r = await api<Room | { ok: true }>(`/api/rooms/${encodeURIComponent(upper)}/${path}`, { method: "POST", json });
      if ("code" in r) setRoom(r);
      setError(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nahi hua.");
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    await act("leave");
    router.push("/hub");
  }

  function copy() {
    const text = `GLITCH PROTOCOL race! Hub pe jao, "Join room" mein ye code daalo: ${upper}`;
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(() => {});
  }

  if (!me) return <div className="page"><TopBar /><main className="container"><Loading /></main></div>;

  if (!room) {
    return (
      <div className="page">
        <TopBar me={me} />
        <main className="container" style={{ padding: "40px 0" }}>
          {error ? <div className="error-box">{error}</div> : <Loading />}
          <Link href="/hub" className="btn cyan" style={{ marginTop: 18 }}>Wapas hub</Link>
        </main>
      </div>
    );
  }

  const teams = room.mode === "teams";
  const enough = room.players.length >= 2 && (!teams || (room.players.some((p) => p.team === "A") && room.players.some((p) => p.team === "B")));
  const myTeam = room.players.find((p) => p.you)?.team ?? null;

  return (
    <div className="page">
      <TopBar me={me} />
      <main className="container room-page" style={{ padding: "28px 0 60px" }}>
        <div className="panel rise">
          <div className="row wrap" style={{ gap: 10 }}>
            <span className="chip green">Multiplayer</span>
            <span className={`chip ${teams ? "cyan" : "amber"}`}>{teams ? "Team race · A vs B" : `Solo race · max ${room.maxPlayers}`}</span>
            <span className="chip">Threat {room.band}</span>
            <span className="spacer" />
            <Link href="/hub" className="btn small cyan">Hub</Link>
          </div>
          <div className="room-code-wrap">
            <div>
              <div className="hud-label">Room code</div>
              <div className="room-code mono">{room.code}</div>
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <button className="btn small" onClick={copy}>{copied ? "Copy ho gaya!" : "Invite copy karo"}</button>
              <span className="muted" style={{ fontSize: 14, maxWidth: 340 }}>Dost apne laptop pe login karke <b>Hub → Join room</b> mein ye code daalein.</span>
            </div>
          </div>

          {room.status === "lobby" && (
            teams ? (
              <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                {(["A", "B"] as const).map((t) => (
                  <div key={t} className="team-col" style={{ borderColor: TEAM_COLORS[t] }}>
                    <div className="row" style={{ marginBottom: 10 }}>
                      <b style={{ fontFamily: "var(--font-head)", color: TEAM_COLORS[t], fontSize: 20 }}>{TEAM_NAMES[t]}</b>
                      <span className="spacer" />
                      {myTeam !== t && <button className="btn small" style={{ ["--c" as string]: TEAM_COLORS[t] }} disabled={busy} onClick={() => act("team", { team: t })}>Is team mein jao</button>}
                    </div>
                    <div className="stack" style={{ gap: 8 }}>
                      {room.players.filter((p) => p.team === t).map((p) => <PlayerCard key={p.userId} p={p} color={TEAM_COLORS[t]} />)}
                      {room.players.filter((p) => p.team === t).length === 0 && <div className="muted">Abhi koi nahi</div>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
                {room.players.map((p, i) => <PlayerCard key={p.userId} p={p} color={racerColor(null, i)} />)}
                {Array.from({ length: Math.max(0, room.maxPlayers - room.players.length) }, (_, i) => (
                  <div key={`empty${i}`} className="player-card empty">Khali jagah</div>
                ))}
              </div>
            )
          )}

          {room.status === "lobby" && (
            <div className="row wrap" style={{ marginTop: 20, gap: 12 }}>
              {room.youAreHost ? (
                <button className="btn primary big" disabled={busy || !enough} onClick={() => act("start")}>
                  {busy ? "Race ban rahi hai..." : "▶ RACE START KARO"}
                </button>
              ) : (
                <div className="ok-box">Host ({room.players.find((p) => p.host)?.nickname}) ke start karne ka wait karo...</div>
              )}
              {!enough && <span className="muted">{teams ? "Dono teams mein kam se kam 1 player chahiye." : "Kam se kam 2 players chahiye."}</span>}
              <span className="spacer" />
              <button className="btn red" disabled={busy} onClick={leave}>Room chhodo</button>
            </div>
          )}

          {room.status === "playing" && (
            <div className="ok-box" style={{ marginTop: 10 }}>
              Race shuru ho gayi! {room.yourInstanceId ? "City load ho rahi hai..." : "Tum is race mein nahi ho."}
              {room.yourInstanceId && <Link className="btn small primary" style={{ marginLeft: 12 }} href={`/play/${room.yourInstanceId}`}>Race kholo</Link>}
            </div>
          )}

          {room.status === "finished" && <Standings room={room} />}

          <div className="rules-box">
            <b>Rules:</b>{" "}
            {teams
              ? "Sabko same mission milta hai. Team ka score = sab members ke points. Jo player sabse pehle mission complete kare, uski team ko +1000 bonus milta hai aur race khatam. Zyada score wali team jeetegi."
              : "Sabko same mission milta hai: same vaults, same hacks, same robots. Jo sabse pehle upload complete kare, wo jeeta! Agar time khatam ho gaya to sabse zyada score wala jeetega."}
          </div>
          {error && <div className="error-box" style={{ marginTop: 12 }} role="alert">{error}</div>}
        </div>
      </main>
    </div>
  );
}

function PlayerCard({ p, color }: { p: Room["players"][number]; color: string }) {
  return (
    <div className="player-card" style={{ borderColor: color }}>
      <Avatar id={p.avatarId} size={44} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="row" style={{ gap: 6 }}>
          <b style={{ fontFamily: "var(--font-head)", fontSize: 18, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.nickname}</b>
          <i className={`dot ${p.online ? "on" : ""}`} title={p.online ? "online" : "offline"} />
        </div>
        <div className="row wrap" style={{ gap: 6, marginTop: 2 }}>
          <span className="muted" style={{ fontSize: 13 }}>Level {p.level}</span>
          {p.host && <span className="chip amber" style={{ fontSize: 10, padding: "1px 6px" }}>Host</span>}
          {p.you && <span className="chip green" style={{ fontSize: 10, padding: "1px 6px" }}>Tum</span>}
        </div>
      </div>
    </div>
  );
}
