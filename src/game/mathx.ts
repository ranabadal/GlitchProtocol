import * as THREE from "three";

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const damp = (a: number, b: number, rate: number, dt: number) => lerp(a, b, 1 - Math.exp(-rate * dt));

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function dampAngle(a: number, b: number, rate: number, dt: number): number {
  return a + wrapAngle(b - a) * (1 - Math.exp(-rate * dt));
}

/** Turn from a toward b by at most maxStep radians. */
export function turnToward(a: number, b: number, maxStep: number): number {
  const d = wrapAngle(b - a);
  return a + clamp(d, -maxStep, maxStep);
}

/** Heading (rotation.y) that faces from (x0,z0) toward (x1,z1). Forward is +z at heading 0. */
export function headingTo(x0: number, z0: number, x1: number, z1: number): number {
  return Math.atan2(x1 - x0, z1 - z0);
}

const _ab = new THREE.Vector3();
const _ao = new THREE.Vector3();

/**
 * Ray against a capsule (segment a-b with radius r). Direction must be normalised.
 * Returns the distance along the ray, or null.
 */
export function rayCapsule(o: THREE.Vector3, d: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number, maxT: number): number | null {
  // Sample-free approach: closest points between ray and segment, then sphere test there.
  _ab.subVectors(b, a);
  _ao.subVectors(o, a);
  const abab = _ab.dot(_ab);
  const abd = _ab.dot(d);
  const abao = _ab.dot(_ao);
  const dao = d.dot(_ao);
  const denom = abab - abd * abd;
  let s = denom > 1e-6 ? clamp((abao - abd * dao) / denom, 0, 1) : 0;
  // Point on segment, then nearest point on the ray to it.
  const cx = a.x + _ab.x * s, cy = a.y + _ab.y * s, cz = a.z + _ab.z * s;
  let t = (cx - o.x) * d.x + (cy - o.y) * d.y + (cz - o.z) * d.z;
  if (t < 0) t = 0;
  // Re-project the ray point onto the segment for a tighter closest pair.
  const px = o.x + d.x * t, py = o.y + d.y * t, pz = o.z + d.z * t;
  s = abab > 1e-6 ? clamp(((px - a.x) * _ab.x + (py - a.y) * _ab.y + (pz - a.z) * _ab.z) / abab, 0, 1) : 0;
  return raySphere(o, d, a.x + _ab.x * s, a.y + _ab.y * s, a.z + _ab.z * s, r, maxT);
}

export function raySphere(o: THREE.Vector3, d: THREE.Vector3, cx: number, cy: number, cz: number, r: number, maxT: number): number | null {
  const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  if (t < 0 || t > maxT) return null;
  return t;
}

/** Distance from point p to segment a-b (3D). */
export function pointSegDist(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  _ab.subVectors(b, a);
  _ao.subVectors(p, a);
  const l = _ab.lengthSq();
  const t = l > 1e-9 ? clamp(_ao.dot(_ab) / l, 0, 1) : 0;
  return Math.hypot(a.x + _ab.x * t - p.x, a.y + _ab.y * t - p.y, a.z + _ab.z * t - p.z);
}

/** Closest distance between two segments (used for fast bolts against the player capsule). */
export function segSegDist(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3): number {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s: number, t: number;
  if (a <= 1e-9 && e <= 1e-9) return Math.hypot(rx, ry, rz);
  if (a <= 1e-9) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-9) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const den = a * e - b * b;
      s = den !== 0 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  const cx = p1.x + d1x * s - (p2.x + d2x * t);
  const cy = p1.y + d1y * s - (p2.y + d2y * t);
  const cz = p1.z + d1z * s - (p2.z + d2z * t);
  return Math.hypot(cx, cy, cz);
}

/** Small deterministic PRNG for client-side cosmetics (crowd looks, traffic colours). */
export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
