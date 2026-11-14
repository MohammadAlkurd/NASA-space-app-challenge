import * as THREE from 'three';

export interface GridMeta {
  sizeM: number;
  px: number;
  cellM: number;
  minElev: number;
  maxElev: number;
}

export interface SiteMeta {
  id: string;
  name: string;
  crs: string;
  marsRadius: number;
  centerLat: number;
  centerLon: number;
  cosLat: number;
  local: GridMeta;
  regional: GridMeta;
  credits: string[];
}

const DEG = Math.PI / 180;

/** Square grid of elevations. Sample i sits at x = -size/2 + (i + 0.5) * cell; +x east, +z south. */
export class Heightfield {
  readonly cell: number;
  readonly half: number;

  constructor(
    readonly data: Float32Array,
    readonly n: number,
    readonly size: number,
    readonly valid?: Uint8Array,
  ) {
    this.cell = size / n;
    this.half = size / 2;
  }

  sample(i: number, j: number): number {
    return this.data[j * this.n + i];
  }

  coord(i: number): number {
    return -this.half + (i + 0.5) * this.cell;
  }

  contains(x: number, z: number, margin = 0): boolean {
    const limit = this.half - margin;
    return Math.abs(x) <= limit && Math.abs(z) <= limit;
  }

  heightAt(x: number, z: number): number {
    const max = this.n - 1;
    const fx = Math.min(Math.max((x + this.half) / this.cell - 0.5, 0), max);
    const fz = Math.min(Math.max((z + this.half) / this.cell - 0.5, 0), max);
    const i0 = Math.min(Math.floor(fx), max - 1);
    const j0 = Math.min(Math.floor(fz), max - 1);
    const tx = fx - i0;
    const tz = fz - j0;
    const row = j0 * this.n + i0;
    const d = this.data;
    const top = d[row] + (d[row + 1] - d[row]) * tx;
    const bottom = d[row + this.n] + (d[row + this.n + 1] - d[row + this.n]) * tx;
    return top + (bottom - top) * tz;
  }

  /** Upward surface normal from central differences over `span` metres. */
  normalAt(x: number, z: number, target: THREE.Vector3, span = this.cell): THREE.Vector3 {
    const dx = (this.heightAt(x + span, z) - this.heightAt(x - span, z)) / (2 * span);
    const dz = (this.heightAt(x, z + span) - this.heightAt(x, z - span)) / (2 * span);
    return target.set(-dx, 1, -dz).normalize();
  }

  slopeDegAt(x: number, z: number, span = this.cell): number {
    const dx = (this.heightAt(x + span, z) - this.heightAt(x - span, z)) / (2 * span);
    const dz = (this.heightAt(x, z + span) - this.heightAt(x, z - span)) / (2 * span);
    return Math.atan(Math.hypot(dx, dz)) / DEG;
  }
}

export class SiteData {
  constructor(
    readonly meta: SiteMeta,
    readonly local: Heightfield,
    readonly regional: Heightfield,
    readonly baseUrl: string,
  ) {}

  /** World y is elevation above the lowest point of the local grid. */
  get elevationOffset(): number {
    return this.meta.local.minElev;
  }

  /** Ground height in world units anywhere in the modelled area. */
  groundAt(x: number, z: number): number {
    return this.local.contains(x, z) ? this.local.heightAt(x, z) : this.regional.heightAt(x, z);
  }

  toLatLon(x: number, z: number): { lat: number; lon: number } {
    const { marsRadius, centerLat, centerLon, cosLat } = this.meta;
    return {
      lat: centerLat - z / marsRadius / DEG,
      lon: centerLon + x / (marsRadius * cosLat) / DEG,
    };
  }

  fromLatLon(lat: number, lon: number): { x: number; z: number } {
    const { marsRadius, centerLat, centerLon, cosLat } = this.meta;
    return {
      x: (lon - centerLon) * DEG * marsRadius * cosLat,
      z: -(lat - centerLat) * DEG * marsRadius,
    };
  }

  elevationAt(x: number, z: number): number {
    return this.groundAt(x, z) + this.elevationOffset;
  }
}

async function loadPixels(url: string): Promise<ImageData> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('2D canvas is unavailable.');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/** Decode a height PNG: R = high byte, G = low byte, B = validity. */
async function loadHeightfield(url: string, grid: GridMeta, offset: number): Promise<Heightfield> {
  const image = await loadPixels(url);
  const count = image.width * image.height;
  const data = new Float32Array(count);
  const valid = new Uint8Array(count);
  const range = grid.maxElev - grid.minElev;
  const base = grid.minElev - offset;
  const pixels = image.data;
  for (let i = 0; i < count; i += 1) {
    const value = pixels[i * 4] * 256 + pixels[i * 4 + 1];
    data[i] = base + (value / 65535) * range;
    valid[i] = pixels[i * 4 + 2] > 127 ? 1 : 0;
  }
  return new Heightfield(data, image.width, grid.sizeM, valid);
}

export async function loadSite(id: string): Promise<SiteData> {
  const baseUrl = `${import.meta.env.BASE_URL}data/${id}/`;
  const response = await fetch(`${baseUrl}site.json`);
  if (!response.ok) throw new Error(`Failed to load site ${id}: ${response.status}`);
  const meta = (await response.json()) as SiteMeta;
  const offset = meta.local.minElev;
  const [local, regional] = await Promise.all([
    loadHeightfield(`${baseUrl}height.png`, meta.local, offset),
    loadHeightfield(`${baseUrl}regional.png`, meta.regional, offset),
  ]);
  return new SiteData(meta, local, regional, baseUrl);
}
