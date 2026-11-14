import { MODEL } from '../planning/Models';
import type { SpaceWeather, Weather } from './Environment';

/** 'clear' is the measured weather-station sol. 'dust' and 'solar' are modelled drills, labelled as such in the UI. */
export type Scenario = 'clear' | 'dust' | 'solar';
export type Verdict = 'GO' | 'GO WITH CARE' | 'NO-GO';

export interface Conditions {
  scenario: Scenario;
  /** Dust optical depth of the atmosphere (tau). About 0.5 on a clear sol; several in a dust storm. */
  tau: number;
  windMs: number;
  /** Multiplier on travel speed (poor visibility slows everything down). */
  speedFactor: number;
  /** Multiplier on the cosmic-ray background dose rate. */
  doseFactor: number;
  /** Sunlight reaching a flat panel, W/m2, before terrain shadow. */
  solarWm2: number;
  /** Scene haze multiplier for the renderer. */
  haze: number;
  verdict: Verdict;
  /** Worst reason first; empty when everything is nominal. */
  reasons: string[];
}

/** Mean sunlight at Mars' distance from the Sun, W/m2 (varies about 490-715 over the Martian year). */
const SOLAR_CONSTANT = 590;

/** Direct beam plus dust-scattered light on a horizontal surface: a simple two-term fit, not a radiative-transfer model. */
export function solarFlux(sunElevationDeg: number, tau: number): number {
  const sin = Math.sin((Math.max(0, sunElevationDeg) * Math.PI) / 180);
  if (sin <= 0) return 0;
  const direct = Math.exp(-tau / Math.max(sin, 0.05));
  // Dust scatters much of the lost beam forward to the ground; the share that arrives falls as dust thickens.
  const diffuse = (1 - direct) * 0.8 * Math.exp(-0.12 * tau);
  return SOLAR_CONSTANT * sin * (direct + diffuse);
}

export function assess(scenario: Scenario, weather: Weather, space: SpaceWeather): Conditions {
  const dust = scenario === 'dust';
  const solarStorm = scenario === 'solar' || space.status === 'storm';
  const tau = dust ? 4 : 0.5;
  const windMs = dust ? Math.max(weather.windMs * 2.2, 18) : weather.windMs;
  const reasons: string[] = [];
  let verdict: Verdict = 'GO';
  const raise = (level: Verdict, reason: string) => {
    if (level === 'NO-GO') {
      verdict = 'NO-GO';
      reasons.unshift(reason);
    } else {
      if (verdict === 'GO') verdict = level;
      reasons.push(reason);
    }
  };
  if (solarStorm) raise('NO-GO', 'Solar particle storm: radiation is far above normal. Get under shelter.');
  if (dust) raise('NO-GO', 'Dust storm: you cannot see hazards and solar power collapses. Stay in or return to the rover.');
  if (weather.sunElevationDeg < 5) raise('NO-GO', 'Too dark: the sun is at the horizon.');
  else if (weather.sunElevationDeg < 15) raise('GO WITH CARE', 'Low sun: long shadows hide rocks, and night cold is close.');
  if (weather.airTempC < -65) raise('GO WITH CARE', `Deep cold (${weather.airTempC.toFixed(0)} °C): suit heaters drain power faster.`);
  if (!dust && windMs > 8) raise('GO WITH CARE', `Gusty (${windMs.toFixed(0)} m/s): dust devils are likely in the afternoon.`);
  if (space.status === 'elevated') raise('GO WITH CARE', 'Fast solar eruption reported: watch for a particle alert.');
  return {
    scenario,
    tau,
    windMs,
    speedFactor: dust ? 0.7 : 1,
    // Curiosity's RAD saw the surface dose rate rise 2 to 3 times in the September 2017 storm; the drill uses the top of that.
    doseFactor: solarStorm ? MODEL.stormDose.value : 1,
    solarWm2: solarFlux(weather.sunElevationDeg, tau),
    haze: dust ? 9 : 1,
    verdict,
    reasons,
  };
}
