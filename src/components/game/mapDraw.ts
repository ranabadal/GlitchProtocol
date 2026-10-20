import { BLOCK, getCity, HALF, ROAD, SIZE } from "@/lib/shared/city";
import type { MapMarker } from "@/game/types";
import type { Pt } from "@/lib/shared/mission";

/*
 * Drawing for the minimap, the full-screen map and the briefing preview. The static
 * city is drawn once into an offscreen canvas; markers and the route are drawn live.
 */

export const MAP_PX = 1024;
const MARGIN = 10;
export const mapScale = MAP_PX / (SIZE + MARGIN * 2);
export const toMap = (x: number, z: number): [number, number] => [(x + HALF + MARGIN) * mapScale, (z + HALF + MARGIN) * mapScale];

let base: HTMLCanvasElement | null = null;

export function cityImage(vaultBuildings: string[] = []): HTMLCanvasElement {
  if (base && vaultBuildings.length === 0) return base;
  const c = document.createElement("canvas");
  c.width = c.height = MAP_PX;
  const g = c.getContext("2d")!;
  const city = getCity();
  g.fillStyle = "#020909";
  g.fillRect(0, 0, MAP_PX, MAP_PX);
  // Roads (everything that is not a block).
  g.fillStyle = "#0c1a1c";
  const [ox, oz] = toMap(-HALF, -HALF);
  g.fillRect(ox, oz, SIZE * mapScale, SIZE * mapScale);
  for (const b of city.blocks) {
    const [x, z] = toMap(b.x - BLOCK / 2, b.z - BLOCK / 2);
    const s = BLOCK * mapScale;
    g.fillStyle = b.kind === "park" ? "#06261a" : b.kind === "plaza" ? "#0a2420" : b.kind === "spire" ? "#2a0510" : "#081314";
    g.fillRect(x, z, s, s);
  }
  // Lane centre lines.
  g.strokeStyle = "rgba(255, 216, 74, 0.18)";
  g.lineWidth = 1;
  for (const e of city.edges) {
    const [x0, z0] = toMap(e.x0, e.z0), [x1, z1] = toMap(e.x1, e.z1);
    g.beginPath(); g.moveTo(x0, z0); g.lineTo(x1, z1); g.stroke();
  }
  // Buildings.
  const vaults = new Set(vaultBuildings);
  for (const b of city.buildings) {
    const [x, z] = toMap(b.x - b.w / 2, b.z - b.d / 2);
    const tall = Math.min(1, b.h / 140);
    g.fillStyle = vaults.has(b.id) ? "#0b3a44" : `rgb(${16 + tall * 18}, ${36 + tall * 30}, ${40 + tall * 30})`;
    g.fillRect(x, z, b.w * mapScale, b.d * mapScale);
    g.strokeStyle = vaults.has(b.id) ? "#29d9ff" : "rgba(60, 255, 154, 0.18)";
    g.lineWidth = vaults.has(b.id) ? 2 : 1;
    g.strokeRect(x + 0.5, z + 0.5, b.w * mapScale - 1, b.d * mapScale - 1);
  }
  // Spire.
  const sp = city.blocks.find((b) => b.kind === "spire")!;
  const [sx, sz] = toMap(sp.x, sp.z);
  g.fillStyle = "#ff3d6e";
  g.beginPath(); g.arc(sx, sz, 14 * mapScale, 0, Math.PI * 2); g.fill();
  // Map edge.
  g.strokeStyle = "rgba(60, 255, 154, 0.4)";
  g.lineWidth = 2;
  g.strokeRect(ox, oz, SIZE * mapScale, SIZE * mapScale);
  void ROAD;
  if (vaultBuildings.length === 0) base = c;
  return c;
}

export const MARKER_COLORS: Record<MapMarker["kind"], string> = {
  vault: "#29d9ff",
  "vault-done": "#3cff9a",
  uplink: "#3cff9a",
  start: "#a86bff",
  car: "#ffb229",
  robot: "#ff3d6e",
  barricade: "#ff4d4d",
  fence: "#ff3d6e",
  turret: "#ff7a3d",
};

