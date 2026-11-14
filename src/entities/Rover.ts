import * as THREE from 'three';
import type { SiteData } from '../world/SiteData';
import { Explorer, PROFILES } from './Explorer';

const WHEEL_RADIUS = 0.6;
const TRACK = 1.5;
const WHEELBASE = 1.8;
// Wheel contact points in rover space: +x left, +z front.
const WHEELS = [
  { x: TRACK, z: WHEELBASE },
  { x: TRACK, z: 0 },
  { x: TRACK, z: -WHEELBASE },
  { x: -TRACK, z: WHEELBASE },
  { x: -TRACK, z: 0 },
  { x: -TRACK, z: -WHEELBASE },
];
/** Where the crew stands to use the airlock, in rover space (left side, behind the cockpit). */
const HATCH = new THREE.Vector3(2.5, 0, -0.5);

/**
 * Pressurised crew rover: a cabin two people can live in for days, an airlock on the left side,
 * solar wings on the roof. It is the crew's vehicle and their shelter.
 */
export class Rover extends Explorer {
  readonly group = new THREE.Group();
  /** Driver's eye, just ahead of the windscreen. */
  readonly mastCamera = new THREE.Object3D();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly mounts: THREE.Object3D[] = [];
  private readonly steers: THREE.Object3D[] = [];
  private readonly wheels: THREE.Object3D[] = [];
  private readonly door = new THREE.Group();
  private readonly windows: THREE.MeshStandardMaterial;
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

  private constructor(site: SiteData) {
    super(site, PROFILES.rover);
    this.group.name = 'rover';
    const hull = this.material(0xe6e1d6, 0.6, 0.2);
    const dark = this.material(0x2a2b2f, 0.7, 0.5);
    const tyre = this.material(0x1c1c1f, 0.95, 0.1);
    const foil = this.material(0xc9963a, 0.35, 0.85);
    const stripe = this.material(0xd9642a, 0.6, 0.2);
    const panel = this.material(0x16264d, 0.3, 0.7);
    this.windows = this.material(0x10222b, 0.15, 0.5);
    this.windows.emissive.set(0xffc27a);
    this.windows.emissiveIntensity = 0;

    const box = (w: number, h: number, l: number) => new THREE.BoxGeometry(w, h, l);
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.group): THREE.Mesh => {
      this.geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };

    // Chassis and pressurised cabin.
    add(box(2.5, 0.3, 5.2), dark, 0, 1.05, 0);
    add(box(2.6, 1.9, 3.5), hull, 0, 2.15, -0.45);
    add(box(2.62, 0.22, 3.52), stripe, 0, 1.45, -0.45);
    // Cockpit: lower nose with a raked windscreen and side windows.
    add(box(2.4, 1.0, 1.3), hull, 0, 1.7, 1.9);
    add(box(2.2, 1.0, 0.08), this.windows, 0, 2.6, 1.75).rotation.x = -0.55;
    add(box(2.36, 0.08, 1.0), hull, 0, 3.06, 1.4);
    for (const side of [1, -1]) {
      add(box(0.06, 0.75, 0.95), this.windows, side * 1.2, 2.6, 1.72);
      add(box(0.06, 0.55, 0.9), this.windows, side * 1.31, 2.55, -1.5);
      // Headlights.
      add(box(0.3, 0.16, 0.06), foil, side * 0.85, 1.5, 2.57);
    }
    // Airlock on the left: a frame, a door that swings open, and a step.
    add(box(0.08, 1.75, 1.1), dark, 1.31, 2.05, HATCH.z);
    this.door.position.set(1.36, 1.2, HATCH.z + 0.45);
    add(box(0.07, 1.6, 0.9), hull, 0, 0.8, -0.45, this.door);
    add(box(0.09, 0.4, 0.4), this.windows, 0.01, 1.2, -0.45, this.door);
    this.group.add(this.door);
    add(box(0.7, 0.08, 0.9), dark, 1.65, 0.75, HATCH.z);
    // Life support at the back: air tanks, radiator, antenna.
    for (const side of [1, -1]) {
      const tank = add(new THREE.CylinderGeometry(0.28, 0.28, 1.5, 12), foil, side * 0.7, 1.75, -2.45);
      tank.rotation.z = Math.PI / 2;
    }
    add(box(2.2, 0.9, 0.12), dark, 0, 2.5, -2.26);
    add(new THREE.CylinderGeometry(0.03, 0.03, 1.3, 6), dark, -0.9, 3.75, -1.8);
    add(new THREE.SphereGeometry(0.45, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2.4), hull, 0.8, 3.45, -1.7).rotation.x = Math.PI + 0.5;
    // Solar wings: 8 m² in two panels over the roof.
    for (const side of [1, -1]) {
      add(box(2.0, 0.05, 2.0), panel, side * 1.25, 3.2, -0.7).rotation.z = side * -0.08;
    }

