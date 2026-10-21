/*
 * Player preferences kept in this browser: how bright the city is, mouse feel and the
 * spoken voice lines. Read once when a game starts; the pause menu changes them live.
 */

export type LightMode = "day" | "dusk" | "night";

export interface GameSettings {
  light: LightMode;
  /** Mouse sensitivity multiplier, 0.4 .. 2.2. */
  sensitivity: number;
  invertY: boolean;
  /** Hero quips and NULL's taunts spoken out loud. */
  voices: boolean;
  /** Hold Shift to run (false) or tap Shift to toggle running (true). */
  toggleRun: boolean;
}

const KEY = "gp-settings";
export const DEFAULT_SETTINGS: GameSettings = { light: "day", sensitivity: 1, invertY: false, voices: true, toggleRun: false };

export function loadSettings(): GameSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<GameSettings>;
    const light: LightMode = raw.light === "dusk" || raw.light === "night" ? raw.light : "day";
    const sensitivity = typeof raw.sensitivity === "number" && raw.sensitivity >= 0.4 && raw.sensitivity <= 2.2 ? raw.sensitivity : 1;
    return { light, sensitivity, invertY: raw.invertY === true, voices: raw.voices !== false, toggleRun: raw.toggleRun === true };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: GameSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage blocked */ }
}

/** Light presets: 0 = night, 0.5 = sunset, 1 = full day. */
export const DAYLIGHT: Record<LightMode, number> = { day: 1, dusk: 0.5, night: 0 };

export interface LightPreset {
  day: number;
  hemiSky: number; hemiGround: number; hemi: number;
  sun: number; sunI: number; sunPos: [number, number, number];
  fog: number; fogDensity: number; fogDensityLow: number;
  exposure: number; env: number;
  bloomStrength: number; bloomThreshold: number;
}

export const LIGHTS: Record<LightMode, LightPreset> = {
  day: {
    day: 1, hemiSky: 0xd8ecff, hemiGround: 0x6d665c, hemi: 1.55,
    sun: 0xfff3dd, sunI: 2.7, sunPos: [90, 170, -70],
    fog: 0xb9d2e4, fogDensity: 0.0021, fogDensityLow: 0.0034,
    exposure: 1.0, env: 0.9, bloomStrength: 0.28, bloomThreshold: 1.55,
  },
  dusk: {
    day: 0.5, hemiSky: 0xffc39a, hemiGround: 0x3a3048, hemi: 1.05,
    sun: 0xffa266, sunI: 1.9, sunPos: [140, 55, -110],
    fog: 0x8a6f86, fogDensity: 0.0029, fogDensityLow: 0.0045,
    exposure: 1.05, env: 0.7, bloomStrength: 0.42, bloomThreshold: 1.05,
  },
  night: {
    day: 0, hemiSky: 0x2a4258, hemiGround: 0x07090c, hemi: 0.7,
    sun: 0x9fb8ff, sunI: 0.7, sunPos: [60, 120, -90],
    fog: 0x03090b, fogDensity: 0.0042, fogDensityLow: 0.0062,
    exposure: 1.05, env: 0.45, bloomStrength: 0.55, bloomThreshold: 0.9,
  },
};
