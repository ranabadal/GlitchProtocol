"use client";

import { useEffect, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Loading, TopBar, useMe } from "@/components/Shell";
import { api } from "@/lib/client/api";

interface Row { rank: number; userId: string; nickname: string; avatarId: string; photoUrl: string | null; level: number; score: number; detail: string; isYou: boolean }
interface Board { board: string; rows: Row[]; band?: number; event?: { id: string; code: string; name: string } | null; events: { id: string; code: string; name: string; live: boolean }[] }

const BANDS = [[1, "Rookie"], [2, "Cadet"], [3, "Agent"], [4, "Elite"], [5, "Legend"]] as const;

export default function Leaderboard() {
  const { me } = useMe();
  const [tab, setTab] = useState<"overall" | "band" | "event">("overall");
  const [band, setBand] = useState(1);
  const [eventId, setEventId] = useState<string | null>(null);
  const [data, setData] = useState<Board | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const q = tab === "band" ? `?board=band&band=${band}` : tab === "event" ? `?board=event${eventId ? `&eventId=${eventId}` : ""}` : "";
    setData(null);
    api<Board>(`/api/leaderboard${q}`).then((d) => { if (live) { setData(d); setErr(null); } }).catch((e) => live && setErr(e.message));
    const t = setInterval(() => api<Board>(`/api/leaderboard${q}`).then((d) => live && setData(d)).catch(() => {}), 15000);
    return () => { live = false; clearInterval(t); };
  }, [tab, band, eventId]);

  return (
    <div className="page">
      <TopBar me={me} />
      <main className="container" style={{ padding: "28px 0 60px" }}>
        <div className="panel rise">
          <div className="panel-title">Leaderboard</div>
          <div className="row wrap" style={{ gap: 8, marginBottom: 14 }}>
            {(["overall", "band", "event"] as const).map((t) => (
              <button key={t} className={`btn small ${tab === t ? "primary" : ""}`} onClick={() => setTab(t)}>{t === "overall" ? "Overall" : t === "band" ? "Threat level" : "Event"}</button>
            ))}
            <span className="spacer" />
            {tab === "band" && BANDS.map(([b, l]) => <button key={b} className={`btn small cyan ${band === b ? "primary" : ""}`} onClick={() => setBand(b)}>{l}</button>)}
            {tab === "event" && data && data.events.length > 0 && (
              <select className="input" style={{ minHeight: 34, padding: "4px 10px" }} value={eventId ?? data.event?.id ?? ""} onChange={(e) => setEventId(e.target.value)}>
                {data.events.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.code}){e.live ? " · LIVE" : ""}</option>)}
              </select>
            )}
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            {tab === "overall" && "Personal missions ka total score. Mushkil threat level pe zyada points milte hain (x1 se x2)."}
            {tab === "band" && "Is threat level pe har player ka best cleared mission. Sabka mission us level ka hi tha."}
            {tab === "event" && "Shared event: sabne bilkul ek jaisa mission khela. Sabse fair muqabla!"}
          </p>
          {err && <div className="error-box">{err}</div>}
          {!data ? <Loading text="Scores aa rahe hain..." /> : data.rows.length === 0 ? <p className="muted">Abhi koi score nahi. Pehle tum khelo!</p> : (
            <table className="board">
              <thead><tr><th>#</th><th>Operator</th><th>Detail</th><th style={{ textAlign: "right" }}>Score</th></tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.userId} className={r.isYou ? "you" : ""}>
                    <td className={`rank r${r.rank}`}>{r.rank}</td>
                    <td><div className="row" style={{ gap: 10 }}><Avatar id={r.avatarId} photoUrl={r.photoUrl} size={36} /><div><b>{r.nickname}</b>{r.isYou && <span className="chip green" style={{ marginLeft: 8 }}>you</span>}<div className="muted" style={{ fontSize: 13 }}>Level {r.level}</div></div></div></td>
                    <td className="muted" style={{ fontSize: 14 }}>{r.detail}</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--font-head)", fontSize: 20, fontWeight: 800 }}>{r.score.toLocaleString("en-IN")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
}
