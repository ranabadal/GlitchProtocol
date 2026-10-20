import { glitchHack } from "./glitch";
import { imposterHack } from "./imposter";
import { powerHack } from "./power";
import type { HackModule, HackType } from "./types";

export * from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyHack = HackModule<any, any, any>;

export const HACKS: Record<HackType, AnyHack> = {
  glitch: glitchHack,
  power: powerHack,
  imposter: imposterHack,
};
