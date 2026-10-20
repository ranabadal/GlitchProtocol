"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Loading, TopBar, useMe } from "@/components/Shell";
import { AVATARS } from "@/lib/avatars";
import { api, type Me } from "@/lib/client/api";

const PACE = [
  { id: "steady", t: "Steady", d: "3 jeet lagatar pe threat badhega, 2 haar pe kam." },
  { id: "balanced", t: "Balanced", d: "2 jeet pe threat badhega, 2 haar pe kam." },
  { id: "bold", t: "Bold", d: "Har jeet pe threat badhega, 3 haar pe kam." },
];

export default function Profile() {
  const router = useRouter();
  const { me, setMe } = useMe();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [nick, setNick] = useState<string | null>(null);
  const [delPw, setDelPw] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  if (!me) return <div className="page"><TopBar /><main className="container"><Loading /></main></div>;
  const u = me.user;

  async function patch(body: Record<string, unknown>, ok = "Save ho gaya!") {
    setBusy(true);
    setMsg(null);
    try { setMe(await api<Me>("/api/profile", { method: "PATCH", json: body })); setMsg({ ok: true, text: ok }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Save nahi hua." }); }
    finally { setBusy(false); }
  }

  async function upload(file: File) {
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.append("photo", file);
    try { setMe(await api<Me>("/api/profile/photo", { method: "POST", body: fd, timeoutMs: 30000 })); setMsg({ ok: true, text: "Photo upload ho gayi. Dikhani hai to neeche switch on karo." }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Upload nahi hua." }); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  async function removePhoto() {
    setBusy(true);
    try { setMe(await api<Me>("/api/profile/photo", { method: "DELETE" })); setMsg({ ok: true, text: "Photo hata di gayi." }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Nahi hua." }); }
    finally { setBusy(false); }
  }

  async function deleteAccount() {
    if (!confirm("Pakka? Tumhara account, scores aur photo hamesha ke liye delete ho jayenge.")) return;
    try { await api("/api/account", { method: "DELETE", json: { password: delPw } }); router.push("/"); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Delete nahi hua." }); }
  }

  return (
    <div className="page">
      <TopBar me={me} />
      <main className="container" style={{ maxWidth: 860, padding: "28px 0 60px" }}>
        <div className="stack" style={{ gap: 18 }}>
          {msg && <div className={msg.ok ? "ok-box" : "error-box"} role="status">{msg.text}</div>}
          <div className="panel rise">
            <div className="panel-title">Identity</div>
            <div className="row wrap" style={{ gap: 20 }}>
              <Avatar id={u.avatarId} photoUrl={u.showPhoto ? u.photoUrl : null} size={100} />
              <div className="stack" style={{ flex: 1, minWidth: 240 }}>
                <div className="field">
                  <label htmlFor="nick">Nickname</label>
                  <div className="row"><input id="nick" className="input" style={{ flex: 1 }} value={nick ?? u.nickname} onChange={(e) => setNick(e.target.value)} maxLength={16} /><button className="btn" disabled={busy || !nick || nick === u.nickname} onClick={() => patch({ nickname: nick })}>Save</button></div>
                </div>
                <div className="muted mono">Participant ID: <span className="green">{u.participantId}</span></div>
              </div>
            </div>
            <div className="field" style={{ marginTop: 16 }}>
              <label>Emblem (visor ka colour)</label>
              <div className="row wrap" style={{ gap: 8 }}>
                {AVATARS.map((a) => (
                  <button key={a.id} onClick={() => patch({ avatarId: a.id }, "Emblem badal gaya!")} disabled={busy} style={{ background: "none", padding: 3, cursor: "pointer", border: u.avatarId === a.id ? `2px solid hsl(${a.hue} 100% 60%)` : "2px solid transparent" }} aria-label={a.name}>
                    <Avatar id={a.id} size={52} />
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="panel rise" style={{ animationDelay: "0.06s" }}>
            <div className="panel-title">Photo (optional)</div>
            <p className="muted" style={{ marginTop: 0 }}>Photo sirf tab dusron ko dikhegi jab tum switch on karoge. Upload karte waqt location aur camera details hata diye jaate hain. Max 3 MB (JPG/PNG/WebP).</p>
            <div className="row wrap">
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
              <button className="btn cyan" disabled={busy} onClick={() => fileRef.current?.click()}>{u.photoUrl ? "Photo badlo" : "Photo upload karo"}</button>
              {u.photoUrl && <button className="btn red" disabled={busy} onClick={removePhoto}>Photo hatao</button>}
              {u.photoUrl && (
                <label className="row" style={{ gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={u.showPhoto} onChange={(e) => patch({ showPhoto: e.target.checked })} disabled={busy} />
                  <span>Leaderboard pe photo dikhao</span>
                </label>
              )}
            </div>
          </div>

          <div className="panel rise" style={{ animationDelay: "0.1s" }}>
            <div className="panel-title">Difficulty pace</div>
            <p className="muted" style={{ marginTop: 0 }}>Threat level (1-5) tumhare results se apne aap badalta hai. Ye rules hamesha same hain aur yahan dikhte hain.</p>
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
              {PACE.map((p) => (
                <button key={p.id} className={`btn ${u.difficultyPref === p.id ? "primary" : ""}`} style={{ flexDirection: "column", alignItems: "flex-start", textAlign: "left", textTransform: "none", letterSpacing: 0, minHeight: 80 }} onClick={() => patch({ difficultyPref: p.id }, "Pace update ho gaya.")} disabled={busy}>
                  <b style={{ fontSize: 16, textTransform: "uppercase", letterSpacing: "0.1em" }}>{p.t}</b>
                  <span style={{ fontFamily: "var(--font-body)", fontWeight: 500, fontSize: 14 }}>{p.d}</span>
                </button>
              ))}
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>Abhi: Threat {me.skill.band} ({me.skill.bandLabel}) · {me.skill.successes}/{me.skill.attempts} missions jeete</p>
          </div>

          <div className="panel red rise" style={{ animationDelay: "0.14s" }}>
            <div className="panel-title" style={{ color: "var(--red)" }}>Account delete</div>
            <div className="row wrap">
              <input className="input" type="password" placeholder="Password" value={delPw} onChange={(e) => setDelPw(e.target.value)} autoComplete="current-password" />
              <button className="btn red" disabled={!delPw} onClick={deleteAccount}>Hamesha ke liye delete</button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
