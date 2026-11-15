import { LIMITS, type Conditions } from '../data/Conditions';
import { MODEL, SHELTER_WALK_S, SUIT_ENERGY_J, c, slopeLimits, suitSupplies, type Constant } from './Models';

/**
 * The safety rules, in order of urgency. The "What to do now" card, the Safety guide sheet, the printed checklist
 * and the route exports all read this list. Every number is a constant from Models.ts or Conditions.ts.
 */
export interface SafetyState {
  conditions: Conditions;
  sunElevationDeg: number;
  airTempC: number;
  rover: boolean;
  /** Camped in the rover, or on foot inside the lander's safe zone. */
  sheltered: boolean;
  /** On foot: seconds to the nearest shelter at the suit-failure pace. */
  shelterWalkS: number;
  /** Suit energy to walk to the nearest shelter, joules. In the rover: to walk home to the lander if it breaks down. */
  walkHomeJ: number;
  /** Suit energy used since the last refill, joules. */
  suitUsedJ: number;
  slopeDeg: number;
}

export type Tone = 'nogo' | 'care';

export interface SafetyRule {
  id: string;
  /** The situation in a few words; the card shows it as the reason. */
  name: string;
  signal: string;
  action: string;
  why: string;
  /** The numbers behind the rule, each with its label and source. */
  basis: Constant[];
  tone: Tone;
  /** The number behind the rule when it applies now, else null; `action` replaces the general one where the crew's place changes it. */
  check(s: SafetyState): { number: string; action?: string } | null;
}

export interface Advice {
  id: string;
  tone: Tone;
  action: string;
  reason: string;
  number: string;
}

const pct = (share: number) => Math.round(Math.max(0, share) * 100);
const walk = slopeLimits('astronaut');
const drive = slopeLimits('rover');

