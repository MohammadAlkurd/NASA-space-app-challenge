import { assess, type Scenario, type Verdict } from '../data/Conditions';
import type { Environment } from '../data/Environment';

/** What a trip meets between leaving and arriving, from the measured weather table and the sun's position. */
export interface RouteTiming {
  startHour: number;
  endHour: number;
  minAirC: number;
  maxAirC: number;
  minSunDeg: number;
  /** Dose scaled for the active conditions (a solar storm raises it), µSv. */
  doseUSv: number;
  verdict: Verdict;
  /** Worst first. */
  warnings: string[];
  /** Best hour to leave on a clear sol, or null when leaving now is already within half an hour of it. */
  betterStart: number | null;
}

const STEP_H = 0.25;

function sample(environment: Environment, startHour: number, durationS: number) {
  const hours = durationS / 3600;
  let minAirC = Infinity;
  let maxAirC = -Infinity;
  let minSunDeg = Infinity;
  let darkH = 0;
  let coldH = 0;
  for (let t = 0; t <= hours + 1e-6; t += STEP_H) {
    const weather = environment.at((startHour + t) % 24);
    minAirC = Math.min(minAirC, weather.airTempC);
    maxAirC = Math.max(maxAirC, weather.airTempC);
    minSunDeg = Math.min(minSunDeg, weather.sunElevationDeg);
    if (weather.sunElevationDeg < 5) darkH += STEP_H;
    if (weather.airTempC < -65) coldH += STEP_H;
  }
  return { minAirC, maxAirC, minSunDeg, darkH, coldH };
}

/** Lower is better: darkness dominates, then deep cold, then how cold the coldest moment is. */
function penalty(environment: Environment, startHour: number, durationS: number): number {
  const s = sample(environment, startHour, durationS);
  return s.darkH * 100 + s.coldH * 20 + Math.max(0, -40 - s.minAirC) * 0.5 + Math.max(0, 15 - s.minSunDeg) * 0.5;
}

export function clock(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const whole = Math.floor(h);
  return `${String(whole).padStart(2, '0')}:${String(Math.floor((h - whole) * 60)).padStart(2, '0')}`;
}

export function timeRoute(
  environment: Environment, scenario: Scenario, startHour: number, durationS: number, doseUSv: number,
): RouteTiming {
  const s = sample(environment, startHour, durationS);
  const endHour = (startHour + durationS / 3600) % 24;
  const now = assess(scenario, environment.at(startHour), environment.spaceWeather);
  const warnings: string[] = [];
  let verdict: Verdict = now.verdict;
  const scenarioReason = now.scenario !== 'clear' || environment.spaceWeather.status === 'storm' ? now.reasons[0] : undefined;
  if (scenarioReason) warnings.push(scenarioReason);
  if (s.darkH > 0) {
    verdict = 'NO-GO';
    warnings.push(s.darkH * 3600 >= durationS
      ? 'The whole trip is in the dark: you cannot see rocks or slopes.'
      : `About ${Math.max(15, Math.round(s.darkH * 60))} min of this trip is in the dark.`);
  } else if (s.minSunDeg < 15) {
    if (verdict === 'GO') verdict = 'GO WITH CARE';
    warnings.push('Low sun on part of the trip: long shadows hide rocks.');
  }
  if (s.minAirC < -65) {
    if (verdict === 'GO') verdict = 'GO WITH CARE';
    warnings.push(`Deep cold on the way (down to ${s.minAirC.toFixed(0)} °C): suit heaters drain power faster.`);
  }
  let best = startHour;
  let bestPenalty = penalty(environment, startHour, durationS);
  for (let hour = 0; hour < 24; hour += 0.5) {
    const p = penalty(environment, hour, durationS);
    if (p < bestPenalty - 1e-6) {
      bestPenalty = p;
      best = hour;
    }
  }
  const apart = Math.min(Math.abs(best - startHour), 24 - Math.abs(best - startHour));
  return {
    startHour, endHour, minAirC: s.minAirC, maxAirC: s.maxAirC, minSunDeg: s.minSunDeg,
    doseUSv: doseUSv * now.doseFactor,
    verdict, warnings,
    betterStart: apart > 0.5 && warnings.length > (scenarioReason ? 1 : 0) ? best : null,
  };
}
