import { expect, test } from '@playwright/test';
import {
  MARS_G, MODEL, SUIT_ENERGY_J, marquezSpeed, pace, roverEnergyJ, suitSupplies, walkEnergyJ,
} from '../src/planning/Models';

// Checks of the planning formulas against the published numbers they come from. No browser needed.
test.describe('planning models', () => {
  test('walking speed follows the Marquez 2008 curve and is slower uphill than downhill', () => {
    expect(marquezSpeed(0)).toBeCloseTo(1.6, 5);
    expect(marquezSpeed(6)).toBeCloseTo(0.4, 5);
    expect(marquezSpeed(-10)).toBeCloseTo(1.0, 5);
    expect(marquezSpeed(15)).toBeCloseTo(0.049, 3);
    expect(marquezSpeed(25)).toBe(0.05);
    expect(marquezSpeed(-25)).toBe(0.05);
    expect(marquezSpeed(5)).toBeLessThan(marquezSpeed(-5));
    // The curve has no jumps where its pieces meet.
    for (const edge of [-20, -10, 0, 6, 15]) expect(Math.abs(marquezSpeed(edge + 1e-6) - marquezSpeed(edge))).toBeLessThan(0.01);
    expect(pace('astronaut', 0)).toBe(MODEL.walkPlanSpeed.value);
    expect(pace('rover', 12)).toBe(MODEL.roverSpeed.value);
  });

  test('walking effort on flat ground is about 470 W (404 kcal/h) at the planned pace', () => {
    const watts = walkEnergyJ(1, 0, 0.9) * 0.9;
    expect(watts).toBeGreaterThan(460);
    expect(watts).toBeLessThan(480);
    // One Apollo backpack then lasts between 4 and 5 hours of steady walking.
    const hours = SUIT_ENERGY_J / watts / 3600;
    expect(hours).toBeGreaterThan(4);
    expect(hours).toBeLessThan(5);
  });

  test('uphill costs more than level, and gentle downhill costs less', () => {
    const level = walkEnergyJ(100, 0, 0.9);
    expect(walkEnergyJ(100, 8, 0.9)).toBeGreaterThan(level);
    expect(walkEnergyJ(100, -8, 0.9)).toBeLessThan(level);
    expect(walkEnergyJ(100, -8, 0.9)).toBeGreaterThan(0);
  });

  test('effort model lands on the cautious side of NASA\'s 10 km walk-back test (944 kcal)', () => {
    // Test conditions: 10 km at 3.9 mph in simulated Moon gravity, 121 kg suit; 80 kg subject is our assumption.
    const kcal = walkEnergyJ(10_000, 0, 3.9 * 0.44704, 80 + 121, 1.62) / 4184;
    const ratio = kcal / 944.2;
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThan(1.4);
  });

  test('rover energy follows Carr 2001 and gives a plausible range', () => {
    const perMetre = roverEnergyJ(1, 0);
    const expected = 0.216 * MODEL.roverMass.value * (MARS_G / 1.62) + MODEL.roverElectronics.value / MODEL.roverSpeed.value;
    expect(perMetre).toBeCloseTo(expected, 6);
    const rangeKm = (MODEL.roverBattery.value * 3.6e6) / perMetre / 1000;
    expect(rangeKm).toBeGreaterThan(30);
    expect(rangeKm).toBeLessThan(50);
    expect(roverEnergyJ(100, 10)).toBeGreaterThan(roverEnergyJ(100, -10));
    expect(roverEnergyJ(100, -10)).toBeGreaterThan(roverEnergyJ(100, 0));
  });

  test('suit budget and oxygen rule match Apollo and the NASA walk-back test', () => {
    // Apollo 15-17 backpack: 225 kcal/h lasts 8 h.
    expect(SUIT_ENERGY_J / (225 * 4184) ).toBeCloseTo(8, 1);
    // Walk-back test: 2374 BTU/h (2505 kJ/h) used 0.40 lb/h of oxygen.
    const lbPerHour = (2505 * MODEL.oxygen.value) / 453.6;
    expect(Math.abs(lbPerHour - 0.4) / 0.4).toBeLessThan(0.05);
  });

  test('oxygen and cooling water drain with effort and outlast the suit energy budget', () => {
    expect(suitSupplies(0)).toEqual({ energy: 1, oxygen: 1, water: 1 });
    const spent = suitSupplies(SUIT_ENERGY_J);
    expect(spent.energy).toBeCloseTo(0, 6);
    // Apollo 15-17 planned 8 h on one fill, so neither tank may run dry before the energy budget does.
    expect(spent.oxygen).toBeGreaterThan(0);
    expect(spent.oxygen).toBeLessThan(0.3);
    expect(spent.water).toBeGreaterThan(0);
    expect(spent.water).toBeLessThan(0.3);
    // Oxygen charge scaled by pressure from the measured 472 g at 1020 psia.
    expect(MODEL.oxygenTank.value).toBeCloseTo((472 * 1410) / 1020, 0);
    // 11.5 lb of cooling water.
    expect(MODEL.waterTank.value / 453.6).toBeCloseTo(11.5, 1);
  });

  test('a dust-slowed trip costs more energy over the same ground', () => {
    const dust = 0.7;
    expect(walkEnergyJ(1000, 0, 0.9 * dust)).toBeGreaterThan(walkEnergyJ(1000, 0, 0.9));
    expect(roverEnergyJ(1000, 0, MODEL.roverSpeed.value * dust)).toBeGreaterThan(roverEnergyJ(1000, 0));
  });
});
