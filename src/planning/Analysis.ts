import * as THREE from 'three';
import type { TravelProfile } from '../entities/Explorer';
import type { SiteData } from '../world/SiteData';

export type LayerId = 'optical' | 'hazard' | 'elevation' | 'radiation' | 'thermal';

/** Planning grid resolution: 512 x 512 cells of 10 m over the 5.12 km map. */
export const GRID = 512;

/** Mean surface dose-equivalent rate measured by Curiosity's RAD in Gale crater (Hassler et al. 2014): 0.67 mSv/day. */
export const BASE_DOSE_USV_H = (0.67 * 1000) / 24.66;

/**
 * Dose scales with how much sky is visible. Calibrated on RAD's Murray Buttes result
 * (Ehresmann et al. 2021): ~19 % of sky blocked by a butte gave a ~5 % lower dose.
 */
export function doseRate(skyView: number): number {
  return BASE_DOSE_USV_H * (0.75 + 0.25 * skyView);
}

/** Terrain products derived from the HiRISE elevation model, used by the map layers and the route planner. */
export class Analysis {
  readonly cell: number;
  /** Mean slope per cell, degrees. */
  readonly slope = new Float32Array(GRID * GRID);
  /** Steepest 2.5 m slope found inside each cell, degrees: catches ledges the mean hides. */
  readonly slopeMax = new Float32Array(GRID * GRID);
  /** Height variation left after removing the local tilt, metres: rocks, ripples, rubble. */
  readonly roughness = new Float32Array(GRID * GRID);
  /** Fraction of the sky hemisphere visible, 0..1. */
  readonly skyView = new Float32Array(GRID * GRID);
  readonly height = new Float32Array(GRID * GRID);
  private thermal: Uint8Array | null = null;
  private thermalSize = 0;
  private readonly textures = new Map<string, THREE.DataTexture>();

  constructor(readonly site: SiteData) {
    this.cell = site.local.size / GRID;
    this.compute();
  }

  index(x: number, z: number): number {
    const half = this.site.local.half;
    const i = Math.min(GRID - 1, Math.max(0, Math.floor((x + half) / this.cell)));
    const j = Math.min(GRID - 1, Math.max(0, Math.floor((z + half) / this.cell)));
    return j * GRID + i;
  }

  cellCenter(index: number, target: { x: number; z: number }): { x: number; z: number } {
    const half = this.site.local.half;
    target.x = -half + ((index % GRID) + 0.5) * this.cell;
    target.z = -half + (Math.floor(index / GRID) + 0.5) * this.cell;
    return target;
  }

  /** Slope used for go/no-go decisions: mean slope pulled toward the worst ledge in the cell. */
  effectiveSlope(index: number): number {
    return this.slope[index] * 0.6 + this.slopeMax[index] * 0.4;
  }

  setThermal(pixels: Uint8Array, size: number): void {
    this.thermal = pixels;
    this.thermalSize = size;
  }

  /** RGBA overlay for a map layer; cached per layer (and per traveller for the hazard layer). */
  overlay(layer: LayerId, profile: TravelProfile): THREE.DataTexture | null {
    if (layer === 'optical') return null;
    const key = layer === 'hazard' ? `hazard-${profile.mode}` : layer;
    let texture = this.textures.get(key);
    if (!texture) {
      const data = new Uint8Array(GRID * GRID * 4);
      if (layer === 'hazard') this.paintHazard(data, profile);
      else if (layer === 'elevation') this.paintElevation(data);
      else if (layer === 'radiation') this.paintRadiation(data);
      else this.paintThermal(data);
      texture = new THREE.DataTexture(data, GRID, GRID, THREE.RGBAFormat);
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      this.textures.set(key, texture);
    }
    return texture;
  }

  dispose(): void {
    for (const texture of this.textures.values()) texture.dispose();
  }

  private compute(): void {
    const field = this.site.local;
    const block = field.n / GRID;
    const h = field.data;
    const n = field.n;
    const inv = 1 / (2 * field.cell);
    const deg = 180 / Math.PI;
    for (let j = 0; j < GRID; j += 1) {
      for (let i = 0; i < GRID; i += 1) {
        let sum = 0;
        let sumSlope = 0;
        let maxSlope = 0;
        let sx = 0;
        let sz = 0;
        for (let v = 0; v < block; v += 1) {
          const y = Math.min(n - 2, Math.max(1, j * block + v));
          for (let u = 0; u < block; u += 1) {
            const x = Math.min(n - 2, Math.max(1, i * block + u));
            const o = y * n + x;
            const dx = (h[o + 1] - h[o - 1]) * inv;
            const dz = (h[o + n] - h[o - n]) * inv;
            const slope = Math.atan(Math.hypot(dx, dz)) * deg;
            sum += h[o];
            sumSlope += slope;
            sx += dx;
            sz += dz;
            if (slope > maxSlope) maxSlope = slope;
          }
        }
        const count = block * block;
        const mean = sum / count;
        const gx = sx / count;
        const gz = sz / count;
        // Residual after removing the mean plane.
        let residual = 0;
        for (let v = 0; v < block; v += 1) {
          const y = Math.min(n - 2, Math.max(1, j * block + v));
          for (let u = 0; u < block; u += 1) {
            const x = Math.min(n - 2, Math.max(1, i * block + u));
            const plane = mean + (u - (block - 1) / 2) * field.cell * gx + (v - (block - 1) / 2) * field.cell * gz;
            const d = h[y * n + x] - plane;
            residual += d * d;
          }
        }
        const o = j * GRID + i;
        this.height[o] = mean;
        this.slope[o] = sumSlope / count;
        this.slopeMax[o] = maxSlope;
        this.roughness[o] = Math.sqrt(residual / count);
      }
    }
    this.computeSkyView();
  }

