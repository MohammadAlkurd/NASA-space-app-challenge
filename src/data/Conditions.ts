import { MODEL, c } from '../planning/Models';
import type { SpaceWeather, Weather } from './Environment';

/** 'clear' is the measured weather-station sol. 'dust' and 'solar' are modelled drills, labelled as such in the UI. */
export type Scenario = 'clear' | 'dust' | 'solar';
export type Verdict = 'GO' | 'GO WITH CARE' | 'NO-GO';

export interface Conditions {
  scenario: Scenario;
  /** Dust optical depth of the atmosphere (tau): measured on the clear sol; in the drill, Curiosity's 2018 global-storm peak. */
  tau: number;
  windMs: number;
  /** Multiplier on travel speed (poor visibility slows everything down). */
  speedFactor: number;
  /** Multiplier on the cosmic-ray background dose rate. */
  doseFactor: number;
  /** Sunlight reaching a flat panel, W/m2, before terrain shadow. */
  solarWm2: number;
  verdict: Verdict;
  /** Worst reason first; empty when everything is nominal. */
  reasons: string[];
}

/** Mean sunlight at Mars' distance from the Sun, W/m2 (varies about 490-715 over the Martian year). */
const SOLAR_CONSTANT = 590;

/** The weather limits behind the verdict. None is a measured or published limit: they are our planning choices. */
export const LIMITS = {
  darkSun: c(5, '°', 'ASSUMPTION', 'Sun height above the horizon below which it is too dark to be out', 'Ours'),
  lowSun: c(15, '°', 'ASSUMPTION', 'Sun height below which long shadows hide rocks', 'Ours'),
  deepCold: c(-65, '°C', 'ASSUMPTION', 'Air temperature below which the suit heaters are taken to drain power faster', 'Ours'),
  gust: c(8, 'm/s', 'ASSUMPTION', 'Wind above which the sol is called gusty', 'Ours'),
  stormSlow: c(30, '%', 'ASSUMPTION', 'How much slower travel is in the dust-storm drill', 'Ours'),
  stormWind: c(18, 'm/s', 'ASSUMPTION', 'Least wind in the dust-storm drill', 'Ours'),
} as const;

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
  const tau = dust ? weather.stormTau : weather.tau;
  const windMs = dust ? Math.max(weather.windMs * 2.2, LIMITS.stormWind.value) : weather.windMs;
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
  if (dust) raise('NO-GO', 'Dust storm: sunlight and solar power collapse, and flat light hides rocks and slopes. Stay in or return to shelter.');
  if (weather.sunElevationDeg < LIMITS.darkSun.value) raise('NO-GO', 'Too dark: the sun is at the horizon.');
  else if (weather.sunElevationDeg < LIMITS.lowSun.value) raise('GO WITH CARE', 'Low sun: long shadows hide rocks, and night cold is close.');
  if (weather.airTempC < LIMITS.deepCold.value) raise('GO WITH CARE', `Deep cold (${weather.airTempC.toFixed(0)} °C): suit heaters drain power faster.`);
  if (!dust && windMs > LIMITS.gust.value) raise('GO WITH CARE', `Gusty (${windMs.toFixed(0)} m/s): dust devils are likely in the afternoon.`);
  if (space.status === 'elevated') raise('GO WITH CARE', 'Fast solar eruption reported: watch for a particle alert.');
  return {
    scenario,
    tau,
    windMs,
    speedFactor: dust ? 1 - LIMITS.stormSlow.value / 100 : 1,
    // Curiosity's RAD saw the surface dose rate rise 2 to 3 times in the September 2017 storm; the drill uses the top of that.
    doseFactor: solarStorm ? MODEL.stormDose.value : 1,
    solarWm2: solarFlux(weather.sunElevationDeg, tau),
    verdict,
    reasons,
  };
}
