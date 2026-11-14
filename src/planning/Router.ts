import type { TravelProfile } from '../entities/Explorer';
import { Analysis, GRID, doseRate } from './Analysis';
import type { Contingency } from './Contingency';
import {
  MODEL, ROVER_BATTERY_WH, SHELTER_WALK_S, STOP_S, SUIT_ENERGY_J, WORK_RATE_W, gradeDeg, pace, travelEnergyJ,
} from './Models';

export { ROVER_BATTERY_WH } from './Models';

export type RouteKind = 'safest' | 'fastest' | 'effort' | 'science' | 'shielded' | 'custom';
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
  /** Rover: battery energy in Wh. Astronaut: share of one suit's energy budget, 0..1. One way. */
  resource: number;
  /** The whole outing: there, time at the destination, and back to shelter. */
  trip: Trip;
  worst: Rating;
  noGoM: number;
  cautionM: number;
}

export type Feasibility = 'PASS' | 'MARGINAL' | 'FAIL';

export interface Trip {
  /** True when the route ends at a shelter, so nothing has to be kept for a way back. */
  oneWay: boolean;
  /** Seconds for the whole outing. */
  totalS: number;
  /** Same unit as `RouteStats.resource`, for the whole outing. */
  resource: number;
  doseUSv: number;
  /** Longest walk to a pressurised shelter from any point of the route, seconds at the emergency pace. */
  shelterS: number;
  /** Last point from which turning around still meets the walk-back rules; null when the whole route does. */
  turnBack: RoutePoint | null;
  turnBackM: number;
  verdict: Feasibility;
  /** The rule that decides the verdict, in plain words. */
  reason: string;
}

/** What a trip is checked against: where shelter is, and how much of the suit or battery is left now (0..1). */
export interface TripContext {
  contingency: Contingency;
  shelters: RoutePoint[];
  /** Share of the active traveller's suit energy or battery left, 0..1. */
  reserve: number;
  /** Share of suit energy left, 0..1 (matters in the rover too: a breakdown means walking home). */
  suit: number;
  /** Weather slowdown on travel speed, 1 on a clear sol. */
  speedFactor: number;
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

/** Suit effort of walking on level ground at the planned pace, watts. */
const LEVEL_WALK_W = travelEnergyJ('astronaut', 1, 0, pace('astronaut', 0)) * pace('astronaut', 0);

/** Close enough to a shelter to count as arriving at it, metres. */
const AT_SHELTER = 30;

const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

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
  plan(start: RoutePoint, goal: RoutePoint, profile: TravelProfile, science: ScienceTarget[], context: TripContext): Route[] {
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
      const route = this.evaluate(points, profile, kind, label, context);
      route.stops = via.map((stop) => stop.name);
      // Two goals often give the same path; show it once under both names.
      const same = routes.find((r) => Math.abs(r.stats.distanceM - route.stats.distanceM) < 0.01 * route.stats.distanceM
        && Math.abs(r.stats.durationS - route.stats.durationS) < 0.01 * route.stats.durationS && r.stops.length === route.stops.length);
      if (same) same.label += ` + ${label.toLowerCase()}`;
      else routes.push(route);
    };
    add('safest', 'Safest');
    add('fastest', 'Fastest');
    if (profile.mode === 'astronaut') add('effort', 'Least effort');
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
  evaluate(input: RoutePoint[], profile: TravelProfile, kind: RouteKind, label: string, context: TripContext): Route {
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
      trip: { oneWay: false, totalS: 0, resource: 0, doseUSv: 0, shelterS: 0, turnBack: null, turnBackM: 0, verdict: 'PASS', reason: '' },
    };
    const mover = profile.mode;
    // The same path walked the other way: slopes reverse, so time and energy differ.
    const back = { s: 0, j: 0, dose: 0 };
    /** Energy spent on reaching each point, joules. */
    const usedJ = [0];
    const ratings: Rating[] = [];
    const segments: Segment[] = [];
    let energyJ = 0;
    const field = analysis.site.local;
    for (let k = 0; k < points.length - 1; k += 1) {
      const a = points[k];
      const b = points[k + 1];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const cell = analysis.index((a.x + b.x) / 2, (a.z + b.z) / 2);
      const slope = analysis.effectiveSlope(cell);
      const { rating, reason } = rate(slope, analysis.roughness[cell], profile);
      const climb = field.heightAt(b.x, b.z) - field.heightAt(a.x, a.z);
      const grade = gradeDeg(climb, length);
      const speed = pace(mover, grade);
      const time = length / speed;
      const speedBack = pace(mover, -grade);
      back.s += length / speedBack;
      back.j += travelEnergyJ(mover, length, -grade, speedBack * context.speedFactor);
      back.dose += (doseRate(analysis.skyView[cell]) * length) / speedBack / 3600;
      stats.distanceM += length;
      stats.durationS += time;
      if (climb > 0) stats.ascentM += climb;
      else stats.descentM -= climb;
      stats.maxSlopeDeg = Math.max(stats.maxSlopeDeg, slope);
      stats.doseUSv += (doseRate(analysis.skyView[cell]) * time) / 3600;
      energyJ += travelEnergyJ(mover, length, grade, speed * context.speedFactor);
      usedJ.push(energyJ);
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
    stats.resource = mover === 'rover' ? energyJ / 3600 : energyJ / SUIT_ENERGY_J;
    stats.trip = this.trip(points, profile, stats, back, usedJ, context);
    return { kind, label, points, ratings, segments, stats, stops: [] };
  }

