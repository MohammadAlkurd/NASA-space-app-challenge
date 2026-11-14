import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { Rating, Route, RoutePoint } from '../planning/Router';
import type { SiteData } from './SiteData';

export const RATING_COLORS: Record<Rating, string> = {
  SAFE: '#3ddc84',
  'BE CAREFUL': '#ffd23f',
  DANGER: '#ff8a2b',
  'NO-GO': '#ff3b3b',
};

export interface Stop {
  id: string;
  name: string;
  kind: string;
  why: string;
  sol: number;
  x: number;
  z: number;
  lat: number;
  lon: number;
  elev: number;
  photo?: { file: string; title: string; caption: string; credit: string; link: string; sol: number } | null;
}

export interface Mission {
  traverse: { paths: number[][][]; lengthM: number; lastSol: number; credit: string };
  stops: Stop[];
}

function labelSprite(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  const font = '600 44px system-ui, sans-serif';
  context.font = font;
  canvas.width = Math.ceil(context.measureText(text).width) + 56;
  canvas.height = 76;
  context.font = font;
  context.fillStyle = 'rgba(20, 12, 8, 0.82)';
  context.beginPath();
  context.roundRect(0, 0, canvas.width, canvas.height, 18);
  context.fill();
  context.strokeStyle = color;
  context.lineWidth = 4;
  context.stroke();
  context.fillStyle = '#fff6ea';
  context.textBaseline = 'middle';
  context.fillText(text, 28, 40);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, sizeAttenuation: false, fog: false }));
  sprite.scale.set((canvas.width / canvas.height) * 0.03, 0.03, 1);
  sprite.renderOrder = 20;
  return sprite;
}

/** Lines and beacons drawn over the terrain: planned routes, science stops, Perseverance's real path. */
export class Markers {
  readonly group = new THREE.Group();
  readonly traverse = new THREE.Group();
  /** Walk-back limit rings around the shelters. */
  readonly limits = new THREE.Group();
  private readonly routes = new THREE.Group();
  private readonly stops = new THREE.Group();
  private readonly pins = new THREE.Group();
  private readonly lineMaterials: LineMaterial[] = [];
  private readonly destination: THREE.Group;
  private readonly base = new THREE.Group();
  private readonly you: THREE.Mesh;

  constructor(private readonly site: SiteData, readonly mission: Mission) {
    this.group.add(this.traverse, this.limits, this.routes, this.stops, this.pins);
    for (const path of mission.traverse.paths) {
      this.traverse.add(this.line(path.map(([x, z]) => ({ x, z })), () => '#7fd8ff', 2.5, 0.9));
    }
    for (const stop of mission.stops) this.stops.add(this.beacon(stop));
    // "You are here" arrow for the map view.
    const arrow = new THREE.Shape();
    arrow.moveTo(0, 16);
    arrow.lineTo(10, -11);
    arrow.lineTo(0, -5);
    arrow.lineTo(-10, -11);
    arrow.closePath();
    this.you = new THREE.Mesh(new THREE.ShapeGeometry(arrow), new THREE.MeshBasicMaterial({ color: '#ff8a3d', depthTest: false, fog: false, side: THREE.DoubleSide }));
    this.you.renderOrder = 30;
    this.you.visible = false;
    this.group.add(this.you);
    const baseLabel = labelSprite('BASE', '#f0a23b');
    baseLabel.position.y = 30;
    this.base.add(this.pin('#f0a23b', 1.2), baseLabel);
    this.base.userData.label = baseLabel;
    this.base.userData.labelSize = baseLabel.scale.clone();
    this.group.add(this.base);
    this.destination = this.pin('#ffffff');
    this.destination.visible = false;
    this.group.add(this.destination);
  }

  resize(width: number, height: number): void {
    for (const material of this.lineMaterials) material.resolution.set(width, height);
  }

  /** Show routes; the selected one is drawn thick and colour-coded by risk, the others thin and grey. */
  showRoutes(routes: Route[], selected: number): void {
    this.clear(this.routes);
    routes.forEach((route, index) => {
      if (index === selected) return;
      this.routes.add(this.line(route.points, () => '#d8cfc4', 2.5, 1.2, 0.6));
    });
    const route = routes[selected];
    if (route) this.routes.add(this.line(route.points, (k) => RATING_COLORS[route.ratings[k]], 6, 1.6));
    const turn = route?.stats.trip.turnBack;
    if (turn) {
      const mark = this.pin('#ff5ad6', 0.8);
      const label = labelSprite('TURN BACK', '#ff5ad6');
      label.position.y = 30;
      mark.add(label);
      mark.position.set(turn.x, this.site.groundAt(turn.x, turn.z), turn.z);
      this.routes.add(mark);
    }
  }

  /** Draw limit rings from flat [x1, z1, x2, z2, ...] segment lists. */
  setLimits(rings: { segments: number[]; color: string }[]): void {
    this.clear(this.limits);
    for (const ring of rings) {
      if (!ring.segments.length) continue;
      const positions: number[] = [];
      for (let k = 0; k < ring.segments.length; k += 2) {
        const x = ring.segments[k];
        const z = ring.segments[k + 1];
        positions.push(x, this.site.groundAt(x, z) + 1.4, z);
      }
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(positions);
      const material = new LineMaterial({ color: ring.color, linewidth: 2.5, transparent: true, opacity: 0.85, depthTest: false, fog: false });
      material.resolution.set(window.innerWidth, window.innerHeight);
      this.lineMaterials.push(material);
      const line = new LineSegments2(geometry, material);
      line.renderOrder = 9;
      line.frustumCulled = false;
      this.limits.add(line);
    }
  }

