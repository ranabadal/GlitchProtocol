"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { TopBar } from "@/components/Shell";
import { AVATARS } from "@/lib/avatars";
import { api, ApiError, type Me } from "@/lib/client/api";

export default function Register() {
  const router = useRouter();
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [avatarId, setAvatarId] = useState<string>(AVATARS[0].id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Me | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) { setError("Dono passwords same hone chahiye."); return; }
    setBusy(true);
    try {
      setDone(await api<Me>("/api/auth/register", { method: "POST", json: { nickname, password, avatarId } }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Register nahi ho paaya.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="page">
        <TopBar me={done} />
        <main className="container" style={{ maxWidth: 560, padding: "60px 0" }}>
          <div className="panel rise" style={{ textAlign: "center" }}>
            <div className="panel-title">Operator registered</div>
            <div style={{ display: "flex", justifyContent: "center" }}><Avatar id={done.user.avatarId} size={110} /></div>
            <h2 style={{ fontSize: 30, marginTop: 14 }}>Welcome, {done.user.nickname}!</h2>
            <p className="muted">Tumhara Participant ID — isse likh lo, login mein kaam aayega:</p>
            <div className="mono green" style={{ fontSize: 40, letterSpacing: "0.2em", textShadow: "0 0 18px rgba(60,255,154,0.6)" }}>{done.user.participantId}</div>
            <p className="hint">Photo lagani hai? Profile mein jaake laga sakte ho (optional, sirf tumhari marzi se dikhegi).</p>
            <button className="btn primary big" style={{ marginTop: 12 }} onClick={() => router.push("/hub")}>▶ Hub mein chalo</button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <TopBar />
      <main className="container" style={{ maxWidth: 760, padding: "40px 0" }}>
        <form className="panel rise stack" onSubmit={submit} style={{ gap: 18 }}>
          <div className="panel-title">New operator</div>
          <h1 style={{ fontSize: 30 }}>Apna operator banao</h1>
          <div className="field">
            <label htmlFor="nick">Nickname (leaderboard pe dikhega)</label>
            <input id="nick" className="input" value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={16} autoComplete="username" placeholder="e.g. NeonRider" required />
            <span className="hint">3-16 letters. Asli naam ki zaroorat nahi.</span>
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div className="field">
              <label htmlFor="pw">Password</label>
              <input id="pw" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
            </div>
            <div className="field">
              <label htmlFor="pw2">Password dobara</label>
              <input id="pw2" type="password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={8} required />
            </div>
          </div>
          <div className="field">
            <label>Operator emblem chuno (visor ka colour bhi yahi hoga)</label>
            <div className="row wrap" style={{ gap: 10 }} role="radiogroup">
              {AVATARS.map((a) => (
                <button
                  type="button" key={a.id} role="radio" aria-checked={avatarId === a.id} onClick={() => setAvatarId(a.id)}
                  style={{ background: "none", border: avatarId === a.id ? `2px solid hsl(${a.hue} 100% 60%)` : "2px solid transparent", padding: 4, cursor: "pointer", boxShadow: avatarId === a.id ? `0 0 16px hsl(${a.hue} 100% 50% / 0.6)` : "none" }}
                >
                  <Avatar id={a.id} size={64} />
                  <div className="mono" style={{ fontSize: 12, color: avatarId === a.id ? `hsl(${a.hue} 100% 70%)` : "var(--muted)" }}>{a.name}</div>
                </button>
              ))}
            </div>
          </div>
          {error && <div className="error-box" role="alert">{error}</div>}
          <div className="row wrap">
            <button className="btn primary big" disabled={busy}>{busy ? "Ban raha hai..." : "▶ Register"}</button>
            <span className="muted">Pehle se account hai? <Link href="/login">Login karo</Link></span>
          </div>
          <p className="hint" style={{ margin: 0 }}>Hum sirf nickname, emblem aur score rakhte hain. Email ya phone number nahi maangte.</p>
        </form>
      </main>
    </div>
  );
}
