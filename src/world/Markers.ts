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

/** Height of lines above the ground, metres: enough to clear small bumps without floating. */
const LIFT = 0.6;

export interface Mission {
  traverse: { paths: number[][][]; lengthM: number; lastSol: number; credit: string };
  stops: Stop[];
}

type Shape = 'diamond' | 'square' | 'ring' | 'triangle' | 'dot';

/** Sprite heights as a share of the view height: markers keep one small size on screen at any distance. */
const GLYPH_SIZE = 0.017;
const LABEL_SIZE = 0.019;
/** On the ground, names show only for markers this close, metres. */
const LABEL_RANGE = 500;
/** Lines follow the ground at this spacing so hills hide them correctly, metres. */
const LINE_STEP = 3;

function sprite(canvas: HTMLCanvasElement, height: number): THREE.Sprite {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mark = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, sizeAttenuation: false, fog: false, transparent: true }));
  mark.scale.set((canvas.width / canvas.height) * height, height, 1);
  mark.renderOrder = 20;
  return mark;
}

/** A small flat symbol, the same size on screen at any distance. */
function glyph(shape: Shape, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d')!;
  context.translate(32, 32);
  context.lineJoin = 'miter';
  context.beginPath();
  if (shape === 'diamond') {
    context.moveTo(0, -22);
    context.lineTo(22, 0);
    context.lineTo(0, 22);
    context.lineTo(-22, 0);
    context.closePath();
  } else if (shape === 'square') context.rect(-17, -17, 34, 34);
  else if (shape === 'triangle') {
    context.moveTo(0, -22);
    context.lineTo(22, 18);
    context.lineTo(-22, 18);
    context.closePath();
  } else context.arc(0, 0, shape === 'dot' ? 11 : 19, 0, Math.PI * 2);
  // A dark edge keeps the symbol readable on bright ground.
  context.strokeStyle = 'rgba(12, 10, 9, 0.9)';
  context.lineWidth = 14;
  context.stroke();
  if (shape === 'ring' || shape === 'diamond') {
    context.fillStyle = 'rgba(12, 10, 9, 0.55)';
    context.fill();
    context.strokeStyle = color;
    context.lineWidth = 7;
    context.stroke();
  } else {
    context.fillStyle = color;
    context.fill();
  }
  return sprite(canvas, GLYPH_SIZE);
}

/** A plain name beside a glyph: no box, just outlined text. */
function nameTag(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  const font = '500 34px "Mona Sans Variable", system-ui, sans-serif';
  context.font = font;
  canvas.width = Math.ceil(context.measureText(text).width) + 16;
  canvas.height = 56;
  context.font = font;
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  context.strokeStyle = 'rgba(12, 10, 9, 0.92)';
  context.lineWidth = 9;
  context.strokeText(text, 8, 30);
  context.fillStyle = '#eaf0f8';
  context.fillText(text, 8, 30);
  const tag = sprite(canvas, LABEL_SIZE);
  // Sits to the right of the glyph, clear of it.
  tag.center.set(-(GLYPH_SIZE * 0.75) / tag.scale.x, 0.5);
  return tag;
}

/** Lines and markers drawn over the terrain: planned routes, science stops, the mission rover's real path. */
export class Markers {
  readonly group = new THREE.Group();
  /** Switches for the mission rover's path and the walk-back limit lines. */
  showTraverse = true;
  showLimits = true;
  private readonly traverse = new THREE.Group();
  private readonly limits = new THREE.Group();
  private readonly routes = new THREE.Group();
  /** The routes not picked: shown on the map only. */
  private readonly others = new THREE.Group();
  private readonly stops = new THREE.Group();
  private readonly pins = new THREE.Group();
  private readonly lineMaterials: LineMaterial[] = [];
  private readonly destination: THREE.Group;
  private readonly base: THREE.Group;
  private readonly you: THREE.Mesh;
  private mapView: boolean | null = null;

