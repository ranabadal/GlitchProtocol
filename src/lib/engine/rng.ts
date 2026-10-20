import { createHash, randomBytes } from "node:crypto";

/** A fresh 128-bit seed from the server's cryptographic random source. */
export function newSeed(): string {
  return randomBytes(16).toString("hex");
}

/** Derive a child seed deterministically, e.g. deriveSeed(base, "city-heist", 3). */
export function deriveSeed(base: string, ...parts: (string | number)[]): string {
  return createHash("sha256").update([base, ...parts].join(":")).digest("hex").slice(0, 32);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Seeded pseudo-random generator (sfc32 seeded from SHA-256). Pure 32-bit integer
 * arithmetic, so the same seed produces the same stream on every machine.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: string) {
    const h = createHash("sha256").update(seed).digest();
    this.a = h.readUInt32LE(0);
    this.b = h.readUInt32LE(4);
    this.c = h.readUInt32LE(8);
    this.d = h.readUInt32LE(12);
    for (let i = 0; i < 15; i++) this.nextUint32();
  }

  nextUint32(): number {
    this.a >>>= 0; this.b >>>= 0; this.c >>>= 0; this.d >>>= 0;
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.nextUint32() / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.float() * (max - min);
  }

  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    if (max < min) throw new Error(`Rng.int: empty range ${min}..${max}`);
    return min + Math.floor(this.float() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.float() < p;
  }

  sign(): 1 | -1 {
    return this.chance(0.5) ? 1 : -1;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick: empty list");
    return items[this.int(0, items.length - 1)];
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  weighted<T>(entries: readonly { item: T; weight: number }[]): T {
    const total = entries.reduce((s, e) => s + Math.max(0, e.weight), 0);
    if (total <= 0) return this.pick(entries).item;
    let r = this.float() * total;
    for (const e of entries) {
      r -= Math.max(0, e.weight);
      if (r < 0) return e.item;
    }
    return entries[entries.length - 1].item;
  }
}
