import type { RobotKind } from "../shared/mission";
import type { Band } from "./types";

/*
 * SCORING — documented rules, computed only on the server from validated events.
 *
 *   data core extracted  400
 *   hack, 1st try        150 + up to 150 for speed
 *   hack, 2nd try         75 + up to 75 for speed
 *   hack, 3rd try         40
 *   brute force            0  (after three failed hacks the vault opens by itself in 10 s)
 *   robot destroyed      walker 40, drone 30, brute 120, turret 80
 *   mission clear        1000 + 4 per second left on the clock
 *   flawless (no lives lost) 400
 * Every item is multiplied by the band: x1.0, x1.25, x1.5, x1.75, x2.0.
 * A failed mission keeps cores, hacks and robots, but gets no clear, time or flawless bonus.
 * XP = score (at least 50 for playing). Level = 1 + floor(sqrt(XP / 2000)).
 */

export const SCORING = {
  bandMultiplier: { 1: 1.0, 2: 1.25, 3: 1.5, 4: 1.75, 5: 2.0 } as Record<Band, number>,
  core: 400,
  hack: [
    { base: 150, speed: 150 },
    { base: 75, speed: 75 },
    { base: 40, speed: 0 },
  ],
  kill: { walker: 40, drone: 30, brute: 120, turret: 80 } as Record<RobotKind, number>,
  clear: 1000,
  perSecondLeft: 4,
  flawless: 400,
  minXp: 50,
  /** Allowance for network delay on timers. */
  graceMs: 2000,
  /** Most robots that can be destroyed within one second (an EMP blast can take out several). */
  maxKillsPerSecond: 10,
};

export function hackPoints(band: Band, attempt: number, elapsedMs: number, limitMs: number): number {
  const rule = SCORING.hack[attempt];
  if (!rule) return 0;
  const speedFrac = Math.max(0, Math.min(1, 1 - elapsedMs / limitMs));
  return Math.round((rule.base + rule.speed * speedFrac) * SCORING.bandMultiplier[band]);
}

export function corePoints(band: Band): number {
  return Math.round(SCORING.core * SCORING.bandMultiplier[band]);
}

export function killPoints(band: Band, kind: RobotKind): number {
  return Math.round(SCORING.kill[kind] * SCORING.bandMultiplier[band]);
}

export function clearBonuses(band: Band, secondsLeft: number, livesLost: number): { clear: number; time: number; flawless: number } {
  const m = SCORING.bandMultiplier[band];
  return {
    clear: Math.round(SCORING.clear * m),
    time: Math.round(Math.max(0, Math.floor(secondsLeft)) * SCORING.perSecondLeft * m),
    flawless: livesLost === 0 ? Math.round(SCORING.flawless * m) : 0,
  };
}

/** Cosmetic rating shown on the result screen. */
export function starsFor(cleared: boolean, livesLost: number): number {
  if (!cleared) return 0;
  if (livesLost === 0) return 3;
  return livesLost === 1 ? 2 : 1;
}

export function levelForXp(xp: number): number {
  return 1 + Math.floor(Math.sqrt(Math.max(0, xp) / 2000));
}

export function xpForLevel(level: number): number {
  return 2000 * (level - 1) ** 2;
}