/** Draw one marker icon at screen position (x, y), always upright. */
export function drawMarker(g: CanvasRenderingContext2D, m: MapMarker, x: number, y: number, s: number, active = false): void {
  const c = MARKER_COLORS[m.kind];
  g.save();
  g.translate(x, y);
  g.fillStyle = c;
  g.strokeStyle = c;
  g.shadowColor = c;
  g.shadowBlur = m.kind === "robot" ? 4 : 10;
  switch (m.kind) {
    case "vault": {
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, -s); g.lineTo(s, 0); g.lineTo(0, s); g.lineTo(-s, 0); g.closePath();
      g.fillStyle = "rgba(41, 217, 255, 0.25)"; g.fill(); g.stroke();
      g.fillStyle = c; g.fillRect(-s * 0.25, -s * 0.25, s * 0.5, s * 0.5);
      if (active) { g.globalAlpha = 0.5 + 0.5 * Math.sin(performance.now() / 200); g.beginPath(); g.arc(0, 0, s * 1.7, 0, Math.PI * 2); g.stroke(); }
      break;
    }
    case "vault-done": {
      g.lineWidth = 2.5;
      g.beginPath(); g.arc(0, 0, s * 0.8, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(-s * 0.4, 0); g.lineTo(-s * 0.1, s * 0.35); g.lineTo(s * 0.45, -s * 0.35); g.stroke();
      break;
    }
    case "uplink": {
      g.lineWidth = 2.5;
      g.beginPath(); g.arc(0, 0, s, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(0, -s * 0.7); g.lineTo(s * 0.5, s * 0.6); g.lineTo(-s * 0.5, s * 0.6); g.closePath(); g.fill();
      if (active) { g.globalAlpha = 0.5 + 0.5 * Math.sin(performance.now() / 200); g.beginPath(); g.arc(0, 0, s * 1.8, 0, Math.PI * 2); g.stroke(); }
      break;
    }
    case "robot": g.beginPath(); g.arc(0, 0, s * 0.32, 0, Math.PI * 2); g.fill(); break;
    case "turret": g.beginPath(); g.moveTo(0, -s * 0.5); g.lineTo(s * 0.45, s * 0.4); g.lineTo(-s * 0.45, s * 0.4); g.closePath(); g.fill(); break;
    case "barricade": g.lineWidth = 3; g.beginPath(); g.moveTo(-s * 0.6, -s * 0.6); g.lineTo(s * 0.6, s * 0.6); g.moveTo(s * 0.6, -s * 0.6); g.lineTo(-s * 0.6, s * 0.6); g.stroke(); break;
    case "fence": g.lineWidth = 2; g.setLineDash([3, 3]); g.beginPath(); g.arc(0, 0, s * 0.55, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); g.fillRect(-1.5, -1.5, 3, 3); break;
    case "start": g.fillRect(-s * 0.4, -s * 0.4, s * 0.8, s * 0.8); break;
    case "car": g.fillRect(-s * 0.5, -s * 0.3, s, s * 0.6); break;
  }
  g.restore();
}

export function drawPlayerArrow(g: CanvasRenderingContext2D, x: number, y: number, angle: number, s: number, color = "#eafff5"): void {
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  g.fillStyle = color;
  g.shadowColor = "#3cff9a";
  g.shadowBlur = 10;
  g.beginPath(); g.moveTo(0, -s); g.lineTo(s * 0.7, s * 0.8); g.lineTo(0, s * 0.35); g.lineTo(-s * 0.7, s * 0.8); g.closePath(); g.fill();
  g.restore();
}

export function drawRoute(g: CanvasRenderingContext2D, pts: [number, number][], width: number): void {
  if (pts.length < 2) return;
  g.save();
  g.lineJoin = "round";
  g.lineCap = "round";
  g.strokeStyle = "rgba(255, 216, 74, 0.25)";
  g.lineWidth = width * 2.6;
  g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
  g.strokeStyle = "#ffd84a";
  g.shadowColor = "#ffd84a";
  g.shadowBlur = 8;
  g.lineWidth = width;
  g.setLineDash([width * 2.2, width * 1.2]);
  g.lineDashOffset = -performance.now() / 40;
  g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
  g.restore();
}

export type { Pt };
