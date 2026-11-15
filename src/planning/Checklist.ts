import { HOUR_SECONDS } from '../data/Environment';
import { MODEL, SUIT_ENERGY_J, suitSupplies } from './Models';
import type { Checkpoint, Route } from './Router';
import { clock } from './Timeline';

/** One checklist line with the numbers ready to show or export. Shares are whole percent; null where they do not apply. */
export interface ChecklistRow {
  kind: Checkpoint['kind'];
  name: string;
  clock: string;
  elapsedMin: number;
  distanceM: number | null;
  slopeDeg: number | null;
  energyPct: number;
  oxygenPct: number | null;
  waterPct: number | null;
  doseUSv: number;
  shelterMin: number | null;
  /** Least energy share needed here to finish the plan and keep the reserve margin, percent. */
  goOnPct: number | null;
}

const pct = (share: number) => Math.round(Math.max(0, share) * 100);
const finite = (value: number) => (Number.isFinite(value) ? Math.round(value) : null);

/** The leg table for a route leaving at `startHour`; `doseFactor` is the storm multiplier on the dose rate. */
export function checklistRows(route: Route, startHour: number, doseFactor = 1): ChecklistRow[] {
  return route.stats.trip.checkpoints.map((c) => ({
    kind: c.kind,
    name: c.name,
    clock: clock(startHour + c.atS / HOUR_SECONDS),
    elapsedMin: Math.round(c.atS / 60),
    distanceM: finite(c.distanceM),
    slopeDeg: c.kind === 'start' || c.kind === 'leave' ? null : finite(c.slopeDeg),
    energyPct: pct(c.energy),
    oxygenPct: c.oxygen === null ? null : pct(c.oxygen),
    waterPct: c.water === null ? null : pct(c.water),
    doseUSv: Number((c.doseUSv * doseFactor).toFixed(1)),
    shelterMin: finite(c.shelterS / 60),
    goOnPct: c.goOn === null ? null : Math.ceil(c.goOn * 100),
  }));
}

/** Abort rules in plain words, one per decision point, then the standing rules. */
export function abortRules(route: Route, rows: ChecklistRow[]): string[] {
  const trip = route.stats.trip;
  const rover = rows[0].oxygenPct === null;
  const rules: string[] = [];
  for (const row of rows) {
    if (row.goOnPct === null || row.goOnPct > 100 || (row.kind !== 'way' && row.kind !== 'arrive')) continue;
    const then = `${row.kind === 'arrive' ? 'skip the stop and head back' : 'turn back'}: the rest of the plan would cut into the ${MODEL.marginal.value} % reserve`;
    if (rover) {
      rules.push(`If the battery is below ${row.goOnPct} % at ${row.name} (${row.clock}), ${then}.`);
      continue;
    }
    // Oxygen and water are used in step with effort, so the same rule can be read off any of the three gauges.
    const need = suitSupplies((1 - row.goOnPct / 100) * SUIT_ENERGY_J);
    rules.push(`If suit energy is below ${row.goOnPct} % at ${row.name} (${row.clock}), ${then}. The same point on the other gauges: oxygen below ${Math.ceil(need.oxygen * 100)} % or cooling water below ${Math.ceil(need.water * 100)} %.`);
  }
  if (trip.turnBack) rules.push(`Do not go past the turn-back point at ${(trip.turnBackM / 1000).toFixed(2)} km: beyond it the walk home breaks the suit-energy rule or the ${MODEL.shelterWalk.value} min shelter rule.`);
  if (!rover) rules.push(`If the suit CO₂ scrubber fails, walk to the nearest shelter at once. "Shelter walk" is how long that takes at ${MODEL.shelterPace.value} km/h; NASA tested ${MODEL.shelterWalk.value} min.`);
  if (route.stats.noLinkM >= 10) rules.push(`Terrain hides the lander antenna for ${Math.round(route.stats.noLinkM / 10) * 10} m of the way out: no direct radio link there.`);
  rules.push(`On a solar storm alert, go to the ${rover ? 'lander' : 'rover or the lander'}: the dose rate rises about ${MODEL.stormDose.value} times.`);
  return rules;
}
