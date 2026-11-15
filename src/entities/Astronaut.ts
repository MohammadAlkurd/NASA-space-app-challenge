import * as THREE from 'three';
import type { SiteData } from '../world/SiteData';
import { disposeModel, loadModel, materialNamed } from '../world/Models';
import { Explorer, PROFILES } from './Explorer';

/** A camera looks down -Z; the lamp rig points down +Z. */
const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const EYE = 1.72;
const SIDEWAYS = new THREE.Vector3(1, 0, 0);
const turn = new THREE.Quaternion();
type Bone = 'hips' | 'thighL' | 'shinL' | 'thighR' | 'shinR' | 'armL' | 'armR' | 'foreL' | 'foreR';
const BONES: Bone[] = ['hips', 'thighL', 'shinL', 'thighR', 'shinR', 'armL', 'armR', 'foreL', 'foreR'];

/**
 * Suited crew member on foot. The model is NASA's Mark III planetary suit (NASA 3D Resources),
 * reduced for the web, with a few bones added so the legs and arms swing while walking. The model's arm bones
 * already hold the resting pose (arms hanging at the sides, elbows a little bent); walking swings them from there.
 */
export class Astronaut extends Explorer {
  readonly group = new THREE.Group();
  readonly eye = new THREE.Vector3();
  /** Helmet lamp beam. Kept outside `group` so it still shines in the helmet view, where the body is hidden. */
  readonly lights = new THREE.Group();
  private readonly beam = new THREE.SpotLight(0xeaf4ff, 0, 32, 0.6, 0.7, 1.6);
  private readonly lamp: THREE.MeshStandardMaterial;
  private readonly bones: Record<Bone, THREE.Object3D>;
  private readonly rest: Record<Bone, THREE.Quaternion>;
  private readonly hipsY: number;
  private stride = 0;

  private constructor(site: SiteData, private readonly model: THREE.Object3D) {
    super(site, PROFILES.astronaut);
    this.group.add(model);
    model.traverse((object) => {
      // The bind-pose bounds do not follow the bones, so never cull the suit.
      if ((object as THREE.SkinnedMesh).isSkinnedMesh) object.frustumCulled = false;
    });
    const bone = (name: string): THREE.Object3D => {
      const node = model.getObjectByName(name);
      if (!node) throw new Error(`astronaut model has no "${name}" bone`);
      return node;
    };
    this.bones = Object.fromEntries(BONES.map((name) => [name, bone(name)])) as Record<Bone, THREE.Object3D>;
    this.rest = Object.fromEntries(BONES.map((name) => [name, this.bones[name].quaternion.clone()])) as Record<Bone, THREE.Quaternion>;
    this.hipsY = this.bones.hips.position.y;
    this.lamp = materialNamed(model, 'lamp')!;
    this.lamp.emissive.set(0xeaf4ff);
    this.lamp.emissiveIntensity = 0;
    this.beam.position.set(0, 0.2, 0.15);
    this.beam.target.position.set(0, -1.6, 9);
    this.lights.add(this.beam, this.beam.target);
    this.pose(0);
  }

  static async create(site: SiteData): Promise<Astronaut> {
    return new Astronaut(site, (await loadModel('astronaut')).scene);
  }

  dispose(): void {
    disposeModel(this.model);
  }

  /** Helmet lamp. The light stays in the scene at zero strength so switching costs no shader rebuild. */
  setLight(on: boolean): void {
    this.beam.intensity = on ? 80 : 0;
    this.lamp.emissiveIntensity = on ? 3 : 0;
  }

  /** Point the lamp where the helmet looks: along the camera in the helmet view, along the heading otherwise. */
  aimLight(camera: THREE.Camera | null): void {
    this.lights.position.copy(this.eye);
    if (camera) this.lights.quaternion.copy(camera.quaternion).multiply(FLIP);
    else this.lights.rotation.set(0, this.heading, 0);
  }

  protected readonly turnRate = 1.5;

  protected refresh(dt: number): void {
    this.stride += Math.abs(this.speed) * dt * 1.4;
    const swing = Math.min(1, Math.abs(this.speed) / 3) * 0.6;
    this.pose(Math.sin(this.stride) * swing / 0.6);
    this.group.position.copy(this.position);
    this.group.rotation.y = this.heading;
    this.eye.set(this.position.x, this.position.y + EYE, this.position.z);
  }

  override place(x: number, z: number, heading?: number): void {
    super.place(x, z, heading);
    this.group.position.copy(this.position);
    this.group.rotation.y = this.heading;
    this.eye.set(this.position.x, this.position.y + EYE, this.position.z);
  }

  /** Turn an arm bone fore and aft from its resting pose. */
  private swing(name: Bone, angle: number): void {
    this.bones[name].quaternion.copy(this.rest[name]).premultiply(turn.setFromAxisAngle(SIDEWAYS, angle));
  }

  /** Walk cycle from -1 to 1: thighs and arms swing in opposition, the trailing knee bends, the body bobs. */
  private pose(k: number): void {
    const b = this.bones;
    this.swing('armL', 0.35 * k);
    this.swing('armR', -0.35 * k);
    // The elbow closes a little as its arm comes forward.
    this.swing('foreL', -0.3 * Math.max(0, -k));
    this.swing('foreR', -0.3 * Math.max(0, k));
    b.thighL.rotation.x = -0.45 * k;
    b.thighR.rotation.x = 0.45 * k;
    b.shinL.rotation.x = 0.5 * Math.max(0, -k);
    b.shinR.rotation.x = 0.5 * Math.max(0, k);
    b.hips.position.y = this.hipsY - 0.03 * k * k;
  }
}
