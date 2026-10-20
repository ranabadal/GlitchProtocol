"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { TopBar } from "@/components/Shell";
import { api, ApiError } from "@/lib/client/api";

export default function Login() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", json: { identifier, password } });
      router.push("/hub");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login nahi ho paaya.");
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <TopBar />
      <main className="container" style={{ maxWidth: 480, padding: "70px 0" }}>
        <form className="panel cyan rise stack" onSubmit={submit} style={{ gap: 18 }}>
          <div className="panel-title" style={{ color: "var(--cyan)" }}>Operator login</div>
          <h1 style={{ fontSize: 30 }}>Wapas aao, operator</h1>
          <div className="field">
            <label htmlFor="id">Nickname ya Participant ID</label>
            <input id="id" className="input" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" required />
          </div>
          <div className="field">
            <label htmlFor="pw">Password</label>
            <input id="pw" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </div>
          {error && <div className="error-box" role="alert">{error}</div>}
          <button className="btn primary big cyan" disabled={busy}>{busy ? "Connect ho raha hai..." : "▶ Login"}</button>
          <p className="hint" style={{ margin: 0 }}>Naya ho? <Link href="/register">Operator banao</Link>. Password bhool gaye? Event operator se reset karwao.</p>
        </form>
      </main>
    </div>
  );
}
