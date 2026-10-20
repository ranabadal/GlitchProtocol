/*
 * Number-rule fitters used by the Data Stream hack (Pattern Breaker). Each fitter
 * takes a stream with at most one unknown (null) value and returns the full stream
 * if the known values follow that rule exactly, or null. Used to prove a stream has
 * exactly one value that breaks the rule.
 */

export type Family = "arithmetic" | "geometric" | "interleaved" | "quadratic" | "fibonacci" | "affine";

export type Known = (number | null)[];

function knownIdx(k: Known): number[] {
  const out: number[] = [];
  k.forEach((v, i) => { if (v !== null) out.push(i); });
  return out;
}

function matches(seq: number[], k: Known): boolean {
  return seq.every((v, i) => Number.isSafeInteger(v) && (k[i] === null || k[i] === v));
}

function fitArithmetic(k: Known): number[] | null {
  const idx = knownIdx(k);
  if (idx.length < 3) return null;
  const [p, q] = idx;
  const diff = (k[q] as number) - (k[p] as number);
  if (diff % (q - p) !== 0) return null;
  const d = diff / (q - p);
  if (d === 0) return null;
  const seq = k.map((_, i) => (k[p] as number) + d * (i - p));
  return matches(seq, k) ? seq : null;
}

function fitQuadratic(k: Known): number[] | null {
  const idx = knownIdx(k);
  if (idx.length < 4) return null;
  const xs = idx.slice(0, 3);
  const ys = xs.map((i) => k[i] as number);
  const seq: number[] = [];
  for (let i = 0; i < k.length; i++) {
    let v = 0;
    for (let j = 0; j < 3; j++) {
      let term = ys[j];
      for (let m = 0; m < 3; m++) if (m !== j) term *= (i - xs[m]) / (xs[j] - xs[m]);
      v += term;
    }
    const r = Math.round(v);
    if (Math.abs(v - r) > 1e-6) return null;
    seq.push(r);
  }
  return matches(seq, k) ? seq : null;
}

function fitGeometric(k: Known): number[] | null {
  if (knownIdx(k).length < 3) return null;
  for (let i = 0; i + 1 < k.length; i++) {
    const a = k[i], b = k[i + 1];
    if (a === null || b === null || a === 0) continue;
    if (b % a !== 0) return null;
    const r = b / a;
    if (Math.abs(r) < 2) return null;
    const seq = new Array<number>(k.length);
    seq[i] = a;
    for (let j = i + 1; j < k.length; j++) seq[j] = seq[j - 1] * r;
    for (let j = i - 1; j >= 0; j--) {
      if (seq[j + 1] % r !== 0) return null;
      seq[j] = seq[j + 1] / r;
    }
    return matches(seq, k) ? seq : null;
  }
  return null;
}

function fitArithmeticLoose(k: Known): number[] | null {
  // Used inside one interleaved stream. Needs three points so a two-point stream
  // (which fits any step) never counts as evidence. Step may be 0.
  const idx = knownIdx(k);
  if (idx.length < 3) return null;
  const [p, q] = idx;
  const diff = (k[q] as number) - (k[p] as number);
  if (diff % (q - p) !== 0) return null;
  const d = diff / (q - p);
  const seq = k.map((_, i) => (k[p] as number) + d * (i - p));
  return matches(seq, k) ? seq : null;
}

function fitInterleaved(k: Known): number[] | null {
  if (knownIdx(k).length < 6) return null;
  const evens = k.filter((_, i) => i % 2 === 0);
  const odds = k.filter((_, i) => i % 2 === 1);
  const fe = fitArithmeticLoose(evens);
  const fo = fitArithmeticLoose(odds);
  if (!fe || !fo) return null;
  const seq = k.map((_, i) => (i % 2 === 0 ? fe[i / 2] : fo[(i - 1) / 2]));
  return matches(seq, k) ? seq : null;
}

function fitFibonacci(k: Known): number[] | null {
  if (knownIdx(k).length < 4) return null;
  for (let i = 0; i + 1 < k.length; i++) {
    const a = k[i], b = k[i + 1];
    if (a === null || b === null) continue;
    const seq = new Array<number>(k.length);
    seq[i] = a;
    seq[i + 1] = b;
    for (let j = i + 2; j < k.length; j++) seq[j] = seq[j - 1] + seq[j - 2];
    for (let j = i - 1; j >= 0; j--) seq[j] = seq[j + 2] - seq[j + 1];
    return matches(seq, k) ? seq : null;
  }
  return null;
}

function fitAffine(k: Known): number[] | null {
  if (knownIdx(k).length < 4) return null;
  for (let i = 0; i + 2 < k.length; i++) {
    const a = k[i], b = k[i + 1], c = k[i + 2];
    if (a === null || b === null || c === null || b === a) continue;
    const num = c - b, den = b - a;
    if (num % den !== 0) return null;
    const m = num / den;
    if (Math.abs(m) < 2) return null;
    const add = b - m * a;
    const seq = new Array<number>(k.length);
    seq[i] = a;
    for (let j = i + 1; j < k.length; j++) seq[j] = seq[j - 1] * m + add;
    for (let j = i - 1; j >= 0; j--) {
      const prev = (seq[j + 1] - add) / m;
      if (!Number.isInteger(prev)) return null;
      seq[j] = prev;
    }
    return matches(seq, k) ? seq : null;
  }
  return null;
}

export const FITTERS: Record<Family, (k: Known) => number[] | null> = {
  arithmetic: fitArithmetic,
  geometric: fitGeometric,
  interleaved: fitInterleaved,
  quadratic: fitQuadratic,
  fibonacci: fitFibonacci,
  affine: fitAffine,
};