    const wheelGeometry = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.5, 18);
    wheelGeometry.rotateZ(Math.PI / 2);
    const hubGeometry = new THREE.CylinderGeometry(0.3, 0.3, 0.54, 8);
    hubGeometry.rotateZ(Math.PI / 2);
    for (const wheel of WHEELS) {
      const mount = new THREE.Object3D();
      mount.position.set(wheel.x, WHEEL_RADIUS, wheel.z);
      const steer = new THREE.Object3D();
      const spin = new THREE.Object3D();
      add(wheelGeometry, tyre, 0, 0, 0, spin);
      add(hubGeometry, hull, 0, 0, 0, spin);
      // Strut from the wheel up to the chassis.
      add(box(0.14, 0.7, 0.14), dark, -Math.sign(wheel.x) * 0.32, 0.3, 0, steer);
      steer.add(spin);
      mount.add(steer);
      this.group.add(mount);
      this.mounts.push(mount);
      this.steers.push(steer);
      this.wheels.push(spin);
    }

    this.mastCamera.position.set(0, 2.55, 2.75);
    // Cameras look down -Z; the rover faces +Z.
    this.mastCamera.rotation.set(0, Math.PI, 0);
    this.group.add(this.mastCamera);
  }

  static async create(site: SiteData): Promise<Rover> {
    return new Rover(site);
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

  /** Cabin lights show through the windows while the crew is living inside. */
  setCabinLight(level: number): void {
    this.windows.emissiveIntensity = level;
  }

  /** Runs every frame, moving or parked. */
  animate(dt: number): void {
    this.doorOpen += (this.doorTarget - this.doorOpen) * Math.min(1, 6 * dt);
    this.door.rotation.y = this.doorOpen * -1.9;
  }

  override place(x: number, z: number, heading?: number): void {
    super.place(x, z, heading);
    this.settled = false;
    this.updatePose(1);
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
  }

  protected readonly turnRate = 0.7;

  protected refresh(dt: number, steer: number): void {
    this.steerAngle += (steer * -0.42 - this.steerAngle) * Math.min(1, 8 * dt);
    for (const i of [0, 3]) this.steers[i].rotation.y = this.steerAngle;
    for (const i of [2, 5]) this.steers[i].rotation.y = -this.steerAngle;
    const spin = (this.blocked ? 0 : this.speed * dt) / WHEEL_RADIUS;
    for (const wheel of this.wheels) wheel.rotation.x += spin;
    this.updatePose(Math.min(1, 9 * dt));
  }

  private material(color: number, roughness: number, metalness: number): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    this.materials.push(material);
    return material;
  }

  /** Rest the six wheels on the terrain: fit pitch and roll, then let each wheel's suspension take up the rest. */
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
      const travel = THREE.MathUtils.clamp(h[i] - plane, -0.3, 0.3);
      this.mounts[i].position.y += (WHEEL_RADIUS + travel - this.mounts[i].position.y) * blend;
    }
  }
}
