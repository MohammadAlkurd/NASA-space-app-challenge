import { HOUR_SECONDS } from '../data/Environment';
import type { TravelProfile } from '../entities/Explorer';
import { Analysis, GRID, doseRate } from './Analysis';
import { abortRules, checklistRows, type ChecklistRow } from './Checklist';
import type { Contingency } from './Contingency';
import { basisText, safetyExport, type SafetyRule } from './Safety';
import {
  MODEL, ROVER_BATTERY_WH, SHELTER_WALK_S, STOP_S, SUIT_ENERGY_J, WORK_RATE_W, gradeDeg, pace, suitSupplies, travelEnergyJ,
  slopeLimits,
} from './Models';
import { clock } from './Timeline';

export { ROVER_BATTERY_WH } from './Models';

export type RouteKind = 'safest' | 'fastest' | 'effort' | 'science' | 'shielded' | 'linked' | 'custom';
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
  /** Metres of the way out where terrain hides the lander antenna: no direct radio link. */
  noLinkM: number;
}

export type Feasibility = 'PASS' | 'MARGINAL' | 'FAIL';

/** One line of the Marswalk checklist: what the suit and the clock should read at a point of the outing. */
export interface Checkpoint {
  kind: 'start' | 'way' | 'turn' | 'arrive' | 'leave' | 'home';
  name: string;
  /** Where on the map; null for a walk home that ends at a shelter off the planned path. */
  point: RoutePoint | null;
  /** Metres travelled so far; NaN when the way home leaves no-go ground out of reach. */
  distanceM: number;
  /** Seconds after leaving, in the weather the trip was planned for. */
  atS: number;
  /** Steepest ground on the leg that ends here, degrees; NaN for a walk home off the planned path. */
  slopeDeg: number;
  /** Share left, 0..1: suit energy on foot, battery in the rover. */
  energy: number;
  /** Share of the suit's oxygen and cooling water left; null in the rover, where the cabin supplies both. */
  oxygen: number | null;
  water: number | null;
  doseUSv: number;
  /** Walk from here to the nearest shelter at the suit-failure pace, seconds. */
  shelterS: number;
  /** Least energy share needed here to finish the plan and keep the reserve margin; null once home. */
  goOn: number | null;
}

/** Running totals at every route point, one way. */
export interface Track {
  distM: number[];
  /** Seconds since leaving, in the planned weather. */
  atS: number[];
  doseUSv: number[];
  usedJ: number[];
  slopeDeg: number[];
  /** Share of suit energy or battery left; filled in by the trip check. */
  left: number[];
}

