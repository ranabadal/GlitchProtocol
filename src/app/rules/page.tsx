"use client";

import Link from "next/link";
import { TopBar, useMe } from "@/components/Shell";

const CONTROLS: [string, string][] = [
  ["W A S D / Arrows", "Chalo, gaadi chalao, helicopter udao"], ["Mouse", "Camera ghumao, nishana lagao"], ["Left click", "Haath ka weapon chalao"],
  ["Right click", "Aim / zoom"], ["1 2 3 4 / wheel", "Blaster · Scatter gun · Plasma bomb · Energy blade"], ["V", "Thappad! Robot ud jaata hai (koi bhi weapon ho)"],
  ["Shift (dabake rakho)", "Tez daudo / sprint (stamina), gaadi mein nitro, heli neeche"], ["Space", "Jump, handbrake (drift!), heli upar"], ["C", "Dodge roll: goliyon se bacho"],
  ["F", "Gaadi / helicopter / Skyline Metro mein baitho ya utro"], ["E", "Vault terminal hack karo"], ["Q", "EMP blast: paas ke robots ruk jaate hain, drones gir jaate hain"],
  ["M / Tab", "Pura map"], ["H", "Horn"], ["Esc", "Pause + settings (Din/Shaam/Raat, mouse speed, awaazein)"],
];

const STEPS = [
  { t: "Vaults dhoondo", d: "Minimap pe neeli diamond vaults hain. Peeli line sabse chhota rasta dikhati hai (barricades ke around)." },
  { t: "Robots se lado", d: "Vault ke bahar aur andar NULL ke robots hain. Blaster, EMP ya gaadi se thok do. Health apne aap wapas aati hai." },
  { t: "Terminal hack karo", d: "Vault lobby ke andar terminal pe E dabao. 10-16 second ka hologram hack aayega. Galat hua to alarm: aur robots aayenge." },
  { t: "Core uthao", d: "Hack hote hi shield khulta hai. Core ke paas jao, wo apne aap uth jayega. 3 baar fail? Vault 10 second mein khud khulega." },
  { t: "Uplink pe upload", d: "Saare cores lekar hari uplink tower ke ring mein khade raho jab tak upload 100% na ho. Robots ki lehrein aayengi!" },
  { t: "Har mission alag", d: "Titan Hunt: ek vault ka lock 6 meter ke TITAN ke paas hai, use giraao. Data Truck Chase: NULL ka truck core le ke ghoomta hai, peecha karke todo. Blitz: dono! Sunehre data shards bonus dete hain." },
];

const HACKS = [
  { t: "Data Stream Breach", s: "Pattern Breaker", d: "Nodes ki line ek pattern follow karti hai (colour, shape, size ya number). Jo node pattern tod raha hai, us pe click karo. Keyboard: 1-9 ya arrows + Enter." },
  { t: "Firewall Bypass", s: "System Override", d: "Circuit tiles ko click karke ghumao jab tak bijli left ke ⚡ se right ke 🔒 tak na pahunch jaaye. Rasta jud gaya to apne aap submit hota hai." },
  { t: "Identity Scan", s: "Spot the Contradiction", d: "Saare security bots ek jaise hone chahiye. Ek nakli hai: uska ek hissa alag hai (aankhen, antenna, muh, colour ya chest light)." },
];

