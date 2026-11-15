import { Analysis, GRID, doseRate } from './Analysis';
import type { RoutePoint } from './Router';

export interface BaseCriterion {
  name: string;
  /** 0..100 */
  score: number;
  weight: number;
  note: string;
}

export interface BaseScore {
  x: number;
  z: number;
  total: number;
  verdict: string;
  criteria: BaseCriterion[];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Scores a spot as a place to build a habitat. Every criterion comes from a data layer in the map. */
export class BaseSiteScorer {
  constructor(private readonly analysis: Analysis, private readonly science: RoutePoint[]) {}

  score(x: number, z: number): BaseScore {
    const a = this.analysis;
    const center = a.index(x, z);
    const ci = center % GRID;
    const cj = Math.floor(center / GRID);
    // Building pad: 7 x 7 cells = 70 m square.
    let slope = 0;
    let worst = 0;
    let rough = 0;
    let sky = 0;
    let count = 0;
    for (let j = Math.max(0, cj - 3); j <= Math.min(GRID - 1, cj + 3); j += 1) {
      for (let i = Math.max(0, ci - 3); i <= Math.min(GRID - 1, ci + 3); i += 1) {
        const o = j * GRID + i;
        slope += a.slope[o];
        worst = Math.max(worst, a.effectiveSlope(o));
        rough += a.roughness[o];
        sky += a.skyView[o];
        count += 1;
      }
    }
    slope /= count;
    rough /= count;
    sky /= count;
    const distances = this.science.map((s) => Math.hypot(s.x - x, s.z - z)).sort((p, q) => p - q);
    const near = distances.slice(0, 3);
    const access = near.reduce((sum, d) => sum + d, 0) / Math.max(1, near.length);
    const dose = doseRate(sky);

    const criteria: BaseCriterion[] = [
      {
        name: 'Flat ground', weight: 0.3,
        score: 100 * clamp01(1 - (slope - 2) / 8) * (worst > 20 ? 0.6 : 1),
        note: `Average slope ${slope.toFixed(1)}° over a 70 m pad, steepest spot ${worst.toFixed(0)}°`,
      },
      {
        name: 'Smooth surface', weight: 0.15,
        score: 100 * clamp01(1 - (rough - 0.05) / 0.35),
        note: rough < 0.12 ? 'Few rocks or ripples: easy landing and building' : 'Rocky or rippled: needs clearing',
      },
      {
        name: 'Radiation shelter', weight: 0.2,
        score: 100 * clamp01((1 - sky) / 0.12),
        note: `${Math.round(sky * 100)} % of the sky visible, about ${dose.toFixed(1)} µSv/h`,
      },
      {
        name: 'Science access', weight: 0.2,
        score: 100 * clamp01(1 - (access - 300) / 2200),
        note: `Nearest science stops average ${(access / 1000).toFixed(1)} km away`,
      },
      {
        name: 'Sunlight for power', weight: 0.15,
        score: 100 * clamp01((sky - 0.8) / 0.18),
        note: sky > 0.95 ? 'Open sky: full solar power all day' : 'Hills block part of the sun\'s path',
      },
    ];
    const total = criteria.reduce((sum, c) => sum + c.score * c.weight, 0);
    const verdict = total >= 70 ? 'Strong base site' : total >= 50 ? 'Workable base site' : 'Poor base site';
    return { x, z, total, verdict, criteria };
  }

  /** Best-scoring pad on a 40 m search grid, away from the map edge. */
  findBest(): BaseScore {
    const a = this.analysis;
    let best: BaseScore | null = null;
    const point = { x: 0, z: 0 };
    for (let j = 16; j < GRID - 16; j += 4) {
      for (let i = 16; i < GRID - 16; i += 4) {
        a.cellCenter(j * GRID + i, point);
        const score = this.score(point.x, point.z);
        if (!best || score.total > best.total) best = score;
      }
    }
    return best as BaseScore;
  }
}
