import * as THREE from 'three';

export interface EnvironmentTable {
  source: string;
  sol: number;
  /** Latitude the sun stands over on that sol, degrees. */
  subsolarLatDeg?: number;
  /** Solar longitude on that sol, degrees: 0 is northern spring equinox, 180-360 is dust-storm season. */
  lsDeg?: number;
  /** Measured dust optical depth at 880 nm on (or nearest to) that sol. */
  tau?: number;
  tauSol?: number;
  tauSource?: string;
  /** Dust optical depth the dust-storm drill replays. */
  stormTau?: number;
  stormTauSource?: string;
  /** Direction the wind blows from, degrees clockwise from north, by local hour. Absent when the station's data is not trustworthy. */
  windDirDeg?: number[];
  airTempC: number[];
  groundTempC: number[];
  pressurePa: number[];
  windMs: number[];
  humidityPct: number[];
}

export interface Weather {
  airTempC: number;
  groundTempC: number;
  pressurePa: number;
  windMs: number;
  /** Direction the wind blows from, degrees clockwise from north; null when it was not measured. */
  windFromDeg: number | null;
  humidityPct: number;
  /** Dust optical depth on the measured sol, and in the dust-storm drill. */
  tau: number;
  stormTau: number;
  /** Modelled, not measured. */
  uvIndex: number;
  sunElevationDeg: number;
  sunAzimuthDeg: number;
}

export interface SpaceWeather {
  status: 'loading' | 'quiet' | 'elevated' | 'storm' | 'offline';
  headline: string;
  detail: string;
}

const DEG = Math.PI / 180;
/** Seconds in a Mars solar day. */
export const SOL_SECONDS = 88775;
/** One hour of the 24-hour Mars clock, in seconds. */
export const HOUR_SECONDS = SOL_SECONDS / 24;

function lerpHour(values: number[], hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const i = Math.floor(h);
  return values[i] + (values[(i + 1) % 24] - values[i]) * (h - i);
}

/** Interpolates a compass bearing the short way round. */
function lerpBearing(values: number[], hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const i = Math.floor(h);
  const turn = ((values[(i + 1) % 24] - values[i] + 540) % 360) - 180;
  return (values[i] + turn * (h - i) + 360) % 360;
}

export type Season = { lsDeg: number; name: string; dustSeason: boolean; cloudSeason: number };

/** Weather-station table (MEDA or REMS) by local hour, sun position, and NASA DONKI space-weather alerts. */
export class Environment {
  spaceWeather: SpaceWeather = { status: 'loading', headline: 'Checking NASA DONKI...', detail: '' };

  constructor(readonly table: EnvironmentTable, private readonly latitudeDeg: number) {}

  static async load(baseUrl: string, latitudeDeg: number): Promise<Environment> {
    const response = await fetch(`${baseUrl}environment.json`);
    if (!response.ok) throw new Error(`Failed to load weather table: ${response.status}`);
    return new Environment((await response.json()) as EnvironmentTable, latitudeDeg);
  }

  /** Dust optical depth measured on the weather sol. */
  get tau(): number {
    return this.table.tau ?? 0.5;
  }

  /** Where the dust-storm drill's optical depth was measured. */
  get stormTauSource(): string {
    return this.table.stormTauSource ?? 'Curiosity Mastcam, 2018 global dust storm (Guzewich et al. 2019)';
  }

  /** The Martian season on the weather sol, from its solar longitude. */
  get season(): Season {
    const lsDeg = this.table.lsDeg ?? 90;
    const north = ['spring', 'summer', 'autumn', 'winter'][Math.floor(lsDeg / 90) % 4];
    const south = ['autumn', 'winter', 'spring', 'summer'][Math.floor(lsDeg / 90) % 4];
    return {
      lsDeg,
      name: this.latitudeDeg >= 0 ? `northern ${north}` : `southern ${south}`,
      // Regional and global dust storms start in the southern spring and summer (Ls 180-360).
      dustSeason: lsDeg >= 180,
      // Thin water-ice clouds band the tropics around aphelion (Ls about 40-140).
      cloudSeason: THREE.MathUtils.smoothstep(lsDeg, 40, 60) * (1 - THREE.MathUtils.smoothstep(lsDeg, 120, 140)),
    };
  }