export default function Rules() {
  const { me } = useMe(false);
  return (
    <div className="page">
      <TopBar me={me} />
      <main className="container" style={{ padding: "28px 0 60px" }}>
        <div className="stack" style={{ gap: 18 }}>
          <div className="panel rise">
            <div className="panel-title">Mission kaise khelein</div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
              {STEPS.map((s, i) => (
                <div key={s.t} style={{ padding: 12, border: "1px solid var(--line)", background: "rgba(0,0,0,0.3)" }}>
                  <div className="mono green" style={{ fontSize: 13 }}>STEP {i + 1}</div>
                  <b style={{ fontFamily: "var(--font-head)", fontSize: 18 }}>{s.t}</b>
                  <p className="muted" style={{ margin: "6px 0 0", fontSize: 15 }}>{s.d}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 18 }}>
            <div className="panel cyan rise" style={{ animationDelay: "0.06s" }}>
              <div className="panel-title" style={{ color: "var(--cyan)" }}>Controls (keyboard + mouse)</div>
              <div className="stack" style={{ gap: 8 }}>
                {CONTROLS.map(([k, d]) => <div key={k} className="row" style={{ gap: 12 }}><span className="kbd" style={{ minWidth: 120 }}>{k}</span><span>{d}</span></div>)}
              </div>
            </div>
            <div className="panel rise" style={{ animationDelay: "0.1s" }}>
              <div className="panel-title">Hacks (teeno challenge types)</div>
              <div className="stack" style={{ gap: 12 }}>
                {HACKS.map((h) => <div key={h.t}><b style={{ fontFamily: "var(--font-head)" }}>{h.t}</b> <span className="chip">{h.s}</span><p className="muted" style={{ margin: "4px 0 0" }}>{h.d}</p></div>)}
              </div>
            </div>
          </div>
          <div className="panel cyan rise" style={{ animationDelay: "0.12s" }}>
            <div className="panel-title" style={{ color: "var(--cyan)" }}>Multiplayer race (dosto ke saath)</div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 }}>
              {[
                ["1. Room banao", "Hub mein Solo race (2–4 players) ya Team race (Team A vs Team B) dabao. Ek 5 letter ka code milega."],
                ["2. Dost join karein", "Dusre laptops pe login karke Hub → Join room mein code daalo. Team race mein apni team chuno."],
                ["3. Race!", "Host START dabata hai. Sabko same mission milta hai, sab ek doosre ko city mein dekhte hain (naam ke saath)."],
                ["4. Jeeto", "Solo: jo sabse pehle upload complete kare wo jeeta. Team: sab members ke points jud ke, pehle finish karne wale ki team ko +1000."],
              ].map(([t, d]) => (
                <div key={t} style={{ padding: 12, border: "1px solid var(--line)", background: "rgba(0,0,0,0.3)" }}>
                  <b style={{ fontFamily: "var(--font-head)", fontSize: 17 }}>{t}</b>
                  <p className="muted" style={{ margin: "6px 0 0", fontSize: 15 }}>{d}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="panel rise" style={{ animationDelay: "0.14s" }}>
            <div className="panel-title">Scoring (server pe calculate hota hai)</div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 8 }}>
              {[["Data core", "400"], ["Hack 1st try", "150 + speed bonus 150 tak"], ["Hack 2nd try", "75 + speed bonus 75 tak"], ["Hack 3rd try", "40"], ["Robot", "Walker 40 · Drone 30 · Brute 120 · Turret 80"], ["Mission clear", "1000 + har bache second ke 4"], ["Flawless (koi life nahi gayi)", "400"], ["Threat multiplier", "Rookie x1 · Cadet x1.25 · Agent x1.5 · Elite x1.75 · Legend x2"]].map(([k, v]) => (
                <div key={k} className="row" style={{ justifyContent: "space-between", padding: "6px 10px", background: "rgba(0,0,0,0.3)" }}><span>{k}</span><b className="green" style={{ textAlign: "right" }}>{v}</b></div>
              ))}
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>Har mission naya banta hai (alag vaults, raste, hacks) aur server check karta hai ki wo jeetne layak hai. Tumhara score sirf server ke validated events se banta hai. Har jeet ke baad threat level badh sakta hai, haar ke baad kam.</p>
          </div>
          <div className="row"><Link href={me ? "/hub" : "/register"} className="btn primary big">▶ {me ? "Hub mein chalo" : "Operator banao"}</Link></div>
        </div>
      </main>
    </div>
  );
}
