import type { Rng } from "./rng";

export type TemplateId = "city-heist";
export const TEMPLATE_IDS: TemplateId[] = ["city-heist"];

export type Band = 1 | 2 | 3 | 4 | 5;
export const BANDS: Band[] = [1, 2, 3, 4, 5];

/** Everything that, together with the seed, decides a mission. Stored with each instance. */
export interface GenInputs {
  band: Band;
  /** Skill tags the player recently missed; generation leans toward them for practice. */
  focusTags: string[];
}

export interface GeneratedMission<P = unknown, K = unknown> {
  /** Coarse shape of the mission, used to avoid back-to-back look-alikes. */
  variant: string;
  /** Skills this mission exercises. */
  tags: string[];
  /** Safe to send to the browser. */
  publicPuzzle: P;
  /** Server-only (hack puzzles and answers). */
  answerKey: K;
  /** Hash of the mission's logical layout. Story text and cosmetics are excluded. */
  fingerprint: string;
  timeLimitSec: number;
}

export type Validation = { ok: true } | { ok: false; reason: string };

export interface MissionTemplate<P = unknown, K = unknown> {
  id: TemplateId;
  version: number;
  title: string;
  generateCandidate(rng: Rng, inputs: GenInputs): GeneratedMission<P, K> | null;
  /** Independent check that the mission is fair and completable. */
  validate(m: GeneratedMission<P, K>): Validation;
}

export const BAND_LABELS: Record<Band, string> = {
  1: "Rookie",
  2: "Cadet",
  3: "Agent",
  4: "Elite",
  5: "Legend",
};

/** Bump when scoring, timing or validation rules change. Stored on every instance and attempt. */
export const RULESET_VERSION = "gp-city-4.0.0";
