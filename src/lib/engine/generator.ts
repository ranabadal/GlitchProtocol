import { deriveSeed, Rng } from "./rng";
import { cityHeist } from "./templates/cityHeist";
import type { GeneratedMission, GenInputs, MissionTemplate, TemplateId } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTemplate = MissionTemplate<any, any>;

export const TEMPLATES: Record<TemplateId, AnyTemplate> = {
  "city-heist": cityHeist,
};

export function getTemplate(id: string): AnyTemplate | null {
  return (TEMPLATES as Record<string, AnyTemplate>)[id] ?? null;
}

/** Upper bound on candidates tried for one mission. */
export const MAX_GENERATION_ATTEMPTS = 30;
/** For the first few tries, also avoid repeating the shape of the player's last mission. */
const VARIANT_AVOID_ATTEMPTS = 6;

export type AttemptResult = { ok: true; puzzle: GeneratedMission } | { ok: false; reason: string };

/**
 * Build and validate ONE candidate. A pure function of (template, seed, attempt, inputs):
 * calling it again with the stored values recreates the identical mission.
 */
export function generateFromSeed(template: AnyTemplate, seed: string, attempt: number, inputs: GenInputs): AttemptResult {
  const rng = new Rng(deriveSeed(seed, template.id, `v${template.version}`, attempt));
  let puzzle: GeneratedMission | null;
  try {
    puzzle = template.generateCandidate(rng, inputs);
  } catch (err) {
    return { ok: false, reason: `generator error: ${(err as Error).message}` };
  }
  if (!puzzle) return { ok: false, reason: "draw unusable" };
  const v = template.validate(puzzle);
  if (!v.ok) return { ok: false, reason: v.reason };
  return { ok: true, puzzle };
}

export interface PlayHistory {
  /** fingerprint -> time it was last assigned to this player */
  fingerprints: Map<string, number>;
  /** variants of this player's recent missions, newest first */
  recentVariants: string[];
}

export type SelectionStatus = "fresh" | "fresh-repeated-shape" | "pool-exhausted";

export interface Selection {
  puzzle: GeneratedMission;
  attempt: number;
  status: SelectionStatus;
  rejected: { attempt: number; reason: string }[];
}

export class GenerationError extends Error {
  constructor(message: string, public rejected: { attempt: number; reason: string }[]) {
    super(message);
  }
}

/**
 * Pick the first valid candidate the player has not seen. Invalid candidates are
 * rejected and the next attempt is tried, up to a fixed bound. If every valid
 * candidate was already played (pool exhausted), the one played longest ago is reused.
 */
export function selectInstance(
  template: AnyTemplate,
  seed: string,
  inputs: GenInputs,
  history: PlayHistory = { fingerprints: new Map(), recentVariants: [] },
  maxAttempts = MAX_GENERATION_ATTEMPTS,
): Selection {
  const rejected: { attempt: number; reason: string }[] = [];
  const sameShape: { attempt: number; puzzle: GeneratedMission }[] = [];
  const repeats: { attempt: number; puzzle: GeneratedMission; lastPlayed: number }[] = [];
  const lastVariant = history.recentVariants[0];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const r = generateFromSeed(template, seed, attempt, inputs);
    if (!r.ok) { rejected.push({ attempt, reason: r.reason }); continue; }
    const seenAt = history.fingerprints.get(r.puzzle.fingerprint);
    if (seenAt !== undefined) { repeats.push({ attempt, puzzle: r.puzzle, lastPlayed: seenAt }); continue; }
    if (lastVariant && r.puzzle.variant === lastVariant && attempt < VARIANT_AVOID_ATTEMPTS) {
      sameShape.push({ attempt, puzzle: r.puzzle });
      continue;
    }
    return { puzzle: r.puzzle, attempt, status: "fresh", rejected };
  }
  if (sameShape.length) return { ...sameShape[0], status: "fresh-repeated-shape", rejected };
  if (repeats.length) {
    repeats.sort((a, b) => a.lastPlayed - b.lastPlayed || a.attempt - b.attempt);
    return { puzzle: repeats[0].puzzle, attempt: repeats[0].attempt, status: "pool-exhausted", rejected };
  }
  throw new GenerationError(`no valid ${template.id} instance in ${maxAttempts} attempts`, rejected);
}