  constructor(private readonly site: SiteData, readonly mission: Mission) {
    this.group.add(this.traverse, this.limits, this.others, this.routes, this.stops, this.pins);
    for (const path of mission.traverse.paths) {
      this.traverse.add(this.line(path.map(([x, z]) => ({ x, z })), () => '#7fd8ff', 1.5, 0.75));
    }
    for (const stop of mission.stops) {
      const mark = this.mark('diamond', '#74c7f4', stop.name);
      mark.position.set(stop.x, this.site.groundAt(stop.x, stop.z) + 2, stop.z);
      this.stops.add(mark);
    }
    // "You are here" arrow for the map view.
    const arrow = new THREE.Shape();
    arrow.moveTo(0, 16);
    arrow.lineTo(10, -11);
    arrow.lineTo(0, -5);
    arrow.lineTo(-10, -11);
    arrow.closePath();
    this.you = new THREE.Mesh(new THREE.ShapeGeometry(arrow), new THREE.MeshBasicMaterial({ color: '#eaf0f8', depthTest: false, fog: false, side: THREE.DoubleSide }));
    this.you.renderOrder = 30;
    this.you.visible = false;
    this.base = this.mark('square', '#eaf0f8', 'Base');
    this.destination = this.mark('ring', '#ffffff');
    this.destination.visible = false;
    this.group.add(this.you, this.base, this.destination);
  }

  resize(width: number, height: number): void {
    for (const material of this.lineMaterials) material.resolution.set(width, height);
  }

  /** Show routes; the selected one is colour-coded by risk, the others thin and grey. */
  showRoutes(routes: Route[], selected: number): void {
    this.clear(this.routes);
    this.clear(this.others);
    routes.forEach((route, index) => {
      if (index !== selected) this.others.add(this.line(route.points, () => '#d8cfc4', 1.5, 0.55));
    });
    const route = routes[selected];
    if (route) this.routes.add(this.line(route.points, (k) => RATING_COLORS[route.ratings[k]], 4));
    const turn = route?.stats.trip.turnBack;
    if (turn) {
      const mark = this.mark('triangle', '#ff5ad6', 'Turn back');
      mark.position.set(turn.x, this.site.groundAt(turn.x, turn.z) + 2, turn.z);
      this.routes.add(mark);
    }
    this.applyView();
  }

  /** Draw limit lines from flat [x1, z1, x2, z2, ...] segment lists. */
  setLimits(rings: { segments: number[]; color: string }[]): void {
    this.clear(this.limits);
    for (const ring of rings) {
      if (!ring.segments.length) continue;
      const positions: number[] = [];
      for (let k = 0; k < ring.segments.length; k += 4) {
        const [x1, z1, x2, z2] = ring.segments.slice(k, k + 4);
        const parts = Math.max(1, Math.ceil(Math.hypot(x2 - x1, z2 - z1) / LINE_STEP));
        for (let p = 0; p < parts; p += 1) {
          for (const t of [p / parts, (p + 1) / parts]) {
            const x = x1 + (x2 - x1) * t;
            const z = z1 + (z2 - z1) * t;
            positions.push(x, this.site.groundAt(x, z) + LIFT, z);
          }
        }
      }
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(positions);
      const material = new LineMaterial({ color: ring.color, linewidth: 1.5, transparent: true, opacity: 0.8 });
      material.resolution.set(window.innerWidth, window.innerHeight);
      this.lineMaterials.push(material);
      const line = new LineSegments2(geometry, material);
      line.renderOrder = 9;
      line.frustumCulled = false;
      this.limits.add(line);
    }
    this.applyView();
  }

  setBase(point: RoutePoint): void {
    this.base.position.set(point.x, this.site.groundAt(point.x, point.z) + 2, point.z);
  }

  setDestination(point: RoutePoint | null): void {
    this.destination.visible = Boolean(point);
    if (point) this.destination.position.set(point.x, this.site.groundAt(point.x, point.z) + 2, point.z);
  }