export interface Trip {
  /** True when the route ends at a shelter, so nothing has to be kept for a way back. */
  oneWay: boolean;
  /** Seconds for the whole outing. */
  totalS: number;
  /** Same unit as `RouteStats.resource`, for the whole outing. */
  resource: number;
  doseUSv: number;
  /** Seconds spent at the destination, and the dose collected there; 0 on a one-way trip. */
  stopS: number;
  stopDoseUSv: number;
  checkpoints: Checkpoint[];
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
  track: Track;
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

export function rate(slope: number, roughness: number, profile: TravelProfile, coarse = 0): { rating: Rating; reason: string } {
  const mid = slopeLimits(profile.mode).steep;
  const who = profile.mode === 'rover' ? 'rover' : 'suit';
  if (slope >= profile.maxSlope) {
    return { rating: 'NO-GO', reason: `Slope ${slope.toFixed(0)}° is over the ${profile.maxSlope}° ${who} limit: tip-over or fall risk` };
  }
  if (slope >= mid) return { rating: 'DANGER', reason: `Steep ${slope.toFixed(0)}° slope, close to the ${profile.maxSlope}° ${who} limit` };
  if (slope >= profile.cautionSlope) return { rating: 'BE CAREFUL', reason: `Slope ${slope.toFixed(0)}°: slow, slippery going` };
  if (roughness > 0.35) return { rating: 'BE CAREFUL', reason: 'Rough ground: rocks or sand ripples' };
  if (coarse) return { rating: 'BE CAREFUL', reason: 'Low-detail NASA elevation data here (20 m): slopes are uncertain' };
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
    if (this.analysis.signal) add('linked', 'In radio range');
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
      worst: 'SAFE', noGoM: 0, cautionM: 0, noLinkM: 0,
      trip: { oneWay: false, totalS: 0, resource: 0, doseUSv: 0, stopS: 0, stopDoseUSv: 0, checkpoints: [], shelterS: 0, turnBack: null, turnBackM: 0, verdict: 'PASS', reason: '' },
    };
    const mover = profile.mode;
    // The same path walked the other way: slopes reverse, so time and energy differ.
    const back = { s: 0, j: 0, dose: 0 };
    const track: Track = { distM: [0], atS: [0], doseUSv: [0], usedJ: [0], slopeDeg: [0], left: [] };
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
      const { rating, reason } = rate(slope, analysis.roughness[cell], profile, analysis.coarse[cell]);
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
      track.distM.push(stats.distanceM);
      track.atS.push(stats.durationS / context.speedFactor);
      track.doseUSv.push(stats.doseUSv / context.speedFactor);
      track.usedJ.push(energyJ);
      track.slopeDeg.push(slope);
      if (rating === 'NO-GO') stats.noGoM += length;
      if (rating !== 'SAFE') stats.cautionM += length;
      if (analysis.signal && !analysis.signal[cell]) stats.noLinkM += length;
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
    stats.trip = this.trip(points, profile, stats, back, track, context);
    return { kind, label, points, ratings, segments, stats, track, stops: [] };
  }

  /** The whole outing checked against the hard limits: energy to get back, and the walk to shelter. */
  private trip(
    points: RoutePoint[], profile: TravelProfile, out: RouteStats, back: { s: number; j: number; dose: number },
    track: Track, context: TripContext,
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
    const { usedJ } = track;
    const outJ = usedJ[usedJ.length - 1];
    let shelterS = 0;
    let farJ = 0;
    for (const cell of cells) {
      shelterS = Math.max(shelterS, contingency.slowS[cell]);
      farJ = Math.max(farJ, contingency.homeJ[cell]);
    }
    // The way back: the same path when it started at a shelter (or by rover), else the walk to the nearest shelter.
    const samePath = rover || near(points[0]);
    const home = samePath
      ? { ...back, m: out.distanceM }
      : { s: contingency.planS[endCell], j: contingency.planJ[endCell], dose: (doseRate(analysis.skyView[endCell]) * contingency.planS[endCell]) / 3600, m: contingency.planM[endCell] };
    // Cut off from shelter: the trip fails below; keep the totals finite for the clock and the card.
    const reachable = Number.isFinite(home.s);
    const stopJ = (rover ? MODEL.roverElectronics.value : WORK_RATE_W) * STOP_S;
    const needJ = oneWay ? outJ : outJ + stopJ + home.j;
    const round = !oneWay && reachable;
    const stopS = round ? STOP_S : 0;
    const stopDoseUSv = (doseRate(analysis.skyView[endCell]) * stopS) / 3600;
    const trip: Trip = {
      oneWay,
      totalS: round ? out.durationS + stopS + home.s : out.durationS,
      resource: unit(reachable ? needJ : outJ),
      doseUSv: round ? out.doseUSv + stopDoseUSv + home.dose : out.doseUSv,
      stopS,
      stopDoseUSv,
      checkpoints: [],
      shelterS,
      turnBack: null,
      turnBackM: 0,
      verdict: 'PASS',
      reason: '',
    };
    const haveJ = reserve * budgetJ;
    const within = (k: number) => usedJ[k] + contingency.homeJ[cells[k]] <= haveJ && contingency.slowS[cells[k]] <= SHELTER_WALK_S;
    // No turn-back point on the way to a shelter, or when the start is already past the limits: the verdict says so instead.
    let turnIndex = -1;
    if (!rover && !oneWay && within(0)) {
      // Walk the route until either rule breaks: energy to get home, or the 60 min walk to shelter.
      for (let k = 1; k < points.length; k += 1) {
        if (!within(k)) {
          turnIndex = k - 1;
          trip.turnBack = points[turnIndex];
          trip.turnBackM = track.distM[turnIndex];
          break;
        }
      }
    }
    track.left = usedJ.map((j) => reserve - j / budgetJ);
    // Checklist lines: a checkpoint about every 500 m on foot (2 km by rover), five legs at most, plus the turn-back point.
    const last = points.length - 1;
    const legs = Math.min(5, Math.max(1, Math.ceil(out.distanceM / (rover ? 2000 : 500))));
    const stops = new Set<number>();
    for (let k = 1, next = 1; k < last && next < legs; k += 1) {
      if (track.distM[k] >= (next * out.distanceM) / legs) {
        stops.add(k);
        next += 1;
      }
    }
    if (turnIndex > 0) stops.add(turnIndex);
    const slow = 1 / context.speedFactor;
    const line = (kind: Checkpoint['kind'], name: string, k: number, more = { s: 0, j: 0, dose: 0, m: 0 }, slopeDeg = 0): Checkpoint => {
      const spentJ = usedJ[k] + more.j;
      const suit = suitSupplies((1 - reserve) * SUIT_ENERGY_J + spentJ);
      return {
        kind, name, slopeDeg,
        point: kind !== 'home' || oneWay ? points[k] : samePath ? points[0] : null,
        distanceM: track.distM[k] + more.m,
        atS: track.atS[k] + more.s,
        energy: reserve - spentJ / budgetJ,
        oxygen: rover ? null : suit.oxygen,
        water: rover ? null : suit.water,
        doseUSv: track.doseUSv[k] + more.dose,
        shelterS: kind === 'home' ? 0 : contingency.slowS[cells[k]],
        goOn: kind === 'home' || !reachable ? null : Math.max(0, (needJ - spentJ) / budgetJ) + MODEL.marginal.value / 100,
      };
    };
    const steepest = (from: number, to: number) => {
      let slope = 0;
      for (let k = from + 1; k <= to; k += 1) slope = Math.max(slope, track.slopeDeg[k]);
      return slope;
    };
    trip.checkpoints.push(line('start', 'Start', 0));
    let before = 0;
    let number = 0;
    for (const k of [...stops].sort((a, b) => a - b)) {
      if (k === turnIndex) trip.checkpoints.push(line('turn', 'Turn-back point', k, undefined, steepest(before, k)));
      else trip.checkpoints.push(line('way', `Checkpoint ${number += 1}`, k, undefined, steepest(before, k)));
      before = k;
    }
    trip.checkpoints.push(line(oneWay ? 'home' : 'arrive', oneWay ? 'Shelter' : 'Destination', last, undefined, steepest(before, last)));
    if (round) {
      const stay = { s: stopS, j: stopJ, dose: stopDoseUSv, m: 0 };
      trip.checkpoints.push(line('leave', 'Leave destination', last, stay));
      trip.checkpoints.push(line(
        'home', rover ? 'Back at the start' : 'Back at shelter', last,
        { s: stopS + home.s * slow, j: stopJ + home.j, dose: stopDoseUSv + home.dose * slow, m: home.m },
        samePath ? out.maxSlopeDeg : NaN,
      ));
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
    // In radio range: ground out of sight of the lander antenna costs four times as much.
    const hidden = kind === 'linked' && analysis.signal && !analysis.signal[cell] ? 4 : 1;
    if (kind !== 'safest') return time * (1 + 3 * over * over + 0.5 * rough) * hidden;
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

type LatLon = (x: number, z: number) => { lat: number; lon: number };
type Elevation = (x: number, z: number) => number;

export function toGeoJSON(route: Route, toLatLon: LatLon, elevation: Elevation, traveller: string, startHour = 0, doseFactor = 1, safety: SafetyRule[] = []): string {
  const position = (p: RoutePoint) => {
    const { lat, lon } = toLatLon(p.x, p.z);
    return [Number(lon.toFixed(6)), Number(lat.toFixed(6)), Number(elevation(p.x, p.z).toFixed(1))];
  };
  const rows = checklistRows(route, startHour, doseFactor);
  const end = rows[rows.length - 1];
  const checkpoints = rows.flatMap((row, k) => {
    const point = route.stats.trip.checkpoints[k].point;
    return point ? [{
      type: 'Feature',
      properties: {
        checkpoint: row.name, clock: row.clock, elapsed_min: row.elapsedMin, distance_m: row.distanceM, steepest_slope_deg: row.slopeDeg,
        energy_left_pct: row.energyPct, oxygen_left_pct: row.oxygenPct, cooling_water_left_pct: row.waterPct,
        dose_uSv: row.doseUSv, shelter_walk_min: row.shelterMin, go_on_only_above_energy_pct: row.goOnPct,
      },
      geometry: { type: 'Point', coordinates: position(point) },
    }] : [];
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
        whole_trip_min: end.elapsedMin, whole_trip_dose_uSv: end.doseUSv,
        whole_trip_check: route.stats.trip.verdict, whole_trip_reason: route.stats.trip.reason,
        leave_clock: rows[0].clock, back_clock: end.clock,
        energy_left_at_end_pct: end.energyPct, oxygen_left_at_end_pct: end.oxygenPct, cooling_water_left_at_end_pct: end.waterPct,
        turn_back_by_m: route.stats.trip.turnBack ? Math.round(route.stats.trip.turnBackM) : null,
        no_radio_link_m: Math.round(route.stats.noLinkM),
        abort_rules: abortRules(route, rows),
        safety_rules: safetyExport(safety),
      },
      geometry: { type: 'LineString', coordinates: route.points.map(position) },
    }, ...checkpoints],
  }, null, 1);
}

