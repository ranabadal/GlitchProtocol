"use client";

import { useEffect, useRef } from "react";
import type { HudState, MapMarker } from "@/game/types";
import { cityImage, drawMarker, drawPlayerArrow, drawRoute, MAP_PX, mapScale, MARKER_COLORS, toMap } from "./mapDraw";

type Pose = { x: number; z: number; heading: number; car: boolean } | null;

/** Rotating circular minimap (player always points up), redrawn every frame. */
export function Minimap({ hudRef, pose, vaultBuildings, size = 210 }: { hudRef: React.RefObject<HudState | null>; pose: () => Pose; vaultBuildings: string[]; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = c.height = size * dpr;
    const g = c.getContext("2d")!;
    const img = cityImage(vaultBuildings);
    let raf = 0;
    let zoom = 2.2;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const hud = hudRef.current;
      const p = pose();
      if (!hud || !p) return;
      const W = size * dpr, R = W / 2;
      const speed = hud.speedKmh / 3.6;
      zoom += ((p.car ? 1.5 - Math.min(0.5, speed / 80) : 2.3) - zoom) * 0.05;
      const k = (zoom * dpr) / mapScale;
      // Forward (sin h, cos h) in map space must point up the screen.
      const rot = -Math.PI / 2 - Math.atan2(Math.cos(p.heading), Math.sin(p.heading));
      const [px, pz] = toMap(p.x, p.z);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, W, W);
      g.save();
      g.beginPath(); g.arc(R, R, R - 2 * dpr, 0, Math.PI * 2); g.clip();
      g.fillStyle = "#010606"; g.fillRect(0, 0, W, W);
      g.translate(R, R); g.rotate(rot); g.scale(k, k); g.translate(-px, -pz);
      g.drawImage(img, 0, 0, MAP_PX, MAP_PX);
      drawRoute(g, hud.route.map((q) => toMap(q.x, q.z)), 3.2 / k * dpr);
      g.setTransform(1, 0, 0, 1, 0, 0);
      // Markers, upright; important ones stick to the rim when off-screen.
      const cos = Math.cos(rot), sin = Math.sin(rot);
      const screen = (m: MapMarker): [number, number] => {
        const [mx, mz] = toMap(m.x, m.z);
        const dx = (mx - px) * k, dz = (mz - pz) * k;
        return [R + dx * cos - dz * sin, R + dx * sin + dz * cos];
      };
      const order = ["robot", "turret", "fence", "barricade", "vault-done", "uplink", "vault"];
      const sorted = [...hud.markers].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
      for (const m of sorted) {
        let [x, y] = screen(m);
        const d = Math.hypot(x - R, y - R);
        const sticky = m.kind === "vault" || m.kind === "uplink";
        if (d > R - 12 * dpr) {
          if (!sticky) continue;
          x = R + ((x - R) / d) * (R - 12 * dpr);
          y = R + ((y - R) / d) * (R - 12 * dpr);
        }
        drawMarker(g, m, x, y, (m.kind === "robot" ? 7 : 8) * dpr, m.kind === "uplink" && hud.cores === hud.coresTotal);
      }
      g.restore();
      drawPlayerArrow(g, R, R, 0, 9 * dpr);
      // Rim with compass.
      g.strokeStyle = "rgba(60, 255, 154, 0.6)";
      g.lineWidth = 2 * dpr;
      g.beginPath(); g.arc(R, R, R - 2 * dpr, 0, Math.PI * 2); g.stroke();
      const nAng = rot - Math.PI / 2;
      g.fillStyle = "#ff3d6e";
      g.font = `700 ${12 * dpr}px "Oxanium Variable", sans-serif`;
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText("N", R + Math.cos(nAng) * (R - 11 * dpr), R + Math.sin(nAng) * (R - 11 * dpr));
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [hudRef, pose, vaultBuildings, size]);
  return <canvas ref={ref} style={{ width: size, height: size, display: "block", borderRadius: "50%", boxShadow: "0 0 24px rgba(60,255,154,0.25), inset 0 0 18px rgba(0,0,0,0.8)" }} aria-label="Minimap" />;
}

/** Full-screen city map (M / Tab). North up. */
export function BigMap({ hud, vaultBuildings, onClose }: { hud: HudState; vaultBuildings: string[]; onClose: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef(hud);
  hudRef.current = hud;
  useEffect(() => {
    const c = ref.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const S = Math.min(window.innerWidth * 0.62, window.innerHeight * 0.82);
    c.width = c.height = S * dpr;
    c.style.width = c.style.height = `${S}px`;
    const g = c.getContext("2d")!;
    const img = cityImage(vaultBuildings);
    const k = (S * dpr) / MAP_PX;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const h = hudRef.current;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(img, 0, 0, S * dpr, S * dpr);
      g.setTransform(k, 0, 0, k, 0, 0);
      drawRoute(g, h.route.map((q) => toMap(q.x, q.z)), 4 / k * dpr * 0.6);
      g.setTransform(1, 0, 0, 1, 0, 0);
      for (const m of h.markers) {
        const [x, y] = toMap(m.x, m.z);
        drawMarker(g, m, x * k, y * k, (m.kind === "robot" ? 6 : 10) * dpr, m.kind === "vault" || (m.kind === "uplink" && h.cores === h.coresTotal));
        if (m.label && (m.kind === "vault" || m.kind === "uplink" || m.kind === "vault-done")) {
          g.font = `600 ${12 * dpr}px Rajdhani, sans-serif`;
          g.fillStyle = MARKER_COLORS[m.kind];
          g.textAlign = "center";
          g.fillText(m.label, x * k, y * k + 22 * dpr);
        }
      }
      const [px, pz] = toMap(h.player.x, h.player.z);
      const ang = Math.atan2(Math.cos(h.player.heading), Math.sin(h.player.heading)) + Math.PI / 2;
      drawPlayerArrow(g, px * k, pz * k, ang, 11 * dpr);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [vaultBuildings]);
  return (
    <div className="bigmap" onClick={onClose}>
      <div className="bigmap-inner" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 10 }}>
          <b style={{ fontFamily: "var(--font-head)", letterSpacing: "0.2em" }}>NEON CITY · MAP</b>
          <span className="spacer" />
          <span className="muted mono" style={{ fontSize: 13 }}>M / Tab se band karo</span>
        </div>
        <canvas ref={ref} />
        <div className="row wrap" style={{ gap: 14, marginTop: 10, fontSize: 14 }}>
          <span><i className="lg" style={{ background: "#29d9ff" }} /> Vault</span>
          <span><i className="lg" style={{ background: "#3cff9a" }} /> Core mil gaya / Uplink</span>
          <span><i className="lg" style={{ background: "#ffd84a" }} /> Tumhara rasta</span>
          <span><i className="lg" style={{ background: "#ff4d4d" }} /> Barricade (rasta band)</span>
          <span><i className="lg" style={{ background: "#ff3d6e" }} /> Laser fence / robots</span>
        </div>
      </div>
    </div>
  );
}