  /** Horizon scan in 12 directions out to 600 m. */
  private computeSkyView(): void {
    const directions = 12;
    const steps = [1, 2, 3, 4, 6, 8, 11, 15, 20, 27, 36, 48, 60];
    const height = this.height;
    for (let j = 0; j < GRID; j += 1) {
      for (let i = 0; i < GRID; i += 1) {
        const base = height[j * GRID + i] + 1.5;
        let open = 0;
        for (let d = 0; d < directions; d += 1) {
          const angle = (d / directions) * Math.PI * 2;
          const dx = Math.cos(angle);
          const dz = Math.sin(angle);
          let tangent = 0;
          for (const step of steps) {
            const x = Math.round(i + dx * step);
            const z = Math.round(j + dz * step);
            if (x < 0 || z < 0 || x >= GRID || z >= GRID) break;
            const t = (height[z * GRID + x] - base) / (step * this.cell);
            if (t > tangent) tangent = t;
          }
          // Visible fraction of this sky wedge: cos^2 of the horizon elevation angle.
          open += 1 / (1 + tangent * tangent);
        }
        this.skyView[j * GRID + i] = open / directions;
      }
    }
  }

  private paintHazard(data: Uint8Array, profile: TravelProfile): void {
    for (let o = 0; o < GRID * GRID; o += 1) {
      const slope = this.effectiveSlope(o);
      const rough = this.roughness[o];
      let r = 60;
      let g = 200;
      let b = 110;
      let a = 55;
      if (slope >= profile.maxSlope) {
        [r, g, b, a] = [225, 40, 40, 215];
      } else if (slope >= (profile.cautionSlope + profile.maxSlope) / 2) {
        [r, g, b, a] = [245, 120, 30, 190];
      } else if (slope >= profile.cautionSlope || rough > 0.35) {
        [r, g, b, a] = [250, 205, 50, 160];
      }
      data.set([r, g, b, a], o * 4);
    }
  }

  private paintElevation(data: Uint8Array): void {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of this.height) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const stops = [
      [38, 70, 140], [60, 150, 150], [130, 190, 110], [230, 215, 120], [215, 140, 70], [170, 70, 50], [245, 240, 235],
    ];
    const interval = 10;
    for (let o = 0; o < GRID * GRID; o += 1) {
      const t = ((this.height[o] - lo) / (hi - lo)) * (stops.length - 1);
      const k = Math.min(stops.length - 2, Math.floor(t));
      const f = t - k;
      let r = stops[k][0] + (stops[k + 1][0] - stops[k][0]) * f;
      let g = stops[k][1] + (stops[k + 1][1] - stops[k][1]) * f;
      let b = stops[k][2] + (stops[k + 1][2] - stops[k][2]) * f;
      // Contour line where a neighbour falls in a different 10 m band.
      const band = Math.floor(this.height[o] / interval);
      const right = this.height[Math.min(o + 1, GRID * GRID - 1)];
      const down = this.height[Math.min(o + GRID, GRID * GRID - 1)];
      if (Math.floor(right / interval) !== band || Math.floor(down / interval) !== band) {
        r *= 0.45;
        g *= 0.45;
        b *= 0.45;
      }
      data.set([r, g, b, 185], o * 4);
    }
  }

  private paintRadiation(data: Uint8Array): void {
    // Most open ground (sky view ~1) is magenta; sheltered ground near cliffs turns blue-green.
    for (let o = 0; o < GRID * GRID; o += 1) {
      const shelter = Math.min(1, Math.max(0, (1 - this.skyView[o]) / 0.2));
      const r = 235 - 200 * shelter;
      const g = 60 + 150 * shelter;
      const b = 150 + 60 * shelter;
      data.set([r, g, b, 120 + 80 * shelter], o * 4);
    }
  }

  private paintThermal(data: Uint8Array): void {
    const size = this.thermalSize;
    for (let j = 0; j < GRID; j += 1) {
      for (let i = 0; i < GRID; i += 1) {
        let t = 0.5;
        if (this.thermal && size > 1) {
          // Bilinear sample of the 100 m THEMIS crop.
          const fx = Math.min(size - 1.001, Math.max(0, ((i + 0.5) / GRID) * size - 0.5));
          const fy = Math.min(size - 1.001, Math.max(0, ((j + 0.5) / GRID) * size - 0.5));
          const x0 = Math.floor(fx);
          const y0 = Math.floor(fy);
          const tx = fx - x0;
          const ty = fy - y0;
          const p = this.thermal;
          const top = p[y0 * size + x0] * (1 - tx) + p[y0 * size + x0 + 1] * tx;
          const bottom = p[(y0 + 1) * size + x0] * (1 - tx) + p[(y0 + 1) * size + x0 + 1] * tx;
          t = (top * (1 - ty) + bottom * ty) / 255;
        }
        // Cold (dark violet) to warm (yellow).
        const r = 255 * Math.min(1, Math.max(0, 1.6 * t - 0.1));
        const g = 255 * Math.min(1, Math.max(0, 1.7 * t - 0.6));
        const b = 255 * Math.min(1, Math.max(0, 0.55 - Math.abs(t - 0.3) * 1.6 + Math.max(0, t - 0.85) * 3));
        data.set([r, g, b, 175], (j * GRID + i) * 4);
      }
    }
  }
}
