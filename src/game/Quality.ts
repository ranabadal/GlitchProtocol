import type * as THREE from "three";
import type { QualityLevel } from "./types";

/*
 * Graphics tiers. Normal school laptops (integrated Intel/AMD graphics) get "medium";
 * the game also watches its own frame rate and steps down if it struggles.
 */

export interface QualitySettings {
  level: QualityLevel;
  pixelRatio: number;
  antialias: boolean;
  bloom: boolean;
  shadows: boolean;
  crowd: number;
  traffic: number;
  rainParticles: number;
  farClip: number;
  lights: boolean;
}

export const QUALITY: Record<QualityLevel, QualitySettings> = {
  low: { level: "low", pixelRatio: 0.75, antialias: false, bloom: false, shadows: false, crowd: 14, traffic: 9, rainParticles: 500, farClip: 360, lights: false },
  medium: { level: "medium", pixelRatio: 1, antialias: false, bloom: true, shadows: false, crowd: 26, traffic: 15, rainParticles: 1200, farClip: 460, lights: true },
  high: { level: "high", pixelRatio: 1.5, antialias: true, bloom: true, shadows: true, crowd: 40, traffic: 22, rainParticles: 2200, farClip: 560, lights: true },
};

const KEY = "gp-quality";

export function savedQuality(): QualityLevel | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "low" || v === "medium" || v === "high" ? v : null;
  } catch {
    return null;
  }
}

export function saveQuality(q: QualityLevel): void {
  try { localStorage.setItem(KEY, q); } catch { /* storage blocked */ }
}

/** Guess a starting tier from the GPU name. */
export function detectQuality(renderer: THREE.WebGLRenderer): QualityLevel {
  const saved = savedQuality();
  if (saved) return saved;
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).toLowerCase();
    if (/swiftshader|llvmpipe|software|basic render/.test(name)) return "low";
    if (/nvidia|geforce|rtx|gtx|radeon rx|radeon pro|apple m[1-9]|arc a/.test(name)) return "high";
    return "medium";
  } catch {
    return "medium";
  }
}

export function lowerQuality(q: QualityLevel): QualityLevel | null {
  return q === "high" ? "medium" : q === "medium" ? "low" : null;
}