  /** The whole outing checked against the hard limits: energy to get back, and the walk to shelter. */
  private trip(
    points: RoutePoint[], profile: TravelProfile, out: RouteStats, back: { s: number; j: number; dose: number },
    usedJ: number[], context: TripContext,
  ): Trip {
    const analysis = this.analysis;
    const { contingency, shelters, reserve } = context;
    const rover = profile.mode === 'rover';
    const budgetJ = rover ? ROVER_BATTERY_WH * 3600 : SUIT_ENERGY_J;
    const unit = (joules: number) => (rover ? joules / 3600 : joules / SUIT_ENERGY_J);
    const near = (p: RoutePoint) => shelters.some((s) => Math.hypot(s.x - p.x, s.z - p.z) <= AT_SHELTER);
    const cells = points.map((p) => analysis.index(p.x, p.z));
    const endCell = cells[cells.length - 1];
    const oneWay = near(points[points.length - 1]);
    const outJ = usedJ[usedJ.length - 1];
    let shelterS = 0;
    let farJ = 0;
    for (const cell of cells) {
      shelterS = Math.max(shelterS, contingency.slowS[cell]);
      farJ = Math.max(farJ, contingency.homeJ[cell]);
    }
    // The way back: the same path when it started at a shelter (or by rover), else the walk to the nearest shelter.
    const home = rover || near(points[0])
      ? back
      : { s: contingency.planS[endCell], j: contingency.planJ[endCell], dose: (doseRate(analysis.skyView[endCell]) * contingency.planS[endCell]) / 3600 };
    // Cut off from shelter: the trip fails below; keep the totals finite for the clock and the card.
    const reachable = Number.isFinite(home.s);
    const stopJ = rover ? 0 : WORK_RATE_W * STOP_S;
    const needJ = oneWay ? outJ : outJ + stopJ + home.j;
    const trip: Trip = {
      oneWay,
      totalS: oneWay || !reachable ? out.durationS : out.durationS + STOP_S + home.s,
      resource: unit(reachable ? needJ : outJ),
      doseUSv: oneWay || !reachable ? out.doseUSv : out.doseUSv + (doseRate(analysis.skyView[endCell]) * STOP_S) / 3600 + home.dose,
      shelterS,
      turnBack: null,
      turnBackM: 0,
      verdict: 'PASS',
      reason: '',
    };
    const haveJ = reserve * budgetJ;
    const within = (k: number) => usedJ[k] + contingency.homeJ[cells[k]] <= haveJ && contingency.slowS[cells[k]] <= SHELTER_WALK_S;
    // No turn-back point on the way to a shelter, or when the start is already past the limits: the verdict says so instead.
    if (!rover && !oneWay && within(0)) {
      // Walk the route until either rule breaks: energy to get home, or the 60 min walk to shelter.
      let along = 0;
      for (let k = 1; k < points.length; k += 1) {
        if (!within(k)) {
          trip.turnBack = points[k - 1];
          trip.turnBackM = along;
          break;
        }
        along += Math.hypot(points[k].x - points[k - 1].x, points[k].z - points[k - 1].z);
      }
    }
    const leftShare = Math.round(((haveJ - needJ) / budgetJ) * 100);
    const what = rover ? 'battery' : 'suit energy';
    const where = oneWay ? 'on arrival' : rover ? 'after the drive back' : 'back at shelter';
    const set = (verdict: Feasibility, reason: string) => {
      trip.verdict = verdict;
      trip.reason = reason;
    };
    if (!Number.isFinite(needJ) || !Number.isFinite(shelterS)) {
      set('FAIL', 'No-go slopes cut part of this route off from shelter on foot.');
    } else if (needJ > haveJ) {
      const turn = trip.turnBackM;
      set('FAIL', rover
        ? `Not enough battery for the trip${oneWay ? '' : ' there and back'}: it needs ${Math.round((needJ / budgetJ) * 100)} %, the rover has ${Math.round(reserve * 100)} %.`
        : `Not enough suit energy to get ${oneWay ? 'there' : 'back'}: the trip needs ${Math.round((needJ / budgetJ) * 100)} % of a full suit, you have ${Math.round(reserve * 100)} %.${turn > 0 && turn < out.distanceM * 0.95 && !oneWay ? ` Turn back by ${(turn / 1000).toFixed(1)} km.` : ''}`);
    } else if (rover && farJ > context.suit * SUIT_ENERGY_J) {
      set('FAIL', `If the rover broke down at the far end, the walk back to the lander needs more suit energy than you have (${Math.round(context.suit * 100)} %).`);
    } else if (!rover && shelterS > SHELTER_WALK_S) {
      set('MARGINAL', `Up to ${Math.round(shelterS / 60)} min from shelter at the ${MODEL.shelterPace.value} km/h suit-failure pace. NASA's walk-back test covered ${MODEL.shelterWalk.value} min: park the rover closer${trip.turnBackM > 0 ? ` or turn back by ${(trip.turnBackM / 1000).toFixed(1)} km` : ''}.`);
    } else if (haveJ - needJ < (MODEL.marginal.value / 100) * budgetJ) {
      set('MARGINAL', `Only ${leftShare} % ${what} left ${where}, under the ${MODEL.marginal.value} % margin.`);
    } else {
      set('PASS', `${leftShare} % ${what} left ${where}.`);
    }
    return trip;
  }