/** One row per route point on the way out, then the checklist lines for leaving the stop and getting home. */
export function toCSV(route: Route, toLatLon: LatLon, elevation: Elevation, startHour = 0, doseFactor = 1, safety: SafetyRule[] = []): string {
  const { track, stats } = route;
  const rows = checklistRows(route, startHour, doseFactor);
  // Lines that sit on the way out; leaving the stop and getting home are added after the track.
  const named = new Map<RoutePoint, ChecklistRow>();
  stats.trip.checkpoints.forEach((c, k) => {
    const after = c.kind === 'leave' || (c.kind === 'home' && !stats.trip.oneWay);
    if (c.point && !after && !named.has(c.point)) named.set(c.point, rows[k]);
  });
  const rover = rows[0].oxygenPct === null;
  const out = ['point,lat_deg,lon_deg_east,elevation_m,rating,checkpoint,clock,distance_m,energy_left_pct,oxygen_left_pct,cooling_water_left_pct,dose_uSv,shelter_walk_min,go_on_only_above_energy_pct,rule_kind,rule'];
  const columns = out[0].split(',').length;
  // Quoted the RFC 4180 way, so commas in names and rule text stay inside one field.
  const text = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const share = (value: number) => Math.round(Math.max(0, value) * 100);
  route.points.forEach((p, k) => {
    const { lat, lon } = toLatLon(p.x, p.z);
    const suit = suitSupplies((1 - track.left[k]) * SUIT_ENERGY_J);
    const on = named.get(p);
    out.push([
      k, lat.toFixed(6), lon.toFixed(6), elevation(p.x, p.z).toFixed(1), route.ratings[k], text(on?.name ?? ''),
      clock(startHour + track.atS[k] / HOUR_SECONDS), Math.round(track.distM[k]), share(track.left[k]),
      rover ? '' : share(suit.oxygen), rover ? '' : share(suit.water), (track.doseUSv[k] * doseFactor).toFixed(1),
      on?.shelterMin ?? '', on?.goOnPct ?? '', '', '',
    ].join(','));
  });
  rows.forEach((row, k) => {
    if (stats.trip.oneWay || (row.kind !== 'leave' && row.kind !== 'home')) return;
    const p = stats.trip.checkpoints[k].point;
    const where = p ? toLatLon(p.x, p.z) : null;
    out.push([
      '', where?.lat.toFixed(6) ?? '', where?.lon.toFixed(6) ?? '', p ? elevation(p.x, p.z).toFixed(1) : '', '', text(row.name),
      row.clock, row.distanceM ?? '', row.energyPct, row.oxygenPct ?? '', row.waterPct ?? '', row.doseUSv, row.shelterMin ?? '', row.goOnPct ?? '', '', '',
    ].join(','));
  });
  // The rules follow as rows of the same width, with only the last two columns filled.
  const rule = (kind: string, body: string) => out.push(`${','.repeat(columns - 2)}${kind},${text(body)}`);
  for (const line of abortRules(route, rows)) rule('abort_rule', line);
  for (const line of safety) rule('safety_rule', `${line.name}. ${line.action} ${line.why} [${basisText(line.basis)}]`);
  return out.join('\n');
}
