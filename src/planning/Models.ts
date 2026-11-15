/**
 * Every number the planner uses, with where it comes from. Pure functions, no rendering.
 * MEASURED: Mars instruments. ANALOG: Apollo or NASA suit tests. NASA STUDY: design documents. ASSUMPTION: ours.
 */
export type Label = 'MEASURED' | 'ANALOG' | 'NASA STUDY' | 'ASSUMPTION';

export interface Constant {
  value: number;
  unit: string;
  label: Label;
  what: string;
  source: string;
}

export const c = (value: number, unit: string, label: Label, what: string, source: string): Constant => ({ value, unit, label, what, source });

const SEXTANT = 'as coded in MIT SEXTANT (github.com/norheim/pextant)';
const SP368 = 'Waligora & Horrigan, NASA SP-368 (NTRS 19760005584)';
const WALKBACK = 'Norcross et al., suited 10 km walk-back test (NTRS 20080014853)';

export const MODEL = {
  gravity: c(3.71, 'm/s²', 'MEASURED', 'Mars surface gravity', 'NASA Mars fact sheet'),
  walkTopSpeed: c(1.6, 'm/s', 'ANALOG', 'Fastest suited walking pace (level ground), used for emergency walk-back', `Marquez 2008, ${SEXTANT}`),
  walkPlanSpeed: c(0.9, 'm/s', 'ASSUMPTION', 'Cap on the planned walking pace', 'Ours: an unhurried Apollo-like pace'),
  suitedMass: c(180, 'kg', 'ASSUMPTION', 'Astronaut plus suit', 'Ours: 80 kg person + 100 kg suit (the NASA walk-back test suit was 121 kg)'),
  suitEnergy: c(7530, 'kJ', 'ANALOG', 'Metabolic energy one suit backpack supports (1800 kcal)', `Apollo 15-17 backpack: ${SP368}`),
  workRate: c(975, 'kJ/h', 'ANALOG', 'Effort while standing or working at a stop (233 kcal/h)', `Apollo surface EVA average, quoted in ${WALKBACK}`),
  heatLimit: c(2090, 'kJ/h', 'ANALOG', 'Highest effort the cooling garment sustained (500 kcal/h)', SP368),
  oxygen: c(0.072, 'g/kJ', 'ANALOG', 'Oxygen used per unit of effort', `0.4 lb/h at 2374 BTU/h: ${WALKBACK}`),
  coolingWater: c(0.56, 'g/kJ', 'ANALOG', 'Cooling water used per unit of effort', `3.1 lb/h at 2374 BTU/h: ${WALKBACK}`),
  oxygenTank: c(652, 'g', 'ANALOG', 'Usable oxygen in one suit backpack', 'Apollo backpack: 472 g usable at 1020 psia, scaled to the Apollo 15-17 charge of 1410 psia (the scaling is ours): NASA TN D-8093 (NTRS 19760003073)'),
  waterTank: c(5200, 'g', 'ANALOG', 'Cooling water in one suit backpack (11.5 lb)', 'Apollo 15-17 backpack with its auxiliary tank: Apollo Lunar Surface Journal, PLSS page'),
  stopTime: c(30, 'min', 'ASSUMPTION', 'Time spent at the destination before heading back', 'Ours, adjustable'),
  marginal: c(20, '%', 'ASSUMPTION', 'A trip that leaves less than this is rated MARGINAL', 'Ours'),
  shelterWalk: c(60, 'min', 'ANALOG', 'Longest walk to a pressurised shelter if the suit CO₂ scrubber fails', 'NASA tested a 1 h, 2.0 km walk-back at 2.1 km/h or faster: Keller et al. 2024 (NTRS 20240013261)'),
  shelterPace: c(2.1, 'km/h', 'ANALOG', 'Walking pace assumed for that walk (slower on steep ground)', 'Slowest pace held in the same test: Keller et al. 2024 (NTRS 20240013261)'),
  walkBackTest: c(10, 'km', 'ANALOG', 'Suited walk NASA tested as the way home from a broken-down rover', WALKBACK),
  walkSlopeLimit: c(20, '°', 'ASSUMPTION', 'Steepest slope crossed on foot', 'Ours. The Marquez walking curve drops to a crawl beyond 15° uphill and 20° downhill'),
  walkSlopeCare: c(12, '°', 'ASSUMPTION', 'Slope on foot where the going gets slow and slippery', 'Ours'),
  roverSlopeLimit: c(25, '°', 'ASSUMPTION', 'Steepest slope driven in the crew rover', 'Ours: matches the steepest slopes the Apollo rovers drove (22 to 25°)'),
  roverSlopeCare: c(15, '°', 'ASSUMPTION', 'Slope in the rover where the going gets slow and risky', 'Ours'),
  roverSpeed: c(2.0, 'm/s', 'ANALOG', 'Crew rover planning speed', 'Apollo 15 as-driven mean; best case 2.6 m/s. Speed showed no strong link to slope or roughness: Jacob et al. (NTRS 20250011301)'),
  roverMass: c(4000, 'kg', 'NASA STUDY', 'Crew rover with payload', 'NASA Space Exploration Vehicle fact sheet: 6,600 lb vehicle + 2,200 lb payload'),
  roverLevel: c(0.216, 'J/(kg·m)', 'ANALOG', 'Rover drive energy on level ground in lunar gravity', `Carr 2001, ${SEXTANT}; scaled by Mars/Moon gravity (ASSUMPTION)`),
  roverUphill: c(0.02628, 'J/(kg·m·deg)', 'ANALOG', 'Extra rover drive energy per degree uphill, lunar gravity', `Carr 2001, ${SEXTANT}`),
  roverDownhill: c(0.007884, 'J/(kg·m·deg)', 'ANALOG', 'Extra rover drive energy per degree downhill, lunar gravity', `Carr 2001, ${SEXTANT}`),
  roverElectronics: c(1500, 'W', 'ANALOG', 'Rover electronics power, counted while driving and during the stop', `SEXTANT default, ${SEXTANT}`),
  roverBattery: c(30, 'kWh', 'ASSUMPTION', 'Crew rover battery', 'Ours, adjustable'),
  roverLights: c(100, 'W', 'ASSUMPTION', 'Rover headlights, while switched on', 'Ours: LED driving lamps'),
  helmetLamp: c(5, 'W', 'ASSUMPTION', 'Helmet lamp, while switched on (counted against the suit budget)', 'Ours: LED headlamp'),
  shelterDose: c(0.5, '×', 'ASSUMPTION', 'Share of the open-ground dose counted for a crew camped in the rover or sheltering at the lander', 'Ours: no measured figure for these cabins'),
  safeZone: c(30, 'm', 'ASSUMPTION', 'Radius around the lander where the crew can shelter in it and refill the suit', 'Ours'),
  stormDose: c(3, '×', 'MEASURED', 'Dose rate in a solar particle storm, relative to normal (measured 2 to 3; the planner uses 3)', 'Curiosity RAD, September 2017: Zeitlin et al. 2018, doi:10.1029/2018GL077760'),
  dustScaleHeight: c(11000, 'm', 'ASSUMPTION', 'Height the dust is taken to be mixed through, to turn the measured dust optical depth into how far you can see along the ground', 'Ours: the scale height of the Mars atmosphere (NASA Mars Fact Sheet, 11.1 km)'),
  dustDevilPeak: c(1.15, '/h', 'MEASURED', 'Whirlwinds passing Perseverance per hour at the busiest time, 12:00 to 13:00 (over four per sol; about a quarter carry dust). The app draws them from 09:00 to 17:00 around that peak', 'Newman et al. 2022, doi:10.1126/sciadv.abn3783'),
  stormPeak: c(12, 'h', 'MEASURED', 'How long that storm stayed at its peak, after rising for several hours', 'Zeitlin et al. 2018'),
} as const;