  /** A* over the 10 m grid. Returns null when the goal cannot be reached within the slope limit. */
  private search(start: RoutePoint, goal: RoutePoint, profile: TravelProfile, kind: RouteKind): RoutePoint[] | null {
    const analysis = this.analysis;
    const s = analysis.index(start.x, start.z);
    const t = analysis.index(goal.x, goal.z);
    const { g, from, closed } = this;
    // Standing on no-go ground already (e.g. dropped there): allow the first step out.
    const escaping = analysis.effectiveSlope(s) >= profile.maxSlope;
    g.fill(Infinity);
    closed.fill(0);
    from.fill(-1);
    const heap = new Heap();
    const tx = t % GRID;
    const tz = Math.floor(t / GRID);
    // Admissible: straight-line time at flat-ground speed.
    // Effort costs are energy divided by level-ground power; downhill can cost a little less than level, hence the 0.8.
    const optimism = kind === 'effort' ? 0.8 : 1;
    const heuristic = (index: number) => (optimism * Math.hypot((index % GRID) - tx, Math.floor(index / GRID) - tz) * analysis.cell) / profile.speed;
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
        const cost = this.stepCost(current, next, step * analysis.cell, profile, kind, next === t || (escaping && current === s));
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
    if (cells.length < 2) return [{ x: start.x, z: start.z }, { x: goal.x, z: goal.z }];
    const points = cells.map((c) => analysis.cellCenter(c, { x: 0, z: 0 }));
    points[0] = { x: start.x, z: start.z };
    points[points.length - 1] = { x: goal.x, z: goal.z };
    return smooth(points, (p) => analysis.effectiveSlope(analysis.index(p.x, p.z)) < profile.maxSlope);
  }

  /** Cost in seconds of entering a cell, weighted by what this route type cares about. */
  private stepCost(from: number, cell: number, length: number, profile: TravelProfile, kind: RouteKind, endpoint: boolean): number {
    const analysis = this.analysis;
    const slope = analysis.effectiveSlope(cell);
    // The clicked cell is always enterable, so a route can end at a steep target and be rated honestly.
    if (slope >= profile.maxSlope && !endpoint) return Infinity;
    // Speed and effort follow the slope along the step, so uphill and downhill differ.
    const grade = gradeDeg(analysis.height[cell] - analysis.height[from], length);
    const speed = pace(profile.mode, grade);
    const time = length / speed;
    if (kind === 'fastest') return time;
    if (kind === 'effort') return travelEnergyJ(profile.mode, length, grade, speed) / LEVEL_WALK_W;
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

/** Round off the grid staircase; a point stays put if moving it would put it on no-go ground. */
function smooth(points: RoutePoint[], passable: (point: RoutePoint) => boolean): RoutePoint[] {
  if (points.length < 4) return points;
  let current = points;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = [current[0]];
    for (let k = 1; k < current.length - 1; k += 1) {
      const moved = {
        x: current[k - 1].x * 0.25 + current[k].x * 0.5 + current[k + 1].x * 0.25,
        z: current[k - 1].z * 0.25 + current[k].z * 0.5 + current[k + 1].z * 0.25,
      };
      next.push(passable(moved) ? moved : current[k]);
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
        whole_trip_min: Math.round(route.stats.trip.totalS / 60), whole_trip_dose_uSv: Number(route.stats.trip.doseUSv.toFixed(2)),
        whole_trip_check: route.stats.trip.verdict, whole_trip_reason: route.stats.trip.reason,
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
