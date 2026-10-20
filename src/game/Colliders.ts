import { HALF } from "@/lib/shared/city";

/*
 * Static collision world: axis-aligned boxes (buildings, walls, barricades, towers)
 * in a uniform grid. Characters and cars are circles in the ground plane that get
 * pushed out of boxes; bullets and line-of-sight use 3D ray casts against the boxes.
 */

export interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
  kind: "building" | "wall" | "barricade" | "tower" | "prop" | "boundary" | "fence";
  /** Optional owner id (e.g. fence id) for gameplay hooks. */
  tag?: string;
  enabled: boolean;
}

export interface RayHit {
  t: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  box: Box | null;
}

const CELL = 16;
const SPAN = HALF + 40;
const N = Math.ceil((SPAN * 2) / CELL);

export class Colliders {
  boxes: Box[] = [];
  private grid: number[][] = Array.from({ length: N * N }, () => []);

  private cellOf(v: number): number {
    return Math.max(0, Math.min(N - 1, Math.floor((v + SPAN) / CELL)));
  }

  add(b: Omit<Box, "enabled"> & { enabled?: boolean }): Box {
    const box: Box = { enabled: true, ...b };
    const idx = this.boxes.length;
    this.boxes.push(box);
    for (let cx = this.cellOf(box.minX); cx <= this.cellOf(box.maxX); cx++) {
      for (let cz = this.cellOf(box.minZ); cz <= this.cellOf(box.maxZ); cz++) this.grid[cx + cz * N].push(idx);
    }
    return box;
  }

  addRect(cx: number, cz: number, w: number, d: number, h: number, kind: Box["kind"], minY = 0, tag?: string): Box {
    return this.add({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2, minY, maxY: minY + h, kind, tag });
  }

  /** Boxes whose cells overlap the given area. */
  query(minX: number, minZ: number, maxX: number, maxZ: number, out: Box[] = []): Box[] {
    out.length = 0;
    const seen = new Set<number>();
    for (let cx = this.cellOf(minX); cx <= this.cellOf(maxX); cx++) {
      for (let cz = this.cellOf(minZ); cz <= this.cellOf(maxZ); cz++) {
        for (const i of this.grid[cx + cz * N]) {
          if (seen.has(i)) continue;
          seen.add(i);
          const b = this.boxes[i];
          if (b.enabled) out.push(b);
        }
      }
    }
    return out;
  }

  private tmp: Box[] = [];

