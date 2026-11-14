import { PROFILES } from '../entities/Explorer';
import { Analysis, GRID } from './Analysis';
import { gradeDeg, marquezSpeed, walkEnergyJ } from './Models';
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
  private key = '';

  constructor(private readonly analysis: Analysis) {}

  update(shelters: RoutePoint[]): void {
    const analysis = this.analysis;
    const sources = shelters.map((s) => analysis.index(s.x, s.z));
    const key = sources.join(',');
    if (key === this.key) return;
    this.key = key;
    const { homeS, homeJ } = this;
    const limit = PROFILES.astronaut.maxSlope;
    homeS.fill(Infinity);
    homeJ.fill(Infinity);
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
          push(next);
        }
      }
    }
  }
}
