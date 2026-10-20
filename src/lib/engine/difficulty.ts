import type { Band } from "./types";

/*
 * ADAPTIVE DIFFICULTY — the documented rules. Shown to players on the Rules page.
 *
 * 1. Each player has a threat band from 1 (Rookie) to 5 (Legend).
 * 2. A brand-new player starts at band 1, the calibrated beginner mission.
 *    A player who has levelled up starts higher: level 4-6 -> band 2, level 7+ -> band 3.
 * 3. After a run of cleared missions the band goes up; after a run of failed ones it
 *    goes down. How long the run must be depends on the player's chosen pace.
 *    Running out of time or lives counts as a failure.
 * 4. After two failures in a row the briefing suggests a strategy tip and the hack
 *    timers get no easier: nothing is waived silently.
 * 5. Shared-event missions use the event's fixed band and do not change personal bands.
 * 6. Scoring never depends on adaptivity. The band used is stored on every attempt and
 *    shown on the leaderboard, which also ranks each band separately.
 */

export type DifficultyPref = "steady" | "balanced" | "bold";
export const DIFFICULTY_PREFS: DifficultyPref[] = ["steady", "balanced", "bold"];

export const PACE_RULES: Record<DifficultyPref, { promoteAfter: number; demoteAfter: number; label: string; summary: string }> = {
  steady: { promoteAfter: 3, demoteAfter: 2, label: "Steady", summary: "3 jeet lagatar pe band upar, 2 haar lagatar pe neeche." },
  balanced: { promoteAfter: 2, demoteAfter: 2, label: "Balanced", summary: "2 jeet lagatar pe band upar, 2 haar lagatar pe neeche." },
  bold: { promoteAfter: 1, demoteAfter: 3, label: "Bold", summary: "Har jeet pe band upar, 3 haar lagatar pe neeche." },
};

export const HINT_OFFER_AFTER_FAILS = 2;
export const MIN_BAND: Band = 1;
export const MAX_BAND: Band = 5;

export interface SkillState {
  band: Band;
  successStreak: number;
  failStreak: number;
  attempts: number;
  successes: number;
}

export function initialBand(level: number): Band {
  if (level >= 7) return 3;
  if (level >= 4) return 2;
  return 1;
}

export function freshSkill(level: number): SkillState {
  return { band: initialBand(level), successStreak: 0, failStreak: 0, attempts: 0, successes: 0 };
}

export interface BandChange {
  next: SkillState;
  change: "up" | "down" | "same";
}

export function applyOutcome(state: SkillState, success: boolean, pref: DifficultyPref): BandChange {
  const rule = PACE_RULES[pref] ?? PACE_RULES.balanced;
  const next: SkillState = { ...state, attempts: state.attempts + 1 };
  let change: BandChange["change"] = "same";
  if (success) {
    next.successes += 1;
    next.successStreak = state.successStreak + 1;
    next.failStreak = 0;
    if (next.successStreak >= rule.promoteAfter && state.band < MAX_BAND) {
      next.band = (state.band + 1) as Band;
      next.successStreak = 0;
      change = "up";
    }
  } else {
    next.failStreak = state.failStreak + 1;
    next.successStreak = 0;
    if (next.failStreak >= rule.demoteAfter && state.band > MIN_BAND) {
      next.band = (state.band - 1) as Band;
      next.failStreak = 0;
      change = "down";
    }
  }
  return { next, change };
}

/**
 * Practice weighting: tags from the player's recent mistakes, most frequent first.
 * Generation leans toward these (for example, more of the hack type they failed).
 */
export function focusTagsFrom(recentMistakes: string[][], limit = 2): string[] {
  const counts = new Map<string, number>();
  for (const tags of recentMistakes) for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([t]) => t);
}