  /** Dots for the points of a hand-drawn route. */
  setPins(points: RoutePoint[]): void {
    this.clear(this.pins);
    for (const point of points) {
      const pin = this.mark('dot', '#ffe9a8');
      pin.position.set(point.x, this.site.groundAt(point.x, point.z) + 2, point.z);
      this.pins.add(pin);
    }
    this.applyView();
  }

  /** Per frame: the map shows everything on top; on the ground, hills hide what is behind them and names show only nearby. */
  update(camera: THREE.Camera, mapView: boolean, traveller: THREE.Vector3, heading: number): void {
    if (mapView !== this.mapView) {
      this.mapView = mapView;
      this.applyView();
    }
    this.traverse.visible = this.showTraverse && mapView;
    this.limits.visible = this.showLimits;
    this.others.visible = mapView;
    this.you.visible = mapView;
    if (mapView) {
      this.you.position.set(traveller.x, traveller.y + 25, traveller.z);
      // Shape points along +y; lay it flat with the tip toward the heading (+z at heading 0).
      this.you.rotation.set(Math.PI / 2, 0, heading, 'YXZ');
      this.you.scale.setScalar(Math.max(1, (camera.position.y - traveller.y) / 500) * 0.9);
    }
    for (const mark of [...this.stops.children, this.base]) {
      const away = mark.position.distanceTo(camera.position);
      const tag = mark.userData.tag as THREE.Sprite | undefined;
      if (tag) tag.visible = mapView || away < LABEL_RANGE;
    }
    // Standing at the base, the lander itself marks it.
    this.base.visible = mapView || this.base.position.distanceTo(traveller) > 80;
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

  /** Lines and markers are drawn on top in the map view and hidden by terrain and haze on the ground. */
  private applyView(): void {
    const onTop = this.mapView !== false;
    for (const material of this.lineMaterials) {
      if (material.depthTest === !onTop && material.fog === !onTop) continue;
      material.depthTest = !onTop;
      material.fog = !onTop;
      material.needsUpdate = true;
    }
    this.group.traverse((object) => {
      const material = (object as THREE.Sprite).material;
      if ((object as THREE.Sprite).isSprite) (material as THREE.SpriteMaterial).depthTest = !onTop;
    });
  }

  /** A line laid on the ground, resampled so it follows the terrain between its points. */
  private line(points: RoutePoint[], color: (index: number) => string, width: number, opacity = 1): Line2 {
    const positions: number[] = [];
    const colors: number[] = [];
    const tint = new THREE.Color();
    const push = (x: number, z: number) => {
      positions.push(x, this.site.groundAt(x, z) + LIFT, z);
      colors.push(tint.r, tint.g, tint.b);
    };
    points.forEach((point, k) => {
      tint.set(color(k));
      push(point.x, point.z);
      const next = points[k + 1];
      if (!next) return;
      const parts = Math.ceil(Math.hypot(next.x - point.x, next.z - point.z) / LINE_STEP);
      for (let p = 1; p < parts; p += 1) push(point.x + ((next.x - point.x) * p) / parts, point.z + ((next.z - point.z) * p) / parts);
    });
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    geometry.setColors(colors);
    const material = new LineMaterial({ linewidth: width, vertexColors: true, transparent: opacity < 1, opacity });
    material.resolution.set(window.innerWidth, window.innerHeight);
    this.lineMaterials.push(material);
    const line = new Line2(geometry, material);
    line.renderOrder = 10;
    line.frustumCulled = false;
    return line;
  }

  /** A glyph with an optional name beside it. */
  private mark(shape: Shape, color: string, name = ''): THREE.Group {
    const group = new THREE.Group();
    group.add(glyph(shape, color));
    if (name) {
      const tag = nameTag(name);
      group.add(tag);
      group.userData.tag = tag;
    }
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
          (material as THREE.SpriteMaterial).map?.dispose();
          material.dispose();
        }
      });
    }
  }
}
