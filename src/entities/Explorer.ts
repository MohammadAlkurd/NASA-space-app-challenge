import * as THREE from 'three';
import type { SiteData } from '../world/SiteData';

export type TravelMode = 'rover' | 'astronaut';

export interface TravelProfile {
  mode: TravelMode;
  label: string;
  /** Cruise speed on flat ground, m/s. */
  speed: number;
  /** Steepest slope this traveller may cross, degrees. */
  maxSlope: number;
  /** Slope above which progress is slow and risky, degrees. */
  cautionSlope: number;
}

/**
 * Limits used for both driving and route planning.
 * Rover: crew rover at 10 km/h (Apollo LRV class); slopes over 25 deg are no-go.
 * Astronaut: suited walking pace 0.9 m/s (Apollo EVA traverses ran ~0.6-1.1 m/s); slopes over 20 deg are no-go.
 */
export const PROFILES: Record<TravelMode, TravelProfile> = {
  rover: { mode: 'rover', label: 'Crew rover', speed: 2.8, maxSlope: 25, cautionSlope: 15 },
  astronaut: { mode: 'astronaut', label: 'Astronaut on foot', speed: 0.9, maxSlope: 20, cautionSlope: 12 },
};

export interface ControlInput {
  throttle: number;
  steer: number;
}

/** Shared ground movement: heading + speed over the heightfield with slope limits. */
export abstract class Explorer {
  readonly position = new THREE.Vector3();
  readonly forward = new THREE.Vector3(0, 0, 1);
  heading = 0;
  speed = 0;
  slopeDeg = 0;
  blocked = false;
  odometer = 0;

  protected constructor(protected readonly site: SiteData, readonly profile: TravelProfile) {}

  place(x: number, z: number, heading = this.heading): void {
    this.position.set(x, this.site.groundAt(x, z), z);
    this.heading = heading;
    this.speed = 0;
    this.forward.set(Math.sin(heading), 0, Math.cos(heading));
  }

  /** `timeScale` speeds travel up for playability; real surface speeds are far lower. */
  protected move(input: ControlInput, dt: number, timeScale: number, turnRate: number): void {
    const field = this.site.local;
    const profile = this.profile;
    const target = input.throttle * profile.speed * timeScale * (input.throttle < 0 ? 0.5 : 1);
    const rate = Math.abs(target) > Math.abs(this.speed) ? 2.4 : 5;
    this.speed += (target - this.speed) * Math.min(1, rate * dt);
    if (Math.abs(this.speed) < 0.01 && input.throttle === 0) this.speed = 0;

    const direction = this.speed < -0.05 ? -1 : 1;
    this.heading -= input.steer * turnRate * dt * direction;
    this.forward.set(Math.sin(this.heading), 0, Math.cos(this.heading));

    const x = this.position.x;
    const z = this.position.z;
    this.slopeDeg = field.slopeDegAt(x, z, 2.5);
    // Grade along the direction of travel slows climbing.
    const ahead = field.heightAt(x + this.forward.x * 2, z + this.forward.z * 2);
    const behind = field.heightAt(x - this.forward.x * 2, z - this.forward.z * 2);
    const grade = ((ahead - behind) / 4) * direction;
    const slowdown = THREE.MathUtils.clamp(1 - Math.max(grade, 0) * 1.6, 0.35, 1) *
      (this.slopeDeg > profile.cautionSlope ? 0.7 : 1);

    const step = this.speed * slowdown * dt;
    const nx = x + this.forward.x * step;
    const nz = z + this.forward.z * step;
    const look = Math.sign(step) * 1.5;
    const slopeAhead = field.slopeDegAt(nx + this.forward.x * look, nz + this.forward.z * look, 2.5);
    // Near the map edge only moves back toward the middle are allowed.
    const inside = field.contains(nx, nz, 40) || Math.max(Math.abs(nx), Math.abs(nz)) < Math.max(Math.abs(x), Math.abs(z));
    // Refuse to enter no-go slopes, but always allow backing out of one.
    this.blocked = step !== 0 && (!inside || (slopeAhead > profile.maxSlope && slopeAhead >= this.slopeDeg));
    if (this.blocked) {
      this.speed *= Math.max(0, 1 - 12 * dt);
    } else {
      this.position.x = nx;
      this.position.z = nz;
      this.odometer += Math.abs(step);
    }
    this.position.y = field.heightAt(this.position.x, this.position.z);
  }

  /** Manual control. */
  update(input: ControlInput, dt: number, timeScale: number): void {
    this.move(input, dt, timeScale, this.turnRate);
    this.refresh(dt, input.steer);
  }

  /** Move straight to a point on a planned route (auto-follow). */
  follow(x: number, z: number, heading: number, speed: number, dt: number): void {
    const field = this.site.local;
    this.odometer += Math.hypot(x - this.position.x, z - this.position.z);
    // Turn smoothly toward the route direction.
    const turn = Math.atan2(Math.sin(heading - this.heading), Math.cos(heading - this.heading));
    this.heading += turn * Math.min(1, 6 * dt);
    this.forward.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.position.set(x, field.heightAt(x, z), z);
    this.speed = speed;
    this.blocked = false;
    this.slopeDeg = field.slopeDegAt(x, z, 2.5);
    this.refresh(dt, THREE.MathUtils.clamp(-turn * 2, -1, 1));
  }

  protected abstract readonly turnRate: number;
  /** Update the visible model after a move. */
  protected abstract refresh(dt: number, steer: number): void;
}
