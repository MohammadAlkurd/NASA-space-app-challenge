import * as THREE from 'three';
import type { SiteData } from '../world/SiteData';
import { Explorer, PROFILES } from './Explorer';

/** Suited crew member on foot. Simple original figure built from primitives. */
export class Astronaut extends Explorer {
  readonly group = new THREE.Group();
  readonly eye = new THREE.Vector3();
  private readonly legs: THREE.Mesh[] = [];
  private stride = 0;

  constructor(site: SiteData) {
    super(site, PROFILES.astronaut);
    const suit = new THREE.MeshStandardMaterial({ color: '#efe9df', roughness: 0.8 });
    const trim = new THREE.MeshStandardMaterial({ color: '#d2571f', roughness: 0.7 });
    const visor = new THREE.MeshStandardMaterial({ color: '#c79a2c', roughness: 0.15, metalness: 0.9 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.45, 6, 12), suit);
    torso.position.y = 1.18;
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.23, 20, 14), suit);
    helmet.position.y = 1.7;
    const face = new THREE.Mesh(new THREE.SphereGeometry(0.19, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.62), visor);
    face.rotation.x = Math.PI / 2;
    face.position.set(0, 1.71, 0.07);
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.62, 0.22), suit);
    pack.position.set(0, 1.28, -0.3);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.08, 0.24), trim);
    stripe.position.set(0, 1.5, -0.3);
    this.group.add(torso, helmet, face, pack, stripe);
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.5, 4, 8), suit);
      arm.position.set(side * 0.37, 1.15, 0);
      arm.rotation.z = side * 0.12;
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.55, 4, 8), suit);
      leg.geometry.translate(0, -0.38, 0);
      leg.position.set(side * 0.14, 0.86, 0);
      this.legs.push(leg);
      this.group.add(arm, leg);
    }
    this.group.traverse((object) => {
      object.castShadow = true;
    });
  }

  protected readonly turnRate = 1.5;

  protected refresh(dt: number): void {
    this.stride += Math.abs(this.speed) * dt * 1.4;
    const swing = Math.min(1, Math.abs(this.speed) / 3) * 0.6;
    this.legs[0].rotation.x = Math.sin(this.stride) * swing;
    this.legs[1].rotation.x = -Math.sin(this.stride) * swing;
    this.group.position.copy(this.position);
    this.group.rotation.y = this.heading;
    this.eye.set(this.position.x, this.position.y + 1.72, this.position.z);
  }

  override place(x: number, z: number, heading?: number): void {
    super.place(x, z, heading);
    this.group.position.copy(this.position);
    this.group.rotation.y = this.heading;
    this.eye.set(this.position.x, this.position.y + 1.72, this.position.z);
  }
}
