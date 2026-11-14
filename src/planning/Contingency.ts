import { PROFILES } from '../entities/Explorer';
import { Analysis, GRID } from './Analysis';
import { MODEL, SHELTER_PACE, gradeDeg, marquezSpeed, walkEnergyJ } from './Models';
import type { RoutePoint } from './Router';

const STEPS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/**
 * The walk home from every map cell to the nearest pressurised shelter, on foot at the emergency pace
 * (the full Marquez curve). One search outward from the shelters; it is redone when a shelter moves.
 */
export class Contingency {
  /** Seconds to walk to the nearest shelter; Infinity where no-go slopes cut the cell off. */
  readonly homeS = new Float32Array(GRID * GRID);
  /** Suit energy for that walk, joules. */
  readonly homeJ = new Float32Array(GRID * GRID);
  /** Seconds for the same walk at the suit-failure pace NASA tested (2.1 km/h, slower on steep ground). */
  readonly slowS = new Float32Array(GRID * GRID);
  /** The same walk at the planned (unhurried) pace: clear-sol seconds, and joules at the pace the weather allows. */
  readonly planS = new Float32Array(GRID * GRID);
  readonly planJ = new Float32Array(GRID * GRID);
  private key = '';

  constructor(private readonly analysis: Analysis) {}

  /** Returns true when the fields were recomputed. */
  update(shelters: RoutePoint[], speedFactor = 1): boolean {
    const analysis = this.analysis;
    const sources = shelters.map((s) => analysis.index(s.x, s.z));
    const key = `${sources.join(',')}|${speedFactor}`;
    if (key === this.key) return false;
    this.key = key;
    const { homeS, homeJ, slowS, planS, planJ } = this;
    const planned = MODEL.walkPlanSpeed.value;
    const limit = PROFILES.astronaut.maxSlope;
    homeS.fill(Infinity);
    homeJ.fill(Infinity);
    slowS.fill(Infinity);
    planS.fill(Infinity);
    planJ.fill(Infinity);
    // Binary heap of cell indices ordered by walk time.
    const heap: number[] = [];
    const push = (cell: number) => {
      let i = heap.length;
      heap.push(cell);
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (homeS[heap[parent]] <= homeS[cell]) break;
        heap[i] = heap[parent];
        i = parent;
      }
      heap[i] = cell;
    };
    const pop = (): number => {
      const top = heap[0];
      const last = heap.pop() as number;
      const n = heap.length;
      let i = 0;
      while (n > 0) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && homeS[heap[child + 1]] < homeS[heap[child]]) child += 1;
        if (homeS[heap[child]] >= homeS[last]) break;
        heap[i] = heap[child];
        i = child;
      }
      if (n > 0) heap[i] = last;
      return top;
    };
    const done = new Uint8Array(GRID * GRID);
    for (const source of sources) {
      homeS[source] = 0;
      homeJ[source] = 0;
      slowS[source] = 0;
      planS[source] = 0;
      planJ[source] = 0;
      push(source);
    }
    while (heap.length) {
      const current = pop();
      if (done[current]) continue;
      done[current] = 1;
      const cx = current % GRID;
      const cz = (current - cx) / GRID;
      for (const [dx, dz, step] of STEPS) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= GRID || nz >= GRID) continue;
        const next = nz * GRID + nx;
        if (done[next] || analysis.effectiveSlope(next) >= limit) continue;
        // The walk goes from `next` toward `current`, so the grade is taken in that direction.
        const length = step * analysis.cell;
        const grade = gradeDeg(analysis.height[current] - analysis.height[next], length);
        const speed = marquezSpeed(grade);
        const time = homeS[current] + length / speed;
        if (time < homeS[next]) {
          homeS[next] = time;
          homeJ[next] = homeJ[current] + walkEnergyJ(length, grade, speed);
          slowS[next] = slowS[current] + length / Math.min(speed, SHELTER_PACE);
          const unhurried = Math.min(speed, planned);
          planS[next] = planS[current] + length / unhurried;
          planJ[next] = planJ[current] + walkEnergyJ(length, grade, unhurried * speedFactor);
          push(next);
        }
      }
    }
    return true;
  }

  /** Line where a field crosses `level`, as flat world-space segments [x1, z1, x2, z2, ...]. */
  contour(field: Float32Array, level: number): number[] {
    const { cell } = this.analysis;
    const half = this.analysis.site.local.half;
    const out: number[] = [];
    const cap = level * 4 + 1;
    const edge: number[] = [];
    for (let j = 0; j < GRID - 1; j += 1) {
      for (let i = 0; i < GRID - 1; i += 1) {
        const o = j * GRID + i;
        const a = Math.min(field[o], cap);
        const b = Math.min(field[o + 1], cap);
        const c = Math.min(field[o + GRID + 1], cap);
        const d = Math.min(field[o + GRID], cap);
        const code = (a > level ? 1 : 0) | (b > level ? 2 : 0) | (c > level ? 4 : 0) | (d > level ? 8 : 0);
        if (code === 0 || code === 15) continue;
        edge.length = 0;
        const x = -half + (i + 0.5) * cell;
        const z = -half + (j + 0.5) * cell;
        const cross = (p: number, q: number) => (level - p) / (q - p);
        if ((a > level) !== (b > level)) edge.push(x + cross(a, b) * cell, z);
        if ((b > level) !== (c > level)) edge.push(x + cell, z + cross(b, c) * cell);
        if ((d > level) !== (c > level)) edge.push(x + cross(d, c) * cell, z + cell);
        if ((a > level) !== (d > level)) edge.push(x, z + cross(a, d) * cell);
        for (let k = 0; k + 3 < edge.length; k += 4) out.push(edge[k], edge[k + 1], edge[k + 2], edge[k + 3]);
      }
    }
    return out;
  }
}
