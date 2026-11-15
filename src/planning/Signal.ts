import { GRID, type Analysis } from './Analysis';
import { MODEL } from './Models';

/**
 * Where the lander's antenna can be seen from, over the HiRISE elevation model.
 * A cell is covered when a straight line from the antenna to a radio held at suit height clears
 * all the ground in between, with the planet's curve included. Radio waves bend a little over a
 * ridge in reality; that is ignored here, so the map is on the cautious side.
 * @returns one byte per planning cell: 1 in sight of the antenna, 0 hidden by terrain.
 */
export function coverage(analysis: Analysis, base: { x: number; z: number }): Uint8Array {
  const covered = new Uint8Array(GRID * GRID);
  const height = analysis.height;
  const cell = analysis.cell;
  const from = analysis.index(base.x, base.z);
  const i0 = from % GRID;
  const j0 = Math.floor(from / GRID);
  const mast = height[from] + MODEL.radioMast.value;
  // Ground a distance d away sits d² / 2R below the antenna's level plane.
  const curve = (cell * cell) / (2 * MODEL.marsRadius.value * 1000);
  for (let j = 0; j < GRID; j += 1) {
    for (let i = 0; i < GRID; i += 1) {
      const di = i - i0;
      const dj = j - j0;
      const steps = Math.max(Math.abs(di), Math.abs(dj));
      const span2 = di * di + dj * dj;
      const target = height[j * GRID + i] + MODEL.radioSuit.value - curve * span2;
      let clear = true;
      for (let s = 1; s < steps; s += 1) {
        const t = s / steps;
        const ground = height[Math.round(j0 + dj * t) * GRID + Math.round(i0 + di * t)] - curve * span2 * t * t;
        if (ground > mast + (target - mast) * t) {
          clear = false;
          break;
        }
      }
      covered[j * GRID + i] = clear ? 1 : 0;
    }
  }
  return covered;
}