  /** Conditions at a local mean solar hour (0..24). */
  at(hour: number): Weather {
    // Sub-solar latitude on the measured sol. Jezero's MEDA sol is northern summer, Gale's REMS sol southern summer.
    const declination = (this.table.subsolarLatDeg ?? 25.0) * DEG;
    const lat = this.latitudeDeg * DEG;
    const hourAngle = (hour - 12) * 15 * DEG;
    const sinElevation = Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
    const elevation = Math.asin(THREE.MathUtils.clamp(sinElevation, -1, 1));
    const azimuth = Math.atan2(
      -Math.sin(hourAngle) * Math.cos(declination),
      Math.sin(declination) * Math.cos(lat) - Math.cos(declination) * Math.sin(lat) * Math.cos(hourAngle),
    );
    return {
      airTempC: lerpHour(this.table.airTempC, hour),
      groundTempC: lerpHour(this.table.groundTempC, hour),
      pressurePa: lerpHour(this.table.pressurePa, hour),
      windMs: lerpHour(this.table.windMs, hour),
      windFromDeg: this.table.windDirDeg ? lerpBearing(this.table.windDirDeg, hour) : null,
      tau: this.tau,
      stormTau: this.table.stormTau ?? 8.5,
      humidityPct: lerpHour(this.table.humidityPct, hour),
      // Clear-sky estimate: Mars has almost no ozone, so UV scales with the sun's height; ~11 with the sun overhead.
      uvIndex: Math.max(0, 11 * Math.pow(Math.max(0, sinElevation), 1.2)),
      sunElevationDeg: elevation / DEG,
      sunAzimuthDeg: ((azimuth / DEG) + 360) % 360,
    };
  }

  /**
   * Solar storms from NASA's DONKI database, last 7 days. Uses the snapshot taken when the site was
   * built (refreshed daily by GitHub Actions); asks the API directly only when that is over a day old.
   */
  async refreshSpaceWeather(baseUrl: string): Promise<void> {
    let snapshot: DonkiSnapshot | null = null;
    try {
      const response = await fetch(`${baseUrl}space-weather.json`);
      if (response.ok) snapshot = (await response.json()) as DonkiSnapshot;
    } catch {
      // No snapshot: fall through to the live request.
    }
    if (snapshot) this.spaceWeather = summarize(snapshot);
    const age = snapshot ? Date.now() - Date.parse(snapshot.fetchedAt) : Infinity;
    if (age < 36 * 3600 * 1000) return;

    const cacheKey = 'mars-donki-v2';
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) ?? 'null') as DonkiSnapshot | null;
      if (cached && Date.now() - Date.parse(cached.fetchedAt) < 3 * 3600 * 1000) {
        this.spaceWeather = summarize(cached);
        return;
      }
    } catch {
      // Ignore unreadable cache.
    }
    const day = (offset: number) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
    const query = `startDate=${day(7)}&endDate=${day(0)}&api_key=DEMO_KEY`;
    try {
      const [sep, cme] = await Promise.all(
        ['SEP', 'CME'].map(async (kind) => {
          const response = await fetch(`https://api.nasa.gov/DONKI/${kind}?${query}`);
          if (!response.ok) throw new Error(String(response.status));
          const text = await response.text();
          return (text ? JSON.parse(text) : []) as Record<string, unknown>[];
        }),
      );
      const live: DonkiSnapshot = {
        fetchedAt: new Date().toISOString(),
        sepEvents: sep.map((event) => ({ time: String(event.eventTime ?? '') })),
        cmeCount: cme.length,
        fastCmes: cme
          .map((event) => ({
            time: String(event.startTime ?? ''),
            speed: Math.max(0, ...((event.cmeAnalyses as { speed?: number }[] | null) ?? []).map((a) => a.speed ?? 0)),
          }))
          .filter((event) => event.speed >= 1000),
      };
      this.spaceWeather = summarize(live);
      localStorage.setItem(cacheKey, JSON.stringify(live));
    } catch {
      if (!snapshot) {
        this.spaceWeather = { status: 'offline', headline: 'Feed unavailable', detail: 'NASA DONKI could not be reached. Dose shown is the quiet-Sun cosmic-ray background only.' };
      }
    }
  }
}

interface DonkiSnapshot {
  fetchedAt: string;
  sepEvents: { time: string }[];
  cmeCount: number;
  fastCmes: { time: string; speed: number }[];
}

function summarize(data: DonkiSnapshot): SpaceWeather {
  const asOf = `NASA DONKI, last 7 days, as of ${data.fetchedAt.slice(0, 10)}.`;
  if (data.sepEvents.length) {
    return { status: 'storm', headline: 'Solar particle event', detail: `${data.sepEvents.length} solar energetic particle event(s). Stay near shelter and keep trips short. ${asOf}` };
  }
  if (data.fastCmes.length) {
    return { status: 'elevated', headline: 'Fast solar eruption', detail: `${data.fastCmes.length} coronal mass ejection(s) faster than 1000 km/s. Watch for particle alerts. ${asOf}` };
  }
  return { status: 'quiet', headline: 'Quiet Sun', detail: `No solar particle events and no fast eruptions (${data.cmeCount} ordinary CMEs). ${asOf}` };
}