/** `stormTau` is the dust optical depth the site's storm drill uses, with where it was measured. */
export function safetyRules(stormTau: number, stormTauSource: string): SafetyRule[] {
  const storm = c(stormTau, 'τ', 'MEASURED', 'Dust optical depth in the dust-storm drill', stormTauSource);
  return [
    {
      id: 'solar',
      name: 'Solar particle storm',
      signal: `Solar storm alert: the dose rate is about ${MODEL.stormDose.value} times normal.`,
      action: 'Get inside the rover or the lander and stay there.',
      why: `Radiation is far above normal for about ${MODEL.stormPeak.value} h. Inside, the planner counts ${MODEL.shelterDose.value} of the open-ground dose.`,
      basis: [MODEL.stormDose, MODEL.stormPeak, MODEL.shelterDose],
      tone: 'nogo',
      check: (s) => (s.conditions.doseFactor > 1 ? {
        number: `dose ×${s.conditions.doseFactor}`,
        action: s.sheltered ? 'Stay in shelter.' : s.rover ? 'Park and press R to camp in the rover.' : undefined,
      } : null),
    },
    {
      id: 'dust',
      name: 'Dust storm',
      signal: 'Dust storm: the sky turns brown and the sun fades.',
      action: 'Go back to the rover or the lander and wait it out.',
      why: `Sunlight and solar power collapse, flat light hides rocks and slopes, and travel is ${LIMITS.stormSlow.value} % slower.`,
      basis: [storm, LIMITS.stormSlow, LIMITS.stormWind],
      tone: 'nogo',
      check: (s) => (s.conditions.scenario === 'dust' ? {
        number: `dust τ ${s.conditions.tau.toFixed(2)}, sunlight ${Math.round(s.conditions.solarWm2)} W/m²`,
        action: s.sheltered ? 'Stay in shelter.' : s.rover ? 'Park and press R to camp in the rover.' : undefined,
      } : null),
    },
    {
      id: 'shelter',
      name: 'Too far from shelter',
      signal: `On foot, more than a ${MODEL.shelterWalk.value} min walk from the rover or the lander.`,
      action: 'Walk back toward the rover or the lander.',
      why: `If the suit CO₂ scrubber fails you have to reach shelter on foot. NASA tested a ${MODEL.shelterWalk.value} min walk at ${MODEL.shelterPace.value} km/h.`,
      basis: [MODEL.shelterWalk, MODEL.shelterPace],
      tone: 'nogo',
      check: (s) => (!s.rover && !s.sheltered && s.shelterWalkS > SHELTER_WALK_S ? {
        number: Number.isFinite(s.shelterWalkS) ? `${Math.round(s.shelterWalkS / 60)} min walk, limit ${MODEL.shelterWalk.value} min` : 'no walkable way to shelter',
      } : null),
    },
    {
      id: 'walkback',
      name: 'Rover too far to walk home',
      signal: 'In the rover, farther from the lander than one suit backpack can walk.',
      action: 'Drive back toward the lander.',
      why: `If the rover breaks down the crew walks home on one backpack (${MODEL.suitEnergy.value} kJ of effort). NASA tested a suited ${MODEL.walkBackTest.value} km walk home.`,
      basis: [MODEL.suitEnergy, MODEL.walkBackTest],
      tone: 'nogo',
      check: (s) => (s.rover && !s.sheltered && s.walkHomeJ > SUIT_ENERGY_J - s.suitUsedJ ? {
        number: Number.isFinite(s.walkHomeJ) ? `walk home needs ${pct(s.walkHomeJ / SUIT_ENERGY_J)} % of a suit, ${pct(1 - s.suitUsedJ / SUIT_ENERGY_J)} % left` : 'no walkable way home',
      } : null),
    },
    {
      id: 'supplies',
      name: 'Suit at the turn-back level',
      signal: `Suit energy, oxygen or cooling water below what the walk to shelter needs plus the ${MODEL.marginal.value} % reserve.`,
      action: 'Turn back to the nearest shelter now.',
      why: `Going on would cut into the ${MODEL.marginal.value} % reserve. Oxygen and cooling water drain in step with effort, so all three gauges reach this level together.`,
      basis: [MODEL.marginal, MODEL.suitEnergy, MODEL.oxygenTank, MODEL.waterTank],
      tone: 'nogo',
      check: (s) => {
        if (s.rover || s.sheltered || !Number.isFinite(s.walkHomeJ)) return null;
        const left = suitSupplies(s.suitUsedJ);
        const need = s.walkHomeJ / SUIT_ENERGY_J + MODEL.marginal.value / 100;
        return left.energy < need
          ? { number: `suit energy ${pct(left.energy)} %, need ${Math.ceil(need * 100)} % (oxygen ${pct(left.oxygen)} %, water ${pct(left.water)} %)` }
          : null;
      },
    },
    {
      id: 'dark',
      name: 'Too dark',
      signal: `The sun is lower than ${LIMITS.darkSun.value}° above the horizon.`,
      action: 'Go back to shelter and wait for daylight.',
      why: 'You cannot see rocks and slopes, and the night cold follows.',
      basis: [LIMITS.darkSun],
      tone: 'nogo',
      check: (s) => (s.sunElevationDeg < LIMITS.darkSun.value ? {
        number: `sun ${s.sunElevationDeg.toFixed(0)}°, limit ${LIMITS.darkSun.value}°`,
        action: s.sheltered ? 'Stay in until sunrise.' : s.rover ? 'Park and press R to camp until sunrise.' : undefined,
      } : null),
    },
    {
      id: 'cold',
      name: 'Deep cold',
      signal: `Air colder than ${LIMITS.deepCold.value} °C.`,
      action: 'Keep the trip short and stay close to shelter.',
      why: 'Suit heaters drain power faster in deep cold.',
      basis: [LIMITS.deepCold],
      tone: 'care',
      check: (s) => (s.airTempC < LIMITS.deepCold.value ? { number: `${s.airTempC.toFixed(0)} °C, limit ${LIMITS.deepCold.value} °C` } : null),
    },
    {
      id: 'gust',
      name: 'Gusty wind',
      signal: `Wind above ${LIMITS.gust.value} m/s.`,
      action: 'Watch for dust devils and keep clear of them.',
      why: `Whirlwinds form on windy afternoons: Perseverance logged up to ${MODEL.dustDevilPeak.value} an hour around noon.`,
      basis: [LIMITS.gust, MODEL.dustDevilPeak],
      tone: 'care',
      check: (s) => (s.conditions.scenario !== 'dust' && s.conditions.windMs > LIMITS.gust.value
        ? { number: `${s.conditions.windMs.toFixed(0)} m/s, limit ${LIMITS.gust.value} m/s` } : null),
    },
    {
      id: 'steep',
      name: 'Steep ground',
      signal: `Slope of ${walk.steep}° or more on foot (limit ${walk.limit}°), ${drive.steep}° or more in the rover (limit ${drive.limit}°).`,
      action: 'Stop and go around on gentler ground.',
      why: 'Fall risk on foot, tip-over risk in the rover.',
      basis: [MODEL.walkSlopeLimit, MODEL.walkSlopeCare, MODEL.roverSlopeLimit, MODEL.roverSlopeCare],
      tone: 'care',
      check: (s) => {
        const { steep, limit } = s.rover ? drive : walk;
        return !s.sheltered && s.slopeDeg >= steep ? { number: `slope ${s.slopeDeg.toFixed(0)}°, limit ${limit}°` } : null;
      },
    },
  ];
}

/** The single most urgent rule that applies now; null when nothing is wrong. */
export function advise(rules: SafetyRule[], state: SafetyState): Advice | null {
  for (const rule of rules) {
    const hit = rule.check(state);
    if (hit) return { id: rule.id, tone: rule.tone, action: hit.action ?? rule.action, reason: rule.name, number: hit.number };
  }
  return null;
}

export const basisText = (basis: Constant[]) => basis.map((b) => `${b.value} ${b.unit} ${b.label}: ${b.source}`).join('; ');

/** The rules as plain rows for the exports. */
export function safetyExport(rules: SafetyRule[]) {
  return rules.map((rule) => ({
    situation: rule.name,
    signal: rule.signal,
    action: rule.action,
    why: rule.why,
    numbers: rule.basis.map((b) => ({ value: b.value, unit: b.unit, label: b.label, what: b.what, source: b.source })),
  }));
}
