import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { SiteData } from '../world/SiteData';
import { Explorer, PROFILES } from './Explorer';

const WHEEL_RADIUS = 0.27;
const TRACK = 1.17;
const WHEELBASE = 0.95;
// Wheel contact points in rover space: +x left, +z front.
const WHEELS = [
  { name: 'FL', x: TRACK, z: WHEELBASE },
  { name: 'ML', x: TRACK, z: 0 },
  { name: 'RL', x: TRACK, z: -WHEELBASE },
  { name: 'FR', x: -TRACK, z: WHEELBASE },
  { name: 'MR', x: -TRACK, z: 0 },
  { name: 'RR', x: -TRACK, z: -WHEELBASE },
];

export class Rover extends Explorer {
  readonly group = new THREE.Group();
  readonly mastCamera = new THREE.Object3D();
  private readonly wheels: THREE.Object3D[] = [];
  private readonly steerFront: THREE.Object3D[] = [];
  private readonly steerRear: THREE.Object3D[] = [];
  private rockerL: THREE.Object3D | null = null;
  private rockerR: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
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
  }

  static async create(site: SiteData): Promise<Rover> {
    const rover = new Rover(site);
    const gltf = await new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/rover.glb`);
    const model = gltf.scene;
    model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    for (const wheel of WHEELS) {
      const node = model.getObjectByName(`wheel_${wheel.name}`);
      if (node) rover.wheels.push(node);
    }
    for (const name of ['steer_FL', 'steer_FR']) {
      const node = model.getObjectByName(name);
      if (node) rover.steerFront.push(node);
    }
    for (const name of ['steer_RL', 'steer_RR']) {
      const node = model.getObjectByName(name);
      if (node) rover.steerRear.push(node);
    }
    rover.rockerL = model.getObjectByName('rocker_L') ?? null;
    rover.rockerR = model.getObjectByName('rocker_R') ?? null;
    const mast = model.getObjectByName('cam_mast');
    rover.mastCamera.position.copy(mast?.position ?? new THREE.Vector3(0, 2.1, 0.95));
    // Cameras look down -Z; the rover faces +Z.
    rover.mastCamera.rotation.set(0, Math.PI, 0);
    rover.group.add(model, rover.mastCamera);
    const idle = gltf.animations.find((clip) => clip.name === 'idle');
    if (idle) {
      rover.mixer = new THREE.AnimationMixer(model);
      rover.mixer.clipAction(idle).play();
    }
    return rover;
  }

  override place(x: number, z: number, heading?: number): void {
    super.place(x, z, heading);
    this.settled = false;
    this.updatePose(1);
  }

  protected readonly turnRate = 0.9;

  protected refresh(dt: number, steer: number): void {
    this.steerAngle += (steer * -0.42 - this.steerAngle) * Math.min(1, 8 * dt);
    for (const node of this.steerFront) node.rotation.y = this.steerAngle;
    for (const node of this.steerRear) node.rotation.y = -this.steerAngle;
    const spin = (this.blocked ? 0 : this.speed * dt) / WHEEL_RADIUS;
    for (const wheel of this.wheels) wheel.rotation.x += spin;
    this.mixer?.update(dt);
    this.updatePose(Math.min(1, 9 * dt));
  }

  /** Rest the six wheels on the terrain: fit pitch/roll, then articulate the rockers. */
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

    // Rocker tilt takes up what the rigid-body fit cannot: front wheel vs. the rear pair.
    const plane = (i: number) => mean + WHEELS[i].z * pitchSlope + WHEELS[i].x * rollSlope;
    const tiltL = THREE.MathUtils.clamp(-(h[0] - plane(0)) / 0.85, -0.22, 0.22);
    const tiltR = THREE.MathUtils.clamp(-(h[3] - plane(3)) / 0.85, -0.22, 0.22);
    if (this.rockerL) this.rockerL.rotation.x += (tiltL - this.rockerL.rotation.x) * blend;
    if (this.rockerR) this.rockerR.rotation.x += (tiltR - this.rockerR.rotation.x) * blend;
  }
}