const MOON_G = 1.62;
export const MARS_G = MODEL.gravity.value;
export const SUIT_ENERGY_J = MODEL.suitEnergy.value * 1000;
export const WORK_RATE_W = (MODEL.workRate.value * 1000) / 3600;
export const ROVER_BATTERY_WH = MODEL.roverBattery.value * 1000;
export const STOP_S = MODEL.stopTime.value * 60;
/** Hours of work one suit fill supports at the Apollo average rate. */
export const SUIT_WORK_S = SUIT_ENERGY_J / WORK_RATE_W;
export const SHELTER_WALK_S = MODEL.shelterWalk.value * 60;
export const SHELTER_PACE = MODEL.shelterPace.value / 3.6;

export interface Supplies {
  energy: number;
  oxygen: number;
  water: number;
}

/** Share of each suit supply left after `usedJ` joules of effort since the last refill. Below zero: it ran out. */
export function suitSupplies(usedJ: number): Supplies {
  const kJ = usedJ / 1000;
  return {
    energy: 1 - usedJ / SUIT_ENERGY_J,
    oxygen: 1 - (kJ * MODEL.oxygen.value) / MODEL.oxygenTank.value,
    water: 1 - (kJ * MODEL.coolingWater.value) / MODEL.waterTank.value,
  };
}

