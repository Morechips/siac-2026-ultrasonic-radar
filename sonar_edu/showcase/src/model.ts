export const RANGE_MM = 2500;
export const STEP_DEG = 3;
export const STEP_MS = 80;
export const SOUND_MM_PER_US = 0.343;
export type Status = 'OK' | 'NO_HIT' | 'TIMEOUT';
export type Origin = 'SIM' | 'PROTEUS' | 'DEVICE';
export type InputMode = 'demo' | 'manual' | 'serial';
export type Preset = 'mixed' | 'near' | 'empty';
export interface Sample {
  seq: number;
  angle: number;
  distanceMm: number | null;
  status: Status;
  origin: Origin;
  historical?: boolean;
  outsideRange?: boolean;
}
export type Obstacle =
  | { kind: 'box'; x: number; z: number; width: number; depth: number; height: number }
  | { kind: 'circle'; x: number; z: number; radius: number; height: number };
export const PRESETS: Record<Preset, Obstacle[]> = {
  mixed: [
    { kind: 'box', x: -0.95, z: 1.3, width: 0.56, depth: 0.54, height: 0.42 },
    { kind: 'circle', x: 0.82, z: 1.52, radius: 0.29, height: 0.52 },
  ],
  near: [{ kind: 'box', x: 0, z: 0.75, width: 0.65, depth: 0.25, height: 0.4 }],
  empty: [],
};

/** Horizontal acoustic ray: 0° = right (+X), 90° = forward (+Z). Units: metres. */
export function rayDistance(angle: number, obstacles: Obstacle[]): number | null {
  const rad = angle * Math.PI / 180;
  const dx = Math.cos(rad), dz = Math.sin(rad);
  let nearest = Infinity;
  for (const o of obstacles) {
    if (o.kind === 'circle') {
      const projection = o.x * dx + o.z * dz;
      const discriminant = projection ** 2 - (o.x ** 2 + o.z ** 2 - o.radius ** 2);
      if (discriminant < 0) continue;
      const roots = [projection - Math.sqrt(discriminant), projection + Math.sqrt(discriminant)];
      const hit = roots.find(t => t >= 0);
      if (hit !== undefined) nearest = Math.min(nearest, hit);
    } else {
      let entry = -Infinity, exit = Infinity;
      for (const [direction, low, high] of [
        [dx, o.x - o.width / 2, o.x + o.width / 2],
        [dz, o.z - o.depth / 2, o.z + o.depth / 2],
      ]) {
        if (Math.abs(direction) < 1e-9) {
          if (low > 0 || high < 0) { exit = -Infinity; break; }
        } else {
          const a = low / direction, b = high / direction;
          entry = Math.max(entry, Math.min(a, b));
          exit = Math.min(exit, Math.max(a, b));
        }
      }
      if (exit >= Math.max(entry, 0)) nearest = Math.min(nearest, Math.max(entry, 0));
    }
  }
  return nearest <= RANGE_MM / 1000 ? Math.round(nearest * 1000) : null;
}

export function simulate(angle: number, seq: number, preset: Preset): Sample {
  const distanceMm = rayDistance(angle, PRESETS[preset]);
  return { seq, angle, distanceMm, status: distanceMm === null ? 'NO_HIT' : 'OK', origin: 'SIM' };
}

export function advanceScan(angle: number, direction: 1 | -1): { angle: number; direction: 1 | -1 } {
  if (angle >= 180 && direction === 1) direction = -1;
  if (angle <= 0 && direction === -1) direction = 1;
  return { angle: Math.max(0, Math.min(180, angle + STEP_DEG * direction)), direction };
}

export class ScanHistory {
  trail: Sample[] = [];
  nearest: Sample | null = null;
  direction: 1 | -1 | 0 = 0;
  private lastAngle: number | null = null;
  add(sample: Sample): void {
    if (this.lastAngle !== null) {
      const delta = sample.angle - this.lastAngle;
      const dir = Math.sign(delta) as 1 | -1 | 0;
      if (dir && this.direction && dir !== this.direction) this.nearest = null;
      if (dir) this.direction = dir;
    }
    this.lastAngle = sample.angle;
    if (sample.distanceMm !== null && sample.status === 'OK' &&
      (this.nearest?.distanceMm == null || sample.distanceMm < this.nearest.distanceMm)) this.nearest = sample;
    this.trail.push(sample);
    if (this.trail.length > 13) this.trail.shift();
  }
  clear(): void {
    this.trail = []; this.nearest = null; this.direction = 0; this.lastAngle = null;
  }
}

/** Steppable timeline. It consumes active time only, so pause never skips a stage. */
export class TeachingTimeline {
  stage = -1;
  progress = 0;
  animating = false;
  private elapsed = 0;
  readonly durations = [500, 1100, 1100, 350];
  next(): boolean {
    if (this.animating || this.stage === 3) return false;
    this.stage++; this.elapsed = 0; this.progress = 0; this.animating = true; return true;
  }
  tick(ms: number, paused: boolean): boolean {
    if (!this.animating || paused) return false;
    this.elapsed += ms;
    this.progress = Math.min(1, this.elapsed / this.durations[this.stage]);
    if (this.progress >= 1) { this.animating = false; return true; }
    return false;
  }
  reset(): void { this.stage = -1; this.progress = 0; this.animating = false; this.elapsed = 0; }
}