  setBase(point: RoutePoint): void {
    this.base.position.set(point.x, this.site.groundAt(point.x, point.z), point.z);
  }

  setDestination(point: RoutePoint | null): void {
    this.destination.visible = Boolean(point);
    if (point) this.destination.position.set(point.x, this.site.groundAt(point.x, point.z), point.z);
  }

  /** Numbered pins for a hand-drawn route. */
  setPins(points: RoutePoint[]): void {
    this.clear(this.pins);
    for (const point of points) {
      const pin = this.pin('#ffe9a8', 0.6);
      pin.position.set(point.x, this.site.groundAt(point.x, point.z), point.z);
      this.pins.add(pin);
    }
  }

  /** Scale beacons so they stay readable from the map view. */
  update(camera: THREE.Camera, mapView: boolean, traveller: THREE.Vector3, heading: number): void {
    const scale = mapView ? Math.max(1, (camera.position.y - traveller.y) / 500) : 1;
    this.you.visible = mapView;
    if (mapView) {
      this.you.position.set(traveller.x, traveller.y + 25, traveller.z);
      // Shape points along +y; lay it flat with the tip toward the heading (+z at heading 0).
      this.you.rotation.set(Math.PI / 2, 0, heading, 'YXZ');
      this.you.scale.setScalar(scale * 1.6);
    }
    for (const beacon of this.stops.children) {
      beacon.scale.setScalar(scale);
      // Labels are sized in screen space already; undo the beacon scale.
      const size = beacon.userData.labelSize as THREE.Vector3;
      (beacon.userData.label as THREE.Sprite).scale.copy(size).divideScalar(scale);
      // On the ground, far-away names pile up on the horizon: show only the ones within reach.
      const label = beacon.userData.label as THREE.Sprite;
      label.visible = mapView || beacon.position.distanceTo(camera.position) < 1300;
    }
    this.destination.scale.setScalar(scale);
    this.base.scale.setScalar(scale);
    (this.base.userData.label as THREE.Sprite).scale.copy(this.base.userData.labelSize as THREE.Vector3).divideScalar(scale);
    for (const pin of this.pins.children) pin.scale.setScalar(scale);
  }

  nearestStop(x: number, z: number, radius: number): Stop | null {
    let best: Stop | null = null;
    let bestDistance = radius;
    for (const stop of this.mission.stops) {
      const distance = Math.hypot(stop.x - x, stop.z - z);
      if (distance < bestDistance) {
        best = stop;
        bestDistance = distance;
      }
    }
    return best;
  }

  private line(points: RoutePoint[], color: (index: number) => string, width: number, lift: number, opacity = 1): Line2 {
    const positions: number[] = [];
    const colors: number[] = [];
    const tint = new THREE.Color();
    points.forEach((point, k) => {
      positions.push(point.x, this.site.groundAt(point.x, point.z) + lift, point.z);
      tint.set(color(k));
      colors.push(tint.r, tint.g, tint.b);
    });
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    geometry.setColors(colors);
    const material = new LineMaterial({ linewidth: width, vertexColors: true, transparent: opacity < 1, opacity, depthTest: false, fog: false });
    material.resolution.set(window.innerWidth, window.innerHeight);
    this.lineMaterials.push(material);
    const line = new Line2(geometry, material);
    line.renderOrder = 10;
    line.frustumCulled = false;
    return line;
  }

  private beacon(stop: Stop): THREE.Group {
    const group = new THREE.Group();
    const color = '#59e0ff';
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 60, 8, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, depthWrite: false, fog: false, side: THREE.DoubleSide }),
    );
    beam.position.y = 30;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(5.5, 6, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthTest: false, fog: false, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.6;
    ring.renderOrder = 9;
    const label = labelSprite(stop.name, color);
    label.position.y = 66;
    group.add(beam, ring, label);
    group.position.set(stop.x, this.site.groundAt(stop.x, stop.z), stop.z);
    group.userData.stop = stop;
    group.userData.label = label;
    group.userData.labelSize = label.scale.clone();
    return group;
  }

  private pin(color: string, size = 1): THREE.Group {
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color, depthTest: false, fog: false });
    const head = new THREE.Mesh(new THREE.SphereGeometry(3 * size, 16, 12), material);
    head.position.y = 16 * size;
    const stem = new THREE.Mesh(new THREE.ConeGeometry(2.2 * size, 14 * size, 12), material);
    stem.rotation.x = Math.PI;
    stem.position.y = 7 * size;
    head.renderOrder = 15;
    stem.renderOrder = 15;
    group.add(head, stem);
    return group;
  }

  private clear(group: THREE.Group): void {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | undefined;
        if (material) {
          const index = this.lineMaterials.indexOf(material as LineMaterial);
          if (index >= 0) this.lineMaterials.splice(index, 1);
          material.dispose();
        }
      });
    }
  }
}
