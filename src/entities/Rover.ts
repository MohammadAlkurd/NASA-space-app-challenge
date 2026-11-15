import * as THREE from 'three';
import type { SiteData } from '../world/SiteData';
import { disposeModel, loadModel, materialNamed } from '../world/Models';
import { Explorer, PROFILES } from './Explorer';

const WHEEL_RADIUS = 0.33;
const TRACK = 1.46;
const WHEELBASE = 1.46;
// Wheel-pair contact points in rover space: +x left, +z front. Same order as module_0..5 in the model.
const WHEELS = [
  { x: TRACK, z: WHEELBASE },
  { x: TRACK, z: 0 },
  { x: TRACK, z: -WHEELBASE },
  { x: -TRACK, z: WHEELBASE },
  { x: -TRACK, z: 0 },
  { x: -TRACK, z: -WHEELBASE },
];
/** Where the crew stands to use the side hatch, in rover space (left side, behind the cockpit). */
const HATCH = new THREE.Vector3(2.5, 0, 0.75);
/** The suspension arms are part of each wheel unit, so they can only move a little before they leave the frame. */
const TRAVEL = 0.12;

/**
 * Pressurised crew rover: a cabin two people can live in for days, a hatch on the left side,
 * solar cells on the flanks. It is the crew's vehicle and their shelter.
 * The model is NASA's Space Exploration Vehicle concept (NASA 3D Resources), reduced for the web.
 */
export class Rover extends Explorer {
  readonly group = new THREE.Group();
  /** Driver's eye, just ahead of the windscreen. */
  readonly mastCamera = new THREE.Object3D();
  /** Headlight beam. Kept outside `group` so it still shines when the rover is hidden from its own mast camera. */
  readonly lights = new THREE.Group();
  private readonly beam = new THREE.SpotLight(0xfff1d6, 0, 70, 0.55, 0.6, 1.6);
  private readonly lamps: THREE.MeshStandardMaterial;
  private readonly windows: THREE.MeshStandardMaterial;
  private readonly tail = new THREE.MeshStandardMaterial({ color: 0x5a1410, roughness: 0.4, emissive: 0xff2a1a, emissiveIntensity: 0 });
  private readonly tailGeometry = new THREE.BoxGeometry(0.22, 0.1, 0.05);
  private readonly mounts: THREE.Object3D[] = [];
  private readonly wheels: THREE.Object3D[] = [];
  private readonly door: THREE.Object3D;
  private doorOpen = 0;
  private doorTarget = 0;
  private steerAngle = 0;
  private readonly wheelHeights = new Float32Array(6);
  private readonly targetQuat = new THREE.Quaternion();
  private readonly up = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly front = new THREE.Vector3();
  private readonly basis = new THREE.Matrix4();
  private bodyY = 0;
  private settled = false;

  private constructor(site: SiteData, private readonly model: THREE.Object3D) {
    super(site, PROFILES.rover);
    this.group.name = 'rover';
    this.group.add(model);
    const part = (name: string): THREE.Object3D => {
      const node = model.getObjectByName(name);
      if (!node) throw new Error(`rover model has no "${name}" part`);
      return node;
    };
    for (let i = 0; i < 6; i += 1) {
      this.mounts.push(part(`module_${i}`));
      this.wheels.push(part(`wheel_${i}`));
    }
    this.door = part('door');
    // Cockpit glass glows when the cabin is lit; the lamp pods on the brow glow with the headlights.
    this.windows = materialNamed(model, 'glass')!;
    this.windows.emissive.set(0xffc27a);
    this.windows.emissiveIntensity = 0;
    this.lamps = materialNamed(model, 'lamps')!;
    this.lamps.emissive.set(0xfff1d6);
    this.lamps.emissiveIntensity = 0;
    for (const side of [1, -1]) {
      const lamp = new THREE.Mesh(this.tailGeometry, this.tail);
      lamp.position.set(side * 0.95, 1.05, -2.1);
      this.group.add(lamp);
    }
    this.beam.position.set(0, 2.7, 2.4);
    this.beam.target.position.set(0, 0.2, 16);
    this.lights.add(this.beam, this.beam.target);

    this.mastCamera.position.set(0, 2.1, 2.7);
    // Cameras look down -Z; the rover faces +Z.
    this.mastCamera.rotation.set(0, Math.PI, 0);
    this.group.add(this.mastCamera);
  }

  static async create(site: SiteData): Promise<Rover> {
    return new Rover(site, (await loadModel('rover')).scene);
  }

