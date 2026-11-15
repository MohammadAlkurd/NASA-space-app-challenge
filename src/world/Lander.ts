import * as THREE from 'three';
import type { SiteData } from './SiteData';

/** The crew lander that brought you to Mars: a stubby rocket standing on four legs at the landing site. */
export class Lander {
  readonly group = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly beacon = new THREE.PointLight(0xff3b2f, 0, 45, 1.4);
  private readonly flood = new THREE.SpotLight(0xfff1d6, 0, 45, 0.85, 0.6, 1.4);
  private readonly beaconLamp: THREE.MeshStandardMaterial;
  private readonly floodLamp: THREE.MeshStandardMaterial;
  private readonly scorch: THREE.Mesh;
  private clock = 0;

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
    const profile = (points: number[][]): THREE.LatheGeometry =>
      new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), 48);
    add(profile([[1.5, 2.4], [1.8, 2.55], [1.8, 3.6]]), foil, 0, 0, 0);
    add(profile([[1.8, 3.6], [1.8, 9.2], [1.84, 9.25], [1.84, 9.55], [1.8, 9.6], [1.8, 9.8]]), hull, 0, 0, 0);
    add(profile([[1.8, 9.8], [1.55, 11.1], [1.28, 12], [1.1, 12.6], [0.75, 13.05], [0.3, 13.25], [0, 13.28]]), hull, 0, 0, 0);
    // Seams between hull panels, and the dark band under the cabin.
    for (const y of [4.6, 6.1, 7.6]) add(new THREE.TorusGeometry(1.8, 0.025, 6, 48), dark, 0, y, 0).rotation.x = Math.PI / 2;
    add(new THREE.CylinderGeometry(1.845, 1.845, 0.3, 48, 1, true), dark, 0, 9.4, 0);
    // One main engine bell ringed by four smaller ones.
    add(profile([[0.45, 2.5], [0.55, 2.1], [0.8, 1.5], [0.95, 1.1]]), dark, 0, 0, 0);
    for (let k = 0; k < 4; k += 1) {
      const angle = (k * Math.PI) / 2;
      add(profile([[0.2, 2.5], [0.26, 2.2], [0.4, 1.75]]), dark, Math.cos(angle) * 1.1, 0, Math.sin(angle) * 1.1);
      // Thruster pod and a round fuel tank between each pair of legs.
      const pod = add(new THREE.BoxGeometry(0.3, 0.45, 0.5), hull, Math.cos(angle) * 1.92, 8.6, Math.sin(angle) * 1.92);
      pod.rotation.y = -angle;
      for (const side of [-1, 1]) {
        const jet = add(new THREE.CylinderGeometry(0.05, 0.09, 0.2, 10, 1, true), dark, 0, 0, 0);
        jet.position.set(Math.cos(angle) * 1.95 - Math.sin(angle) * side * 0.34, 8.6, Math.sin(angle) * 1.95 + Math.cos(angle) * side * 0.34);
        jet.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(-Math.sin(angle) * side, 0, Math.cos(angle) * side));
      }
      if (k !== 0) add(new THREE.SphereGeometry(0.55, 20, 14), foil, Math.cos(angle) * 1.75, 3.05, Math.sin(angle) * 1.75);
    }
    // Cabin windows around the nose, each in a dark frame.
    for (let k = -2; k <= 2; k += 1) {
      const angle = k * 0.62;
      const out = new THREE.Vector3(Math.cos(angle), 0.3, Math.sin(angle));
      const frame = add(new THREE.TorusGeometry(0.24, 0.035, 8, 24), dark, out.x * 1.53, 11.2, out.z * 1.53);
      const pane = add(new THREE.CircleGeometry(0.23, 24), glass, out.x * 1.52, 11.2, out.z * 1.52);
      for (const part of [frame, pane]) part.lookAt(part.position.clone().add(out));
    }
    // Dish antenna on the far side of the hatch.
    const dish = add(new THREE.SphereGeometry(0.75, 24, 10, 0, Math.PI * 2, 0, 0.75), hull, -2.3, 10.2, 0);
    dish.rotation.z = -2.2;
    dish.material = this.material(0xe9e4da, 0.5, 0.3, THREE.DoubleSide);
    add(new THREE.CylinderGeometry(0.035, 0.035, 0.9, 6), dark, -2.0, 9.85, 0).rotation.z = 0.9;

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
      // Shock absorber sleeve, ball joint and foot pad.
      const sleeve = add(new THREE.CylinderGeometry(0.17, 0.17, 1.6, 12), hull, 0, 0, 0);
      sleeve.position.copy(top).lerp(foot, 0.22);
      sleeve.quaternion.copy(strut.quaternion);
      add(new THREE.SphereGeometry(0.2, 12, 8), dark, foot.x, 0.24, foot.z);
      add(new THREE.CylinderGeometry(0.6, 0.72, 0.14, 24), foil, foot.x, 0.07, foot.z);
    }

    // Hatch, window and ladder on the side facing +x.
    add(new THREE.BoxGeometry(0.16, 1.75, 1.2), hull, 1.78, 5.2, 0);
    add(new THREE.BoxGeometry(0.12, 1.5, 0.95), dark, 1.83, 5.2, 0);
    add(new THREE.CircleGeometry(0.16, 20), glass, 1.895, 5.6, 0).rotation.y = Math.PI / 2;
    // Porch outside the hatch, with a handrail on each side.
    add(new THREE.BoxGeometry(0.9, 0.06, 1.3), dark, 2.2, 4.42, 0);
    for (const side of [-0.62, 0.62]) {
      add(new THREE.BoxGeometry(0.9, 0.04, 0.04), dark, 2.2, 5.35, side);
      add(new THREE.BoxGeometry(0.04, 0.95, 0.04), dark, 2.63, 4.9, side);
    }
    add(new THREE.BoxGeometry(0.06, 4.4, 0.06), dark, 2.05, 2.3, -0.3).rotation.z = -0.16;
    add(new THREE.BoxGeometry(0.06, 4.4, 0.06), dark, 2.05, 2.3, 0.3).rotation.z = -0.16;
    for (let r = 0; r < 8; r += 1) add(new THREE.BoxGeometry(0.05, 0.05, 0.6), dark, 2.4 - r * 0.088, 0.45 + r * 0.52, 0);

    // Beacon on the nose and a floodlight over the hatch, so the lander can be found and reached at night.
    this.beaconLamp = this.material(0x5a1410, 0.4, 0.1);
    this.beaconLamp.emissive.set(0xff3b2f);
    add(new THREE.SphereGeometry(0.22, 12, 8), this.beaconLamp, 0, 13.35, 0).castShadow = false;
    this.beacon.position.set(0, 13.6, 0);
    this.floodLamp = this.material(0xd8d2c4, 0.3, 0.2);
    this.floodLamp.emissive.set(0xfff1d6);
    add(new THREE.BoxGeometry(0.2, 0.2, 0.5), this.floodLamp, 1.9, 6.4, 0).castShadow = false;
    this.flood.position.set(2.1, 6.4, 0);
    this.flood.target.position.set(9, 0, 0);
    this.group.add(this.beacon, this.flood, this.flood.target);

    // Ground scorched by the landing burn.
    const scorchRadius = 7;
    const scorchGeometry = new THREE.RingGeometry(0.01, scorchRadius, 40, 8);
    // Darkest under the engine, fading to nothing at the rim.
    const ring = scorchGeometry.getAttribute('position');
    const fade = new Float32Array(ring.count * 4);
    for (let i = 0; i < ring.count; i += 1) {
      const t = 1 - Math.hypot(ring.getX(i), ring.getY(i)) / scorchRadius;
      fade.set([1, 1, 1, t * t], i * 4);
    }
    scorchGeometry.setAttribute('color', new THREE.BufferAttribute(fade, 4));
    const scorch = new THREE.Mesh(
      scorchGeometry,
      new THREE.MeshBasicMaterial({ color: 0x140c08, transparent: true, opacity: 0.7, depthWrite: false, vertexColors: true }),
    );
    this.geometries.push(scorch.geometry);
    this.materials.push(scorch.material);
    scorch.rotation.x = -Math.PI / 2;
    this.group.add(scorch);
    this.scorch = scorch;
  }

  /** Beacon blink and night floodlight. `daylight` runs 0 (night) to 1 (day). */
  update(dt: number, daylight: number): void {
    this.clock = (this.clock + dt) % 2;
    const blink = this.clock < 0.25 ? 1 : 0;
    const night = 1 - daylight;
    this.beacon.intensity = blink * 60 * night;
    this.beaconLamp.emissiveIntensity = blink * (1.5 + 4 * night);
    this.flood.intensity = 500 * THREE.MathUtils.smoothstep(night, 0.4, 0.8);
    this.floodLamp.emissiveIntensity = 3 * THREE.MathUtils.smoothstep(night, 0.4, 0.8);
  }

  /** Where the ladder meets the ground, in map coordinates. */
  get ladderFoot(): { x: number; z: number } {
    return { x: this.group.position.x, z: this.group.position.z + 5.5 };
  }

  /** Stand the lander on the ground at this map position. */
  place(x: number, z: number): void {
    let lowest = Infinity;
    for (let k = 0; k < 4; k += 1) {
      const angle = Math.PI / 4 + (k * Math.PI) / 2;
      lowest = Math.min(lowest, this.site.groundAt(x + Math.cos(angle) * 4.2, z + Math.sin(angle) * 4.2));
    }
    this.group.position.set(x, lowest, z);
    // The hatch and ladder face south, so the crew steps off with the rover in view to the west.
    this.group.rotation.y = -Math.PI / 2;
    // Lay the scorch mark on the ground, vertex by vertex.
    this.group.updateMatrixWorld(true);
    const points = this.scorch.geometry.getAttribute('position');
    const point = new THREE.Vector3();
    for (let i = 0; i < points.count; i += 1) {
      point.fromBufferAttribute(points, i).setZ(0);
      this.scorch.localToWorld(point);
      points.setZ(i, this.site.groundAt(point.x, point.z) - lowest + 0.06);
    }
    points.needsUpdate = true;
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
  }

  private material(color: number, roughness: number, metalness: number, side: THREE.Side = THREE.FrontSide): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ color, roughness, metalness, side });
    this.materials.push(material);
    return material;
  }
}