export type Mover = 'rover' | 'astronaut';

/** Slope limits for a traveller: no-go at `limit`, slow going from `care`, and steep (close to the limit) from halfway between. */
export function slopeLimits(mover: Mover): { limit: number; care: number; steep: number } {
  const limit = mover === 'rover' ? MODEL.roverSlopeLimit.value : MODEL.walkSlopeLimit.value;
  const care = mover === 'rover' ? MODEL.roverSlopeCare.value : MODEL.walkSlopeCare.value;
  return { limit, care, steep: (limit + care) / 2 };
}

/** Suited walking speed in m/s on a slope of `gradeDeg` along the direction of travel, uphill positive (Marquez 2008). */
export function marquezSpeed(gradeDeg: number): number {
  const s = gradeDeg;
  if (s <= -20) return 0.05;
  if (s <= -10) return 0.095 * s + 1.95;
  if (s <= 0) return 0.06 * s + 1.6;
  if (s <= 6) return -0.2 * s + 1.6;
  if (s <= 15) return -0.039 * s + 0.634;
  return 0.05;
}

/** Planned pace: the Marquez curve, capped at an unhurried walk. The rover holds its planning speed. */
export function pace(mover: Mover, gradeDeg: number): number {
  return mover === 'rover' ? MODEL.roverSpeed.value : Math.min(marquezSpeed(gradeDeg), MODEL.walkPlanSpeed.value);
}

/** Metabolic energy in joules to walk `distance` horizontal metres at `speed` m/s (Santee 2001). */
export function walkEnergyJ(distance: number, gradeDeg: number, speed: number, mass = MODEL.suitedMass.value, g = MARS_G): number {
  const a = (gradeDeg * Math.PI) / 180;
  const level = (3.28 * mass + 71.1) * (0.661 * Math.cos(a) + 0.115 / speed) * distance;
  const lift = mass * g * distance * Math.sin(a);
  return level + (a >= 0 ? 3.5 * lift : 2.4 * lift * 0.3 ** (Math.abs(gradeDeg) / 7.65));
}

/** Battery energy in joules to drive `distance` metres at `speed` m/s (Carr 2001). */
export function roverEnergyJ(distance: number, gradeDeg: number, speed = MODEL.roverSpeed.value, mass = MODEL.roverMass.value, g = MARS_G): number {
  const scale = g / MOON_G;
  const slope = gradeDeg > 0 ? MODEL.roverUphill.value * gradeDeg : MODEL.roverDownhill.value * -gradeDeg;
  return (MODEL.roverLevel.value + slope) * mass * scale * distance + (MODEL.roverElectronics.value * distance) / speed;
}

/** Energy a traveller spends covering one stretch, in joules: metabolic on foot, battery in the rover. */
export function travelEnergyJ(mover: Mover, distance: number, gradeDeg: number, speed: number): number {
  return mover === 'rover' ? roverEnergyJ(distance, gradeDeg, speed) : walkEnergyJ(distance, gradeDeg, speed);
}

export function gradeDeg(rise: number, run: number): number {
  return (Math.atan2(rise, run) * 180) / Math.PI;
}