  /**
   * Push a circle (at height y..y+height) out of every box it overlaps. Returns the
   * corrected position and the strongest collision normal, if any.
   */
  resolveCircle(x: number, z: number, r: number, y = 0, height = 1.8, kinds?: ReadonlySet<Box["kind"]>): { x: number; z: number; hit: boolean; nx: number; nz: number; box: Box | null } {
    let hit = false;
    let bnx = 0, bnz = 0, bestDepth = 0;
    let hitBox: Box | null = null;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const b of this.query(x - r, z - r, x + r, z + r, this.tmp)) {
        if (kinds && !kinds.has(b.kind)) continue;
        if (y + height <= b.minY || y >= b.maxY) continue;
        const px = Math.max(b.minX, Math.min(x, b.maxX));
        const pz = Math.max(b.minZ, Math.min(z, b.maxZ));
        let dx = x - px, dz = z - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        let depth: number;
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2);
          dx /= d; dz /= d;
          depth = r - d;
        } else {
          // Centre is inside the box: push out through the nearest face.
          const l = x - b.minX, rr = b.maxX - x, f = z - b.minZ, k = b.maxZ - z;
          const m = Math.min(l, rr, f, k);
          if (m === l) { dx = -1; dz = 0; depth = l + r; }
          else if (m === rr) { dx = 1; dz = 0; depth = rr + r; }
          else if (m === f) { dx = 0; dz = -1; depth = f + r; }
          else { dx = 0; dz = 1; depth = k + r; }
        }
        x += dx * depth;
        z += dz * depth;
        moved = true;
        hit = true;
        if (depth > bestDepth) { bestDepth = depth; bnx = dx; bnz = dz; hitBox = b; }
      }
      if (!moved) break;
    }
    return { x, z, hit, nx: bnx, nz: bnz, box: hitBox };
  }

  /** True if a circle overlaps any box. */
  overlaps(x: number, z: number, r: number, y = 0, height = 1.8): boolean {
    for (const b of this.query(x - r, z - r, x + r, z + r, this.tmp)) {
      if (y + height <= b.minY || y >= b.maxY) continue;
      const px = Math.max(b.minX, Math.min(x, b.maxX));
      const pz = Math.max(b.minZ, Math.min(z, b.maxZ));
      if ((x - px) ** 2 + (z - pz) ** 2 < r * r) return true;
    }
    return false;
  }

  /** 3D ray cast against boxes and the ground. Direction must be normalised. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, ignoreKinds?: ReadonlySet<Box["kind"]>): RayHit | null {
    let best: RayHit | null = null;
    // Ground plane.
    if (dy < -1e-6) {
      const t = -oy / dy;
      if (t >= 0 && t <= maxDist) best = { t, x: ox + dx * t, y: 0, z: oz + dz * t, nx: 0, ny: 1, nz: 0, box: null };
    }
    const limit = best ? best.t : maxDist;
    // Walk the grid cells along the ray's ground projection.
    const ex = ox + dx * limit, ez = oz + dz * limit;
    const steps = Math.ceil(Math.hypot(ex - ox, ez - oz) / (CELL * 0.5)) + 1;
    const seen = new Set<Box>();
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const px = ox + (ex - ox) * f, pz = oz + (ez - oz) * f;
      const cx = this.cellOf(px), cz = this.cellOf(pz);
      for (let ix = cx - 1; ix <= cx + 1; ix++) {
        for (let iz = cz - 1; iz <= cz + 1; iz++) {
          if (ix < 0 || iz < 0 || ix >= N || iz >= N) continue;
          for (const i of this.grid[ix + iz * N]) {
            const b = this.boxes[i];
            if (!b.enabled || seen.has(b) || (ignoreKinds && ignoreKinds.has(b.kind))) continue;
            seen.add(b);
            const h = rayBox(ox, oy, oz, dx, dy, dz, b);
            if (h && h.t <= (best ? best.t : maxDist)) best = { ...h, box: b };
          }
        }
      }
      if (best && best.t < f * limit - CELL) break;
    }
    return best;
  }

  /** Clear line between two points (ignoring the ground)? */
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-3) return true;
    const hit = this.raycast(ax, ay, az, dx / d, dy / d, dz / d, d, NO_PROPS);
    return !hit || hit.box === null || hit.t >= d - 0.05;
  }
}

const NO_PROPS: ReadonlySet<Box["kind"]> = new Set(["prop", "fence"]);

function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, b: Box): Omit<RayHit, "box"> | null {
  let tmin = -Infinity, tmax = Infinity;
  let nx = 0, ny = 0, nz = 0;
  const axes: [number, number, number, number, 0 | 1 | 2][] = [
    [ox, dx, b.minX, b.maxX, 0],
    [oy, dy, b.minY, b.maxY, 1],
    [oz, dz, b.minZ, b.maxZ, 2],
  ];
  for (const [o, d, mn, mx, axis] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < mn || o > mx) return null;
      continue;
    }
    let t1 = (mn - o) / d, t2 = (mx - o) / d;
    let sign = -1;
    if (t1 > t2) { [t1, t2] = [t2, t1]; sign = 1; }
    if (t1 > tmin) {
      tmin = t1;
      nx = axis === 0 ? sign : 0;
      ny = axis === 1 ? sign : 0;
      nz = axis === 2 ? sign : 0;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  const t = Math.max(0, tmin);
  return { t, x: ox + dx * t, y: oy + dy * t, z: oz + dz * t, nx, ny, nz };
}