  /** World position on the ground beside the airlock door. */
  hatch(target: THREE.Vector3): THREE.Vector3 {
    const sin = Math.sin(this.heading);
    const cos = Math.cos(this.heading);
    const x = this.position.x + HATCH.x * cos + HATCH.z * sin;
    const z = this.position.z - HATCH.x * sin + HATCH.z * cos;
    return target.set(x, this.site.local.heightAt(x, z), z);
  }

  /** Swing the airlock door open or shut. */
  setDoor(open: boolean): void {
    this.doorTarget = open ? 1 : 0;
  }

  /** Headlights and tail lights. The light stays in the scene at zero strength so switching costs no shader rebuild. */
  setLights(on: boolean): void {
    this.beam.intensity = on ? 900 : 0;
    this.lamps.emissiveIntensity = on ? 3 : 0;
    this.tail.emissiveIntensity = on ? 2 : 0;
  }

  /** Cabin lights show through the windows while the crew is living inside. */
  setCabinLight(level: number): void {
    this.windows.emissiveIntensity = level;
  }

  /** Runs every frame, moving or parked. */
  animate(dt: number): void {
    this.doorOpen += (this.doorTarget - this.doorOpen) * Math.min(1, 6 * dt);
    this.door.rotation.y = this.doorOpen * 1.4;
    this.lights.position.copy(this.group.position);
    this.lights.quaternion.copy(this.group.quaternion);
  }

  override place(x: number, z: number, heading?: number): void {
    super.place(x, z, heading);
    this.settled = false;
    this.updatePose(1);
  }

  dispose(): void {
    disposeModel(this.model);
    this.tail.dispose();
    this.tailGeometry.dispose();
  }

  protected readonly turnRate = 0.7;

  protected refresh(dt: number, steer: number): void {
    this.steerAngle += (steer * -0.42 - this.steerAngle) * Math.min(1, 8 * dt);
    for (const i of [0, 3]) this.mounts[i].rotation.y = this.steerAngle;
    for (const i of [2, 5]) this.mounts[i].rotation.y = -this.steerAngle;
    const spin = (this.blocked ? 0 : this.speed * dt) / WHEEL_RADIUS;
    for (const wheel of this.wheels) wheel.rotation.x += spin;
    this.updatePose(Math.min(1, 9 * dt));
  }

  /** Rest the six wheel pairs on the terrain: fit pitch and roll, then let each wheel's suspension take up the rest. */
  private updatePose(blend: number): void {
    const sin = Math.sin(this.heading);
    const cos = Math.cos(this.heading);
    const field = this.site.local;
    const h = this.wheelHeights;
    for (let i = 0; i < 6; i += 1) {
      const wheel = WHEELS[i];
      // rover-space (x, z) -> world: right-handed yaw about +y with forward = (sin, cos).
      const wx = this.position.x + wheel.x * cos + wheel.z * sin;
      const wz = this.position.z - wheel.x * sin + wheel.z * cos;
      h[i] = field.heightAt(wx, wz);
    }
    const mean = (h[0] + h[1] + h[2] + h[3] + h[4] + h[5]) / 6;
    const pitchSlope = ((h[0] + h[3]) / 2 - (h[2] + h[5]) / 2) / (2 * WHEELBASE);
    const rollSlope = ((h[0] + h[1] + h[2]) / 3 - (h[3] + h[4] + h[5]) / 3) / (2 * TRACK);

    this.front.set(sin, pitchSlope, cos).normalize();
    this.right.set(cos, rollSlope, -sin).normalize();
    this.up.crossVectors(this.front, this.right).normalize();
    this.right.crossVectors(this.up, this.front).normalize();
    this.basis.makeBasis(this.right, this.up, this.front);
    this.targetQuat.setFromRotationMatrix(this.basis);

    if (!this.settled) {
      this.group.quaternion.copy(this.targetQuat);
      this.bodyY = mean;
      this.settled = true;
    } else {
      this.group.quaternion.slerp(this.targetQuat, blend);
      this.bodyY += (mean - this.bodyY) * blend;
    }
    this.group.position.set(this.position.x, this.bodyY, this.position.z);

    for (let i = 0; i < 6; i += 1) {
      const plane = mean + WHEELS[i].z * pitchSlope + WHEELS[i].x * rollSlope;
      const travel = THREE.MathUtils.clamp(h[i] - plane, -TRAVEL, TRAVEL);
      this.mounts[i].position.y += (WHEEL_RADIUS + travel - this.mounts[i].position.y) * blend;
    }
  }
}
