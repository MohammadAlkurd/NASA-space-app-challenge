import type { TravelProfile } from '../entities/Explorer';
import { Analysis, GRID, doseRate } from './Analysis';

export type RouteKind = 'safest' | 'fastest' | 'science' | 'shielded' | 'custom';
export type Rating = 'SAFE' | 'BE CAREFUL' | 'DANGER' | 'NO-GO';
export const RATINGS: Rating[] = ['SAFE', 'BE CAREFUL', 'DANGER', 'NO-GO'];

export interface RoutePoint {
  x: number;
  z: number;
}

export interface Segment {
  rating: Rating;
  /** Plain-language cause of the rating; empty for SAFE. */
  reason: string;
  startIndex: number;
  endIndex: number;
  lengthM: number;
}

export interface RouteStats {
  distanceM: number;
  /** Real travel time at this traveller's pace, seconds. */
  durationS: number;
  ascentM: number;
  descentM: number;
  maxSlopeDeg: number;
  doseUSv: number;
  /** Rover: battery energy in Wh. Astronaut: share of an 8 h suit life-support budget, 0..1. */
  resource: number;
  worst: Rating;
  noGoM: number;
  cautionM: number;
}

export interface Route {
  kind: RouteKind;
  label: string;
  points: RoutePoint[];
  /** Rating per point (for the stretch that starts at that point). */
  ratings: Rating[];
  segments: Segment[];
  stats: RouteStats;
  stops: string[];
}

export interface ScienceTarget extends RoutePoint {
  id: string;
  name: string;
}

// Rover energy model (documented in the Sources panel): rolling resistance + climbing,
// Perseverance-class mass 1025 kg, Mars gravity 3.71 m/s^2, drivetrain efficiency 0.5.
const ROVER_MASS = 1025;
const MARS_G = 3.71;
const ROLLING = 0.15;
const DRIVE_EFFICIENCY = 0.5;
export const ROVER_BATTERY_WH = 2400;

/** Battery energy to drive `distance` metres while climbing `climb` metres. */
export function roverEnergyWh(distance: number, climb: number): number {
  return (ROLLING * ROVER_MASS * MARS_G * distance + ROVER_MASS * MARS_G * Math.max(climb, 0)) / DRIVE_EFFICIENCY / 3600;
}
export const SUIT_BUDGET_S = 8 * 3600;

const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/** Fraction of flat-ground speed kept on a slope. */
export function speedFactor(slope: number, profile: TravelProfile): number {
  return Math.max(0.25, 1 - 0.75 * Math.min(1, slope / profile.maxSlope));
}

export function rate(slope: number, roughness: number, profile: TravelProfile): { rating: Rating; reason: string } {
  const mid = (profile.cautionSlope + profile.maxSlope) / 2;
  const who = profile.mode === 'rover' ? 'rover' : 'suit';
  if (slope >= profile.maxSlope) {
    return { rating: 'NO-GO', reason: `Slope ${slope.toFixed(0)}° is over the ${profile.maxSlope}° ${who} limit: tip-over or fall risk` };
  }
  if (slope >= mid) return { rating: 'DANGER', reason: `Steep ${slope.toFixed(0)}° slope, close to the ${profile.maxSlope}° ${who} limit` };
  if (slope >= profile.cautionSlope) return { rating: 'BE CAREFUL', reason: `Slope ${slope.toFixed(0)}°: slow, slippery going` };
  if (roughness > 0.35) return { rating: 'BE CAREFUL', reason: 'Rough ground: rocks or sand ripples' };
  return { rating: 'SAFE', reason: '' };
}

