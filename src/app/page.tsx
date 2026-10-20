"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TopBar } from "@/components/Shell";
import { api } from "@/lib/client/api";

const FEATURES = [
  { k: "DRIVE", t: "Puri city tumhari", d: "Koi bhi gaadi uthao (F), neon sadkon pe race karo, barricades ke around rasta dhoondo.", c: "var(--cyan)" },
  { k: "FIGHT", t: "NULL ki robot army", d: "Walkers, drones, brutes aur turrets. Blaster se udao, EMP se rok do, ya gaadi se thok do!", c: "var(--red)" },
  { k: "HACK", t: "Vaults crack karo", d: "Har vault ke andar ek hologram hack: pattern todo, circuit jodo, nakli bot pakdo.", c: "var(--green)" },
];

export default function Welcome() {
  const [signedIn, setSignedIn] = useState<string | null>(null);
  useEffect(() => {
    api<{ signedIn: boolean; nickname?: string }>("/api/session").then((r) => setSignedIn(r.signedIn ? r.nickname ?? "" : null)).catch(() => {});
  }, []);

  return (
    <div className="page">
      <TopBar />
      <main className="container" style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "48px 0 40px" }}>
        <div className="rise" style={{ textAlign: "center" }}>
          <div className="chip red" style={{ marginBottom: 18, animation: "pulse 1.6s infinite" }}>⚠ ALERT · NULL NE NEON CITY HACK KAR LI HAI</div>
          <h1 className="glitch" data-text="GLITCH PROTOCOL" style={{ fontSize: "clamp(44px, 9vw, 112px)", lineHeight: 1 }}>GLITCH PROTOCOL</h1>
          <p style={{ fontSize: "clamp(18px, 2.4vw, 24px)", maxWidth: 720, margin: "18px auto 30px", color: "#bfe9d6" }}>
            Ek rogue AI ne city ka saara data vaults mein lock kar diya hai. Gaadi uthao, robots se lado, vaults hack karo
            aur data cores ko uplink tower tak pahunchao. <span className="green">City sirf tum bacha sakte ho, operator.</span>
          </p>
          <div className="row wrap" style={{ justifyContent: "center", gap: 14 }}>
            {signedIn !== null ? (
              <Link href="/hub" className="btn primary big">▶ Continue, {signedIn}</Link>
            ) : (
              <>
                <Link href="/register" className="btn primary big">▶ Mission shuru karo</Link>
                <Link href="/login" className="btn big cyan">Login</Link>
              </>
            )}
            <Link href="/rules" className="btn big amber">Kaise khelein?</Link>
          </div>
        </div>

        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", marginTop: 54 }}>
          {FEATURES.map((f, i) => (
            <div key={f.k} className="panel rise" style={{ animationDelay: `${0.15 + i * 0.1}s` }}>
              <div className="mono" style={{ color: f.c, letterSpacing: "0.3em", fontSize: 13 }}>{`0${i + 1} // ${f.k}`}</div>
              <h3 style={{ fontSize: 22, margin: "6px 0 8px" }}>{f.t}</h3>
              <p className="muted" style={{ margin: 0 }}>{f.d}</p>
            </div>
          ))}
        </div>
        <p className="mono muted" style={{ textAlign: "center", marginTop: 30, fontSize: 13 }}>
          Science Fair Edition · 3-5 minute missions · keyboard + mouse · har mission alag
        </p>
      </main>
    </div>
  );
}
