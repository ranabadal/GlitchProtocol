import * as THREE from "three";

/*
 * Every texture in the game is drawn at load time on a <canvas>: no image downloads,
 * works offline, and keeps the project free of third-party artwork.
 */

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

function tex(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const GLYPHS = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ<>{}[]/\\|=+*#%$&?!@^~:;01ΣΔΩΨλπ∞≈≠";

/** 8 x 8 grid of glowing code glyphs, white on black (used in shaders as a mask). */
export function glyphAtlas(): THREE.CanvasTexture {
  const size = 512, cell = size / 8;
  const [c, g] = canvas(size, size);
  g.fillStyle = "#000";
  g.fillRect(0, 0, size, size);
  g.fillStyle = "#fff";
  g.font = `bold ${Math.floor(cell * 0.72)}px "Share Tech Mono", ui-monospace, monospace`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (let i = 0; i < 64; i++) {
    const ch = GLYPHS[i % GLYPHS.length];
    const x = (i % 8) * cell + cell / 2, y = Math.floor(i / 8) * cell + cell / 2;
    g.save();
    g.translate(x, y);
    if (i % 3 === 0) g.scale(-1, 1);
    g.fillText(ch, 0, 2);
    g.restore();
  }
  const t = tex(c, false);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Soft round blob (light pools, glows, smoke). */
export function radialTexture(inner = "rgba(255,255,255,1)", outer = "rgba(255,255,255,0)"): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.35, inner.replace(/[\d.]+\)$/, "0.45)"));
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return tex(c, false);
}

/** Neon name signs for every building with a lobby: a 2048 x 2048 atlas of 256 x 64 cells. */
export function signAtlas(names: string[]): { texture: THREE.CanvasTexture; slot: Map<string, number>; cols: number; rows: number } {
  const W = 2048, cw = 256, ch = 64, cols = W / cw, rows = W / ch;
  const [c, g] = canvas(W, W);
  g.fillStyle = "#000";
  g.fillRect(0, 0, W, W);
  const slot = new Map<string, number>();
  const hues = [150, 185, 320, 45, 275, 200];
  names.slice(0, cols * rows).forEach((name, i) => {
    slot.set(name, i);
    const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
    const hue = hues[i % hues.length];
    g.save();
    g.beginPath();
    g.rect(x + 4, y + 6, cw - 8, ch - 12);
    g.strokeStyle = `hsl(${hue} 100% 62%)`;
    g.lineWidth = 3;
    g.shadowColor = `hsl(${hue} 100% 60%)`;
    g.shadowBlur = 10;
    g.stroke();
    g.font = `700 ${name.length > 14 ? 24 : 30}px "Oxanium Variable", Oxanium, "Share Tech Mono", sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = `hsl(${hue} 100% 82%)`;
    g.fillText(name.toUpperCase(), x + cw / 2, y + ch / 2 + 1, cw - 20);
    g.restore();
  });
  return { texture: tex(c), slot, cols, rows };
}

const BILLBOARDS = [
  { top: "NULL IS WATCHING", bottom: "SURRENDER YOUR DATA", hue: 350 },
  { top: "CHAI 2.0", bottom: "AB ROBOT BHI PEETE HAIN", hue: 30 },
  { top: "GLITCH PROTOCOL", bottom: "OPERATORS WANTED", hue: 160 },
  { top: "NEON METRO", bottom: "NEXT TRAIN: ERROR 404", hue: 190 },
  { top: "BYTE BAZAAR", bottom: "50% OFF ON RAM", hue: 285 },
  { top: "STAY INSIDE", bottom: "NULL CURFEW ACTIVE", hue: 0 },
];

/** Big rooftop billboards: one atlas row per ad (1024 x 256 each). */
export function billboardAtlas(): { texture: THREE.CanvasTexture; count: number } {
  const W = 1024, H = 256 * BILLBOARDS.length;
  const [c, g] = canvas(W, H);
  BILLBOARDS.forEach((b, i) => {
    const y = i * 256;
    const grad = g.createLinearGradient(0, y, W, y + 256);
    grad.addColorStop(0, `hsl(${b.hue} 80% 12%)`);
    grad.addColorStop(1, `hsl(${(b.hue + 40) % 360} 80% 6%)`);
    g.fillStyle = grad;
    g.fillRect(0, y, W, 256);
    for (let k = 0; k < 256; k += 4) {
      g.fillStyle = "rgba(255,255,255,0.03)";
      g.fillRect(0, y + k, W, 1);
    }
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.shadowColor = `hsl(${b.hue} 100% 60%)`;
    g.shadowBlur = 24;
    g.fillStyle = `hsl(${b.hue} 100% 75%)`;
    g.font = `800 92px "Oxanium Variable", Oxanium, sans-serif`;
    g.fillText(b.top, W / 2, y + 100, W - 60);
    g.shadowBlur = 12;
    g.fillStyle = "#e8fff4";
    g.font = `600 44px "Oxanium Variable", Oxanium, sans-serif`;
    g.fillText(b.bottom, W / 2, y + 190, W - 80);
    g.shadowBlur = 0;
  });
  return { texture: tex(c), count: BILLBOARDS.length };
}

/** Generic text plate (vault names, uplink labels). */
export function textTexture(text: string, opts: { color?: string; bg?: string; w?: number; h?: number; font?: string } = {}): THREE.CanvasTexture {
  const w = opts.w ?? 512, h = opts.h ?? 128;
  const [c, g] = canvas(w, h);
  g.fillStyle = opts.bg ?? "rgba(0,0,0,0)";
  g.fillRect(0, 0, w, h);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = opts.color ?? "#3cff9a";
  g.shadowBlur = 16;
  g.fillStyle = opts.color ?? "#3cff9a";
  g.font = opts.font ?? `700 ${Math.floor(h * 0.5)}px "Oxanium Variable", Oxanium, sans-serif`;
  g.fillText(text, w / 2, h / 2, w - 20);
  return tex(c);
}

/** Small sprite for sparks/debris glow. */
export function sparkTexture(): THREE.CanvasTexture {
  return radialTexture("rgba(255,255,255,1)");
}

/** Hazard stripes for barricades. */
export function stripeTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 32);
  for (let i = -2; i < 10; i++) {
    g.fillStyle = i % 2 ? "#ff2a4a" : "#f2f2f2";
    g.beginPath();
    g.moveTo(i * 16, 32);
    g.lineTo(i * 16 + 16, 0);
    g.lineTo(i * 16 + 32, 0);
    g.lineTo(i * 16 + 16, 32);
    g.fill();
  }
  const t = tex(c);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