class Heap {
  private readonly items: number[] = [];
  private readonly keys: number[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: number, key: number): void {
    const { items, keys } = this;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      items[i] = items[parent];
      keys[i] = keys[parent];
      i = parent;
    }
    items[i] = item;
    keys[i] = key;
  }
  pop(): number {
    const { items, keys } = this;
    const top = items[0];
    const item = items.pop() as number;
    const key = keys.pop() as number;
    const n = items.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && keys[child + 1] < keys[child]) child += 1;
        if (keys[child] >= key) break;
        items[i] = items[child];
        keys[i] = keys[child];
        i = child;
      }
      items[i] = item;
      keys[i] = key;
    }
    return top;
  }
}

export class Router {
  private readonly g = new Float32Array(GRID * GRID);
  private readonly from = new Int32Array(GRID * GRID);
  private readonly closed = new Uint8Array(GRID * GRID);

  constructor(private readonly analysis: Analysis) {}

  /** Up to four alternative routes between two points for this traveller. */
  plan(start: RoutePoint, goal: RoutePoint, profile: TravelProfile, science: ScienceTarget[]): Route[] {
    const routes: Route[] = [];
    const add = (kind: RouteKind, label: string, via: ScienceTarget[] = []) => {
      const legs = [start, ...via, goal];
      const points: RoutePoint[] = [];
      for (let k = 0; k < legs.length - 1; k += 1) {
        const leg = this.search(legs[k], legs[k + 1], profile, kind);
        if (!leg) return;
        if (points.length) leg.shift();
        points.push(...leg);
      }
      const route = this.evaluate(points, profile, kind, label);
      route.stops = via.map((stop) => stop.name);
      // Two goals often give the same path; show it once under both names.
      const same = routes.find((r) => Math.abs(r.stats.distanceM - route.stats.distanceM) < 0.01 * route.stats.distanceM
        && Math.abs(r.stats.durationS - route.stats.durationS) < 0.01 * route.stats.durationS && r.stops.length === route.stops.length);
      if (same) same.label += ` + ${label.toLowerCase()}`;
      else routes.push(route);
    };
    add('safest', 'Safest');
    add('fastest', 'Fastest');
    add('shielded', 'Low radiation');
    // Science-rich: detour through up to three science stops that lie near the direct line.
    const direct = Math.hypot(goal.x - start.x, goal.z - start.z);
    const via = science
      .map((stop) => ({
        stop,
        detour: Math.hypot(stop.x - start.x, stop.z - start.z) + Math.hypot(goal.x - stop.x, goal.z - stop.z) - direct,
        along: ((stop.x - start.x) * (goal.x - start.x) + (stop.z - start.z) * (goal.z - start.z)) / Math.max(direct, 1),
      }))
      .filter((c) => c.detour < Math.max(250, direct * 0.35) && c.along > 30 && c.along < direct - 30)
      .sort((a, b) => a.detour - b.detour)
      .slice(0, 3)
      .sort((a, b) => a.along - b.along)
      .map((c) => c.stop);
    if (via.length) add('science', 'Science-rich', via);
    return routes;
  }

