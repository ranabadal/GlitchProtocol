import type { Rng } from "../rng";

/*
 * The three challenge types from the original brief, now used as quick hacking
 * hurdles inside the 3D mission:
 *   glitch   -> Pattern Breaker        ("Data Stream Breach": find the corrupted node)
 *   power    -> System Override        ("Firewall Bypass": rotate circuits to route power)
 *   imposter -> Spot the Contradiction ("Identity Scan": find the fake security bot)
 */
export type HackType = "glitch" | "power" | "imposter";
export const HACK_TYPES: HackType[] = ["glitch", "power", "imposter"];

/** Hack difficulty 1-3, derived from the mission band. */
export type HackBand = 1 | 2 | 3;

export type Validation = { ok: true } | { ok: false; reason: string };

export interface BuiltHack<R, K> {
  round: R;
  key: K;
  /** Skill tag used for practice weighting when this hack is failed. */
  tag: string;
  /** Short Hinglish explanation shown after the hack. */
  explain: string;
}

export interface HackModule<R = unknown, K = unknown, P = unknown> {
  type: HackType;
  title: string;
  challenge: string;
  instruction: string;
  timeLimitMs(band: HackBand): number;
  build(rng: Rng, band: HackBand, focus: string[]): BuiltHack<R, K> | null;
  /** Independent check that the round is well formed and has exactly one answer. */
  validate(round: R, key: K): Validation;
  parsePick(raw: unknown, round: R): P | null;
  judge(key: K, pick: P, round: R): { correct: boolean; reveal: unknown };
  /** Solve from public data alone. Used by tests and the event-day journey check. */
  solve(round: R): P;
  /** Hash input describing the round's logic (not cosmetics). */
  fingerprintInput(round: R): string;
}
