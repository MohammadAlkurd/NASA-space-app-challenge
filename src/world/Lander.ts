import * as THREE from 'three';
import type { SiteData } from './SiteData';

/** The crew lander that brought you to Mars: a stubby rocket standing on four legs at the landing site. */
export class Lander {
  readonly group = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(private readonly site: SiteData) {
    const hull = this.material(0xe9e4da, 0.55, 0.25);
    const dark = this.material(0x2b2c30, 0.6, 0.6);
    const foil = this.material(0xc9963a, 0.35, 0.85);
    const glass = this.material(0x16303a, 0.15, 0.4);

    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
      this.geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return mesh;
    };

    // Engine section, tank, crew cabin and nose, bottom to top. The body is 3.6 m wide and 14 m tall.
    add(new THREE.CylinderGeometry(0.9, 1.5, 1.3, 20, 1, true), dark, 0, 1.75, 0);
    add(new THREE.CylinderGeometry(1.8, 1.8, 1.2, 24), foil, 0, 3, 0);
    add(new THREE.CylinderGeometry(1.8, 1.8, 6.2, 24), hull, 0, 6.7, 0);
    add(new THREE.CylinderGeometry(1.82, 1.82, 0.35, 24), dark, 0, 9.4, 0);
    add(new THREE.CylinderGeometry(1.25, 1.8, 2.2, 24), hull, 0, 10.9, 0);
    add(new THREE.SphereGeometry(1.25, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), hull, 0, 12, 0);

    for (let k = 0; k < 4; k += 1) {
      const angle = Math.PI / 4 + (k * Math.PI) / 2;
      const dx = Math.cos(angle);
      const dz = Math.sin(angle);
      // Leg strut from the tank out to a foot pad 4.2 m from the centre.
      const top = new THREE.Vector3(dx * 1.7, 4.4, dz * 1.7);
      const foot = new THREE.Vector3(dx * 4.2, 0.15, dz * 4.2);
      const strut = add(new THREE.CylinderGeometry(0.11, 0.14, top.distanceTo(foot), 8), dark, 0, 0, 0);
      strut.position.copy(top).add(foot).multiplyScalar(0.5);
      strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), foot.clone().sub(top).normalize());
      const brace = add(new THREE.CylinderGeometry(0.07, 0.07, 3.1, 6), dark, 0, 0, 0);
      const low = new THREE.Vector3(dx * 1.75, 2.6, dz * 1.75);
      brace.position.copy(low).add(foot).multiplyScalar(0.5);
      brace.scale.y = low.distanceTo(foot) / 3.1;
      brace.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), foot.clone().sub(low).normalize());
      add(new THREE.CylinderGeometry(0.55, 0.65, 0.16, 14), foil, foot.x, 0.08, foot.z);
    }

    // Hatch, window and ladder on the side facing +x.
    add(new THREE.BoxGeometry(0.12, 1.5, 0.95), dark, 1.8, 5.2, 0);
    add(new THREE.BoxGeometry(0.1, 0.45, 0.8), glass, 1.52, 11, 0).rotation.z = 0.25;
    add(new THREE.BoxGeometry(0.06, 4.4, 0.06), dark, 2.05, 2.3, -0.3).rotation.z = -0.16;
    add(new THREE.BoxGeometry(0.06, 4.4, 0.06), dark, 2.05, 2.3, 0.3).rotation.z = -0.16;
    for (let r = 0; r < 8; r += 1) add(new THREE.BoxGeometry(0.05, 0.05, 0.6), dark, 2.4 - r * 0.088, 0.45 + r * 0.52, 0);

    // Ground scorched by the landing burn.
    const scorch = new THREE.Mesh(
      new THREE.CircleGeometry(7, 40),
      new THREE.MeshBasicMaterial({ color: 0x140c08, transparent: true, opacity: 0.42, depthWrite: false }),
    );
    this.geometries.push(scorch.geometry);
    this.materials.push(scorch.material);
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.y = 0.06;
    this.group.add(scorch);
  }

  /** Stand the lander on the ground at this map position. */
  place(x: number, z: number): void {
    let lowest = Infinity;
    for (let k = 0; k < 4; k += 1) {
      const angle = Math.PI / 4 + (k * Math.PI) / 2;
      lowest = Math.min(lowest, this.site.groundAt(x + Math.cos(angle) * 4.2, z + Math.sin(angle) * 4.2));
    }
    this.group.position.set(x, lowest, z);
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
  }

  private material(color: number, roughness: number, metalness: number): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    this.materials.push(material);
    return material;
  }
}