  /** Rate and measure any polyline (planned or hand-drawn). Points are resampled to ~10 m. */
  evaluate(input: RoutePoint[], profile: TravelProfile, kind: RouteKind, label: string): Route {
    const analysis = this.analysis;
    const points: RoutePoint[] = [];
    for (let k = 0; k < input.length; k += 1) {
      const a = input[k];
      if (k === 0) {
        points.push({ x: a.x, z: a.z });
        continue;
      }
      const prev = input[k - 1];
      const length = Math.hypot(a.x - prev.x, a.z - prev.z);
      const pieces = Math.max(1, Math.round(length / analysis.cell));
      for (let s = 1; s <= pieces; s += 1) {
        points.push({ x: prev.x + ((a.x - prev.x) * s) / pieces, z: prev.z + ((a.z - prev.z) * s) / pieces });
      }
    }
    const stats: RouteStats = {
      distanceM: 0, durationS: 0, ascentM: 0, descentM: 0, maxSlopeDeg: 0, doseUSv: 0, resource: 0,
      worst: 'SAFE', noGoM: 0, cautionM: 0,
    };
    const ratings: Rating[] = [];
    const segments: Segment[] = [];
    let energyWh = 0;
    const field = analysis.site.local;
    for (let k = 0; k < points.length - 1; k += 1) {
      const a = points[k];
      const b = points[k + 1];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const cell = analysis.index((a.x + b.x) / 2, (a.z + b.z) / 2);
      const slope = analysis.effectiveSlope(cell);
      const { rating, reason } = rate(slope, analysis.roughness[cell], profile);
      const climb = field.heightAt(b.x, b.z) - field.heightAt(a.x, a.z);
      const time = length / (profile.speed * speedFactor(slope, profile));
      stats.distanceM += length;
      stats.durationS += time;
      if (climb > 0) stats.ascentM += climb;
      else stats.descentM -= climb;
      stats.maxSlopeDeg = Math.max(stats.maxSlopeDeg, slope);
      stats.doseUSv += (doseRate(analysis.skyView[cell]) * time) / 3600;
      energyWh += roverEnergyWh(length, climb);
      if (rating === 'NO-GO') stats.noGoM += length;
      if (rating !== 'SAFE') stats.cautionM += length;
      if (RATINGS.indexOf(rating) > RATINGS.indexOf(stats.worst)) stats.worst = rating;
      ratings.push(rating);
      const last = segments[segments.length - 1];
      if (last && last.rating === rating) {
        last.endIndex = k + 1;
        last.lengthM += length;
        // Keep the reason from the worst slope seen in the stretch.
        if (reason && reason.length && slope >= stats.maxSlopeDeg) last.reason = reason;
      } else {
        segments.push({ rating, reason, startIndex: k, endIndex: k + 1, lengthM: length });
      }
    }
    ratings.push(ratings[ratings.length - 1] ?? 'SAFE');
    stats.resource = profile.mode === 'rover' ? energyWh : stats.durationS / SUIT_BUDGET_S;
    return { kind, label, points, ratings, segments, stats, stops: [] };
  }

  /** A* over the 10 m grid. Returns null when the goal cannot be reached within the slope limit. */
  private search(start: RoutePoint, goal: RoutePoint, profile: TravelProfile, kind: RouteKind): RoutePoint[] | null {
    const analysis = this.analysis;
    const s = analysis.index(start.x, start.z);
    const t = analysis.index(goal.x, goal.z);
    const { g, from, closed } = this;
    g.fill(Infinity);
    closed.fill(0);
    from.fill(-1);
    const heap = new Heap();
    const tx = t % GRID;
    const tz = Math.floor(t / GRID);
    // Admissible: straight-line time at flat-ground speed.
    const heuristic = (index: number) => (Math.hypot((index % GRID) - tx, Math.floor(index / GRID) - tz) * analysis.cell) / profile.speed;
    g[s] = 0;
    heap.push(s, heuristic(s));
    while (heap.size) {
      const current = heap.pop();
      if (current === t) break;
      if (closed[current]) continue;
      closed[current] = 1;
      const cx = current % GRID;
      const cz = (current - cx) / GRID;
      for (const [dx, dz, step] of NEIGHBOURS) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 2 || nz < 2 || nx >= GRID - 2 || nz >= GRID - 2) continue;
        const next = nz * GRID + nx;
        if (closed[next]) continue;
        const cost = this.stepCost(next, step * analysis.cell, profile, kind, next === t || current === s);
        if (!Number.isFinite(cost)) continue;
        const total = g[current] + cost;
        if (total < g[next]) {
          g[next] = total;
          from[next] = current;
          heap.push(next, total + heuristic(next));
        }
      }
    }
    if (from[t] < 0 && s !== t) return null;
    const cells: number[] = [];
    for (let c = t; c >= 0; c = from[c]) {
      cells.push(c);
      if (c === s) break;
    }
    cells.reverse();
    const points = cells.map((c) => analysis.cellCenter(c, { x: 0, z: 0 }));
    points[0] = { x: start.x, z: start.z };
    points[points.length - 1] = { x: goal.x, z: goal.z };
    return smooth(points);
  }

  /** Cost in seconds of entering a cell, weighted by what this route type cares about. */
  private stepCost(cell: number, length: number, profile: TravelProfile, kind: RouteKind, endpoint: boolean): number {
    const analysis = this.analysis;
    const slope = analysis.effectiveSlope(cell);
    // The cells the traveller starts from or clicked on are always enterable.
    if (slope >= profile.maxSlope && !endpoint) return Infinity;
    const time = length / (profile.speed * speedFactor(slope, profile));
    if (kind === 'fastest') return time;
    const over = Math.max(0, slope - profile.cautionSlope) / (profile.maxSlope - profile.cautionSlope);
    const rough = Math.min(1, analysis.roughness[cell] / 0.5);
    if (kind === 'shielded') {
      // Dose-weighted time: open sky costs more, cliffs and crater walls less.
      const exposure = Math.min(1, Math.max(0, (analysis.skyView[cell] - 0.8) / 0.2));
      return time * (0.6 + 2.4 * exposure + 2 * over);
    }
    if (kind !== 'safest') return time * (1 + 3 * over * over + 0.5 * rough);
    // Safest: stay well inside the limits, on the gentlest and smoothest ground available.
    const gentle = Math.min(1, slope / profile.cautionSlope);
    return time * (1 + 9 * over * over + 1.2 * gentle * gentle + 1.5 * rough + (slope > profile.cautionSlope ? 1.5 : 0));
  }
}

