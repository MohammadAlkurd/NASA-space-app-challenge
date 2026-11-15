import { MODEL } from '../planning/Models';

/** 'real' uses the measured rates as they are; 'fast' multiplies the storm rates so a demo sees one. */
export type Odds = 'off' | 'real' | 'fast';
export const FAST_ODDS = 100;
const SOLS_PER_MARS_YEAR = 668.6;
/** Planet-wide storms start in southern spring and summer, so one can begin on about half the sols of a year. */
const DUST_SEASON_SHARE = 0.5;

export type Storm = 'dust' | 'solar';
export interface Happening {
  started?: Storm;
  ended?: Storm;
  /** A dust devil passes close by. */
  devil?: boolean;
}

/** Whirlwinds build up to the measured midday peak and die away; the 09:00-17:00 window is our own shape. */
export function devilShape(hour: number): number {
  const step = (x: number, a: number, b: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  return step(hour, 9, 12) * (1 - step(hour, 14, 17));
}

/** Chance per sol that each kind of storm starts, at the given odds. */
export function stormOdds(odds: Odds, dustSeason: boolean): { solar: number; dust: number } {
  const scale = odds === 'off' ? 0 : odds === 'fast' ? FAST_ODDS : 1;
  return {
    solar: scale / MODEL.solarEventEvery.value,
    dust: dustSeason ? scale / (MODEL.dustStormEvery.value * SOLS_PER_MARS_YEAR * DUST_SEASON_SHARE) : 0,
  };
}

/**
 * Weather that arrives on its own as the Mars clock runs: each kind is a random arrival at its measured rate.
 * One storm runs at a time, and it ends after the measured duration.
 */
export class NaturalEvents {
  odds: Odds = 'real';
  active: Storm | null = null;
  /** Mars hours the clock has run, and when the running storm ends on that count. */
  private clockH = 0;
  private endsAtH = 0;

  constructor(private readonly dustSeason: boolean, private readonly random: () => number = Math.random) {}

  /** Drop the running storm, e.g. when the crew picks a drill or the clear sol by hand. */
  clear(): void {
    this.active = null;
  }

  /**
   * @param stepH Mars hours since the last call.
   * @param hour time of sol, 0-24.
   */
  step(stepH: number, hour: number): Happening {
    const out: Happening = {};
    this.clockH += stepH;
    const clockH = this.clockH;
    if (this.odds === 'off') return out;
    const arrives = (perHour: number) => this.random() < 1 - Math.exp(-perHour * stepH);
    if (this.active) {
      if (clockH >= this.endsAtH) {
        out.ended = this.active;
        this.active = null;
      }
    } else {
      const perSol = stormOdds(this.odds, this.dustSeason);
      if (arrives(perSol.solar / 24)) {
        out.started = this.active = 'solar';
        this.endsAtH = clockH + MODEL.solarEventLasts.value;
      } else if (arrives(perSol.dust / 24)) {
        out.started = this.active = 'dust';
        this.endsAtH = clockH + MODEL.dustStormLasts.value * 24;
      }
    }
    // A storm hides whirlwinds, and none form in one.
    if (this.active !== 'dust' && arrives(MODEL.dustDevilPeak.value * (MODEL.dustDevilDusty.value / 100) * devilShape(hour))) out.devil = true;
    return out;
  }
}
