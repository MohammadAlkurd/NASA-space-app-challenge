import * as THREE from 'three';
import type { Analysis } from '../planning/Analysis';
import type { SiteData } from './SiteData';

const CELL = 5;
const RADIUS = 110;
const MAX = 2600;

function hash(x: number, z: number, salt: number): number {
  let h = (x * 374761393 + z * 668265263 + salt * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function rockGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const position = geometry.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i += 1) {
    v.fromBufferAttribute(position, i);
    // Same displacement for coincident vertices so facets stay closed.
    const n = hash(Math.round(v.x * 50), Math.round(v.y * 50) * 7 + Math.round(v.z * 50) * 13, 3);
    v.multiplyScalar(0.72 + 0.5 * n);
    v.y *= 0.62;
    position.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Loose rocks around the traveller. The orbital data cannot resolve rocks this small, so they are
 * illustrative only: placed by a fixed pattern, denser where the elevation model is rougher.
 */
export class Rocks {
  readonly mesh: THREE.InstancedMesh;
  private readonly center = new THREE.Vector2(Infinity, Infinity);
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly scale = new THREE.Vector3();
  private readonly position = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor(private readonly site: SiteData, private readonly analysis: Analysis) {
    const material = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, flatShading: true });
    this.mesh = new THREE.InstancedMesh(rockGeometry(), material, MAX);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  update(focus: THREE.Vector3): void {
    if (Math.hypot(focus.x - this.center.x, focus.z - this.center.y) < 25) return;
    this.center.set(focus.x, focus.z);
    const field = this.site.local;
    const i0 = Math.floor((focus.x - RADIUS) / CELL);
    const i1 = Math.ceil((focus.x + RADIUS) / CELL);
    const j0 = Math.floor((focus.z - RADIUS) / CELL);
    const j1 = Math.ceil((focus.z + RADIUS) / CELL);
    let count = 0;
    for (let j = j0; j <= j1 && count < MAX; j += 1) {
      for (let i = i0; i <= i1 && count < MAX; i += 1) {
        const cx = (i + 0.5) * CELL;
        const cz = (j + 0.5) * CELL;
        if (!field.contains(cx, cz, 10) || Math.hypot(cx - focus.x, cz - focus.z) > RADIUS) continue;
        const rough = this.analysis.roughness[this.analysis.index(cx, cz)];
        const density = 0.22 + Math.min(1, rough / 0.4) * 0.6;
        for (let k = 0; k < 2 && count < MAX; k += 1) {
          if (hash(i, j, 11 + k) > density) continue;
          const x = cx + (hash(i, j, 21 + k) - 0.5) * CELL;
          const z = cz + (hash(i, j, 31 + k) - 0.5) * CELL;
          // Mostly pebbles and cobbles, a few boulders.
          const size = 0.06 + 0.55 * Math.pow(hash(i, j, 41 + k), 4) + 0.1 * hash(i, j, 51 + k);
          this.position.set(x, field.heightAt(x, z) - size * 0.2, z);
          this.euler.set((hash(i, j, 61 + k) - 0.5) * 0.6, hash(i, j, 71 + k) * Math.PI * 2, (hash(i, j, 81 + k) - 0.5) * 0.6);
          this.scale.set(size * (0.8 + 0.5 * hash(i, j, 91 + k)), size, size * (0.8 + 0.5 * hash(i, j, 101 + k)));
          this.matrix.compose(this.position, this.quaternion.setFromEuler(this.euler), this.scale);
          this.mesh.setMatrixAt(count, this.matrix);
          const shade = 0.75 + 0.4 * hash(i, j, 111 + k);
          this.mesh.setColorAt(count, this.color.setRGB(0.25 * shade, 0.18 * shade, 0.145 * shade));
          count += 1;
        }
      }
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