/** Round off the grid staircase without leaving the cells the planner approved. */
function smooth(points: RoutePoint[]): RoutePoint[] {
  if (points.length < 4) return points;
  let current = points;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = [current[0]];
    for (let k = 1; k < current.length - 1; k += 1) {
      next.push({
        x: current[k - 1].x * 0.25 + current[k].x * 0.5 + current[k + 1].x * 0.25,
        z: current[k - 1].z * 0.25 + current[k].z * 0.5 + current[k + 1].z * 0.25,
      });
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min` : `${minutes} min`;
}

export function toGeoJSON(route: Route, toLatLon: (x: number, z: number) => { lat: number; lon: number }, elevation: (x: number, z: number) => number, traveller: string): string {
  const coordinates = route.points.map((p) => {
    const { lat, lon } = toLatLon(p.x, p.z);
    return [Number(lon.toFixed(6)), Number(lat.toFixed(6)), Number(elevation(p.x, p.z).toFixed(1))];
  });
  return JSON.stringify({
    type: 'FeatureCollection',
    crs_note: 'Mars 2000 sphere (IAU), planetocentric latitude, east-positive longitude, elevation in m above the MOLA areoid',
    features: [{
      type: 'Feature',
      properties: {
        name: `${route.label} route`, traveller,
        distance_m: Math.round(route.stats.distanceM), duration_min: Math.round(route.stats.durationS / 60),
        ascent_m: Math.round(route.stats.ascentM), max_slope_deg: Number(route.stats.maxSlopeDeg.toFixed(1)),
        dose_uSv: Number(route.stats.doseUSv.toFixed(2)), worst_rating: route.stats.worst, science_stops: route.stops,
      },
      geometry: { type: 'LineString', coordinates },
    }],
  }, null, 1);
}

export function toCSV(route: Route, toLatLon: (x: number, z: number) => { lat: number; lon: number }, elevation: (x: number, z: number) => number): string {
  const rows = ['point,lat_deg,lon_deg_east,elevation_m,rating'];
  route.points.forEach((p, k) => {
    const { lat, lon } = toLatLon(p.x, p.z);
    rows.push(`${k},${lat.toFixed(6)},${lon.toFixed(6)},${elevation(p.x, p.z).toFixed(1)},${route.ratings[k]}`);
  });
  return rows.join('\n');
}
