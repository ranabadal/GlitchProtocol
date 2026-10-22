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
    // Strong sun + soft sky light from the environment map: real contrast and shadows.
    day: 1, hemiSky: 0xcfe3ff, hemiGround: 0x5a554d, hemi: 0.6,
    sun: 0xfff1dc, sunI: 3.4, sunPos: [95, 150, -80],
    fog: 0xbcd0e0, fogDensity: 0.0016, fogDensityLow: 0.0028,
    exposure: 0.95, env: 1.0, bloomStrength: 0.22, bloomThreshold: 1.6,
  },
  dusk: {
    day: 0.5, hemiSky: 0xffb48a, hemiGround: 0x3a3048, hemi: 0.55,
    sun: 0xff9a55, sunI: 3.0, sunPos: [150, 48, -110],
    fog: 0x9a7a88, fogDensity: 0.0024, fogDensityLow: 0.004,
    exposure: 1.0, env: 0.85, bloomStrength: 0.4, bloomThreshold: 1.1,
  },
  night: {
    day: 0, hemiSky: 0x2a4258, hemiGround: 0x07090c, hemi: 0.7,
    sun: 0x9fb8ff, sunI: 0.7, sunPos: [60, 120, -90],
    fog: 0x03090b, fogDensity: 0.0042, fogDensityLow: 0.0062,
    exposure: 1.05, env: 0.45, bloomStrength: 0.55, bloomThreshold: 0.9,
  },
};
