import * as THREE from 'three';
import type { SiteData } from '../world/SiteData';

export type CameraMode = 'chase' | 'first' | 'map';

const tmp = new THREE.Vector3();
const lookAt = new THREE.Vector3();

/** Chase, first-person and top-down map cameras. Drag to look around, wheel/pinch to zoom. */
export class CameraRig {
  mode: CameraMode = 'chase';
  /** Look offset relative to the traveller's heading (chase/first) in radians. */
  yaw = 0;
  pitch = 0.3;
  distance = 9;
  /** Map view: centre and height above ground. */
  readonly mapCenter = new THREE.Vector3();
  mapHeight = 1500;
  private snap = true;

  constructor(readonly camera: THREE.PerspectiveCamera, private readonly site: SiteData) {}

  setMode(mode: CameraMode, focus?: THREE.Vector3): void {
    this.mode = mode;
    this.snap = true;
    if (mode === 'map' && focus) this.mapCenter.copy(focus);
    if (mode !== 'map') this.yaw = 0;
  }

  /** Map view: fit a box into the part of the screen the panels leave free (margins in pixels). */
  frame(minX: number, maxX: number, minZ: number, maxZ: number, side: number, bottom: number): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const freeW = Math.max(width - 2 * side, width * 0.4);
    const freeH = Math.max(height - bottom, height * 0.4);
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    // Metres per pixel needed to fit the box, then the camera height that gives it.
    const scale = Math.max((maxX - minX + 120) / freeW, (maxZ - minZ + 120) / freeH);
    this.mapHeight = THREE.MathUtils.clamp((scale * height) / (2 * tan), 250, 4200);
    const metresPerPixel = (2 * this.mapHeight * tan) / height;
    // The free area sits above the bottom panel, so the box centre goes above the screen centre.
    this.mapCenter.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2 + (bottom / 2) * metresPerPixel);
  }

  drag(dx: number, dy: number): void {
    if (this.mode === 'map') {
      // Pan: one screen height spans the visible ground.
      const scale = (2 * this.mapHeight * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / window.innerHeight;
      const limit = this.site.local.half;
      this.mapCenter.x = THREE.MathUtils.clamp(this.mapCenter.x - dx * scale, -limit, limit);
      this.mapCenter.z = THREE.MathUtils.clamp(this.mapCenter.z - dy * scale, -limit, limit);
      return;
    }
    this.yaw -= dx * 0.005;
    const [min, max] = this.mode === 'first' ? [-0.9, 0.9] : [0.02, 1.25];
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, min, max);
  }

  zoom(factor: number): void {
    if (this.mode === 'map') this.mapHeight = THREE.MathUtils.clamp(this.mapHeight * factor, 120, 4200);
    else this.distance = THREE.MathUtils.clamp(this.distance * factor, 4, 60);
  }

  /** `eye` is the first-person eye position; `heading` the traveller's yaw. */
  update(target: THREE.Vector3, heading: number, eye: THREE.Vector3, dt: number): void {
    const camera = this.camera;
    if (this.mode === 'map') {
      const ground = this.site.groundAt(this.mapCenter.x, this.mapCenter.z);
      camera.position.set(this.mapCenter.x, ground + this.mapHeight, this.mapCenter.z);
      camera.up.set(0, 0, -1);
      camera.lookAt(this.mapCenter.x, ground, this.mapCenter.z);
      return;
    }
    camera.up.set(0, 1, 0);
    if (this.mode === 'first') {
      const angle = heading + this.yaw;
      camera.position.copy(eye);
      const cp = Math.cos(this.pitch);
      lookAt.set(eye.x + Math.sin(angle) * cp, eye.y - Math.sin(this.pitch), eye.z + Math.cos(angle) * cp);
      camera.lookAt(lookAt);
      return;
    }
    const angle = heading + this.yaw + Math.PI;
    const cp = Math.cos(this.pitch);
    tmp.set(
      target.x + Math.sin(angle) * cp * this.distance,
      target.y + 1.4 + Math.sin(this.pitch) * this.distance,
      target.z + Math.cos(angle) * cp * this.distance,
    );
    tmp.y = Math.max(tmp.y, this.site.groundAt(tmp.x, tmp.z) + 0.8);
    if (this.snap) camera.position.copy(tmp);
    else camera.position.lerp(tmp, 1 - Math.exp(-6 * dt));
    this.snap = false;
    lookAt.set(target.x, target.y + 1.5, target.z);
    camera.lookAt(lookAt);
  }
}
