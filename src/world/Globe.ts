import * as THREE from 'three';

const DEG = Math.PI / 180;

export interface GlobeSite {
  name: string;
  lat: number;
  lon: number;
  /** Landing year and what the mission was. */
  mission: string;
  /** Why a crew would care about this place. */
  note: string;
  /** True when this build has walkable terrain for the site. */
  primary?: boolean;
}

/** Where NASA has landed on Mars. Only Jezero has walkable terrain in this build. */
export const SITES: GlobeSite[] = [
  { name: 'Jezero Crater · Perseverance', lat: 18.44, lon: 77.45, primary: true, mission: 'Rover, landed 2021', note: 'An ancient river delta and lake bed. Perseverance collects rock samples here to look for signs of past life.' },
  { name: 'Gale Crater · Curiosity', lat: -4.59, lon: 137.44, mission: 'Rover, landed 2012', note: 'A lake bed at the foot of Mount Sharp. Curiosity made the first radiation measurements on the surface of Mars here.' },
  { name: 'Elysium Planitia · InSight', lat: 4.5, lon: 135.62, mission: 'Lander, 2018 to 2022', note: 'A flat lava plain. InSight recorded marsquakes and daily weather here.' },
  { name: 'Gusev Crater · Spirit', lat: -14.57, lon: 175.47, mission: 'Rover, 2004 to 2010', note: 'Spirit found silica left by hot springs in the Columbia Hills.' },
  { name: 'Meridiani Planum · Opportunity', lat: -1.95, lon: -5.53, mission: 'Rover, 2004 to 2018', note: 'Opportunity drove 45 km here and found minerals that form in water. A global dust storm ended the mission.' },
  { name: 'Chryse Planitia · Viking 1', lat: 22.27, lon: -47.95, mission: 'Lander, 1976 to 1982', note: 'The first long-lived lander on Mars. It took the first surface weather record.' },
  { name: 'Ares Vallis · Pathfinder', lat: 19.13, lon: -33.22, mission: 'Lander and Sojourner rover, 1997', note: 'A rocky flood plain. Sojourner was the first rover on Mars.' },
  { name: 'Utopia Planitia · Viking 2', lat: 47.64, lon: 134.29, mission: 'Lander, 1976 to 1980', note: 'A northern plain where Viking 2 saw frost on the ground in winter.' },
  { name: 'Vastitas Borealis · Phoenix', lat: 68.22, lon: -125.75, mission: 'Lander, 2008', note: 'Arctic plain. Phoenix dug up water ice just under the soil.' },
];

/** Unit vector for planetocentric latitude / east longitude on a sphere textured with lon -180..180. */
function direction(lat: number, lon: number, target = new THREE.Vector3()): THREE.Vector3 {
  const phi = (lon + 180) * DEG;
  const cos = Math.cos(lat * DEG);
  return target.set(-Math.cos(phi) * cos, Math.sin(lat * DEG), Math.sin(phi) * cos);
}

function labelTexture(text: string, marked: boolean): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  const font = `${marked ? 700 : 500} 40px system-ui, sans-serif`;
  context.font = font;
  canvas.width = Math.ceil(context.measureText(text).width) + 40;
  canvas.height = 64;
  context.font = font;
  context.fillStyle = marked ? 'rgba(255, 138, 61, 0.95)' : 'rgba(20, 12, 8, 0.7)';
  context.beginPath();
  context.roundRect(0, 0, canvas.width, canvas.height, 16);
  context.fill();
  context.fillStyle = marked ? '#1d0f06' : '#f1e3d2';
  context.textBaseline = 'middle';
  context.fillText(text, 20, 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A site name in its plain and its selected look. */
function label(text: string): { sprite: THREE.Sprite; plain: THREE.CanvasTexture; marked: THREE.CanvasTexture } {
  const plain = labelTexture(text, false);
  const marked = labelTexture(text, true);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: plain, depthTest: false, sizeAttenuation: false }));
  sprite.center.set(0.5, -0.6);
  return { sprite, plain, marked };
}

/** Mars from orbit with NASA's landing sites. Opens the app, and is where zooming out of the map leads; ends with a dive to Jezero. */
export class Globe {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  private readonly labels: { sprite: THREE.Sprite; plain: THREE.CanvasTexture; marked: THREE.CanvasTexture; normal: THREE.Vector3; site: GlobeSite }[] = [];
  private readonly projected = new THREE.Vector3();
  /** Seconds since leaving the surface, or -1 when the globe opened the app. */
  private rise = -1;
  private zoomFactor = 1;
  private spinning = true;
  private selected: GlobeSite = SITES[0];
  private width = 1;
  private height = 1;
  private readonly pulse: THREE.Mesh;
  private readonly target = direction(SITES[0].lat, SITES[0].lon);
  private readonly view = new THREE.Vector3();
  private readonly disposables: { dispose(): void }[] = [];
  private longitude = SITES[0].lon - 38;
  private latitude = 14;
  private distance = 3.3;
  private dive = -1;
  private readonly sun = new THREE.DirectionalLight('#fff1e0', 3.2);
  private swing = false;
  private time = 0;
  private last = performance.now();

  constructor(baseUrl: string, private readonly fromSurface = false) {
    if (fromSurface) {
      this.rise = 0;
      this.spinning = false;
      this.longitude = SITES[0].lon;
      this.latitude = SITES[0].lat;
    }
    this.scene.background = new THREE.Color('#05030a');
    const loader = new THREE.TextureLoader();
    const color = loader.load(`${baseUrl}color.jpg`);
    color.colorSpace = THREE.SRGBColorSpace;
    color.anisotropy = 8;
    const relief = loader.load(`${baseUrl}relief.jpg`);
    const material = new THREE.MeshStandardMaterial({ map: color, bumpMap: relief, bumpScale: 2.5, roughness: 1, metalness: 0 });
    const planet = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), material);
    this.scene.add(planet);

    // Thin dusty atmosphere seen edge-on.
    const haze = new THREE.Mesh(
      new THREE.SphereGeometry(1.035, 96, 48),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: 'varying vec3 vNormal; varying vec3 vView; void main() { vNormal = normalize(normalMatrix * normal); vec4 p = modelViewMatrix * vec4(position, 1.0); vView = normalize(-p.xyz); gl_Position = projectionMatrix * p; }',
        fragmentShader: 'varying vec3 vNormal; varying vec3 vView; void main() { float rim = pow(1.0 - abs(dot(vNormal, vView)), 2.2); gl_FragColor = vec4(vec3(0.95, 0.55, 0.32) * rim * 0.9, rim); }',
      }),
    );
    this.scene.add(haze);

    const stars = new Float32Array(1800 * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < 1800; i += 1) {
      // Fixed pattern: golden-angle spiral over the sphere.
      const y = 1 - (2 * (i + 0.5)) / 1800;
      const r = Math.sqrt(1 - y * y);
      const a = i * 2.39996323;
      v.set(Math.cos(a) * r, y, Math.sin(a) * r).multiplyScalar(40 + (i % 7));
      stars.set([v.x, v.y, v.z], i * 3);
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(stars, 3));
    const starMaterial = new THREE.PointsMaterial({ color: '#d9d2ff', size: 1.6, sizeAttenuation: false });
    this.scene.add(new THREE.Points(starGeometry, starMaterial));

    this.sun.position.copy(direction(12, SITES[0].lon - 55)).multiplyScalar(10);
    this.scene.add(this.sun, new THREE.AmbientLight('#6b5a66', 0.5));

    const dotGeometry = new THREE.SphereGeometry(1, 12, 8);
    for (const site of SITES) {
      const normal = direction(site.lat, site.lon);
      const dot = new THREE.Mesh(dotGeometry, new THREE.MeshBasicMaterial({ color: site.primary ? '#ff8a3d' : '#f1e3d2' }));
      dot.scale.setScalar(site.primary ? 0.012 : 0.006);
      dot.position.copy(normal).multiplyScalar(1.004);
      const { sprite, plain, marked } = label(site.name);
      sprite.position.copy(normal).multiplyScalar(1.01);
      this.scene.add(dot, sprite);
      this.labels.push({ sprite, plain, marked, normal, site });
      this.disposables.push(dot.material as THREE.Material, sprite.material, plain, marked);
    }
    this.markLabels();
    this.pulse = new THREE.Mesh(
      new THREE.RingGeometry(0.02, 0.026, 48),
      new THREE.MeshBasicMaterial({ color: '#ff8a3d', transparent: true, side: THREE.DoubleSide, depthTest: false }),
    );
    this.pulse.position.copy(this.target).multiplyScalar(1.006);
    this.pulse.lookAt(this.target.clone().multiplyScalar(2));
    this.scene.add(this.pulse);
    this.disposables.push(color, relief, material, planet.geometry, haze.geometry, haze.material as THREE.Material, starGeometry, starMaterial, dotGeometry, this.pulse.geometry, this.pulse.material as THREE.Material);
  }

  get diving(): boolean {
    return this.dive >= 0;
  }

  /** 0..1 while flying down to Jezero; 1 means the surface should take over. */
  get progress(): number {
    return this.dive < 0 ? 0 : Math.min(1, this.dive / 2.6);
  }

  startDive(): void {
    if (this.dive >= 0) return;
    this.dive = 0;
    this.rise = -1;
    this.select(SITES[0]);
  }

  /** 0..1 while lifting off the surface into orbit. */
  get rising(): number {
    return this.rise < 0 ? 1 : Math.min(1, this.rise / 1.8);
  }

  drag(dx: number, dy: number): void {
    if (this.diving) return;
    this.spinning = false;
    this.swing = false;
    this.longitude -= dx * 0.25 * this.zoomFactor;
    this.latitude = THREE.MathUtils.clamp(this.latitude + dy * 0.2 * this.zoomFactor, -80, 80);
  }

  /** Wheel or pinch. Returns true when the user keeps zooming in past the closest view. */
  zoom(factor: number): boolean {
    if (this.diving) return false;
    const wanted = this.zoomFactor * factor;
    this.zoomFactor = THREE.MathUtils.clamp(wanted, 0.5, 1.5);
    return wanted < 0.42;
  }

  /** The landing site under a click, if any. Site dots are small, so the nearest within 30 px counts. */
  pick(clientX: number, clientY: number): GlobeSite | null {
    let best: GlobeSite | null = null;
    let bestDistance = 30;
    for (const { normal, site } of this.labels) {
      if (normal.dot(this.view) < 0.2) continue;
      this.projected.copy(normal).project(this.camera);
      const distance = Math.hypot((this.projected.x + 1) * 0.5 * this.width - clientX, (1 - this.projected.y) * 0.5 * this.height - clientY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = site;
      }
    }
    return best;
  }

  /** Turn the globe to face a site and mark it. */
  select(site: GlobeSite): void {
    this.selected = site;
    this.markLabels();
    this.spinning = false;
    this.swing = true;
    direction(site.lat, site.lon, this.target);
    this.pulse.position.copy(this.target).multiplyScalar(1.006);
    this.pulse.lookAt(this.target.clone().multiplyScalar(2));
  }

  get site(): GlobeSite {
    return this.selected;
  }

  /** The selected site's name is larger and orange; the rest are plain. */
  private markLabels(): void {
    for (const { sprite, plain, marked, site } of this.labels) {
      const on = site === this.selected;
      const texture = on ? marked : plain;
      const height = on ? 0.034 : 0.024;
      sprite.material.map = texture;
      sprite.scale.set((texture.image.width / texture.image.height) * height, height, 1);
      sprite.renderOrder = on ? 2 : 1;
    }
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const aspect = width / height;
    this.camera.aspect = aspect;
    // Keep the whole planet in view on tall screens.
    this.distance = aspect < 1 ? 3.3 / Math.max(aspect, 0.45) : 3.3;
    // On wide screens push the planet to the right, clear of the title.
    // Coming up from the surface, the site list is on the right, so push it left instead.
    if (aspect > 1.2) this.camera.setViewOffset(width, height, this.fromSurface ? width * 0.11 : -width * 0.2, 0, width, height);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  update(): void {
    // Wall-clock time, so the dive lasts the same on slow machines.
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    let distance = Math.max(1.45, this.distance * this.zoomFactor);
    if (this.rise >= 0 && !this.diving) {
      this.rise += dt;
      const t = this.rising;
      const ease = 1 - Math.pow(1 - t, 3);
      distance = 1.012 + (distance - 1.012) * ease;
      if (t >= 1) this.rise = -1;
    }
    if (this.swing && !this.diving) {
      // Shortest way round to the chosen site.
      const turn = ((this.selected.lon - this.longitude + 540) % 360) - 180;
      this.longitude += turn * Math.min(1, 3 * dt);
      this.latitude += (THREE.MathUtils.clamp(this.selected.lat, -80, 80) - this.latitude) * Math.min(1, 3 * dt);
      if (Math.abs(turn) < 0.2) this.swing = false;
    }
    if (this.diving) {
      this.dive += dt;
      const t = this.progress;
      const ease = t * t * (3 - 2 * t);
      // Swing over Jezero, then fall toward it.
      const turn = ((SITES[0].lon - this.longitude + 540) % 360) - 180;
      this.longitude += turn * Math.min(1, 4 * dt + ease);
      this.latitude += (SITES[0].lat - this.latitude) * Math.min(1, 4 * dt + ease);
      distance += (1.012 - distance) * Math.pow(ease, 1.6);
    } else if (this.spinning) {
      this.longitude += dt * 1.6;
    }
    direction(this.latitude, this.longitude, this.view);
    this.camera.position.copy(this.view).multiplyScalar(distance);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    // When browsing sites, keep the side being looked at in daylight.
    if (this.fromSurface) direction(this.latitude * 0.6 + 8, this.longitude - 40, this.sun.position).multiplyScalar(10);

    const wave = (this.time * 0.8) % 1;
    this.pulse.scale.setScalar(1 + wave * 2.2);
    (this.pulse.material as THREE.MeshBasicMaterial).opacity = 1 - wave;
    // Hide names on the far side, near the rim where they would run off screen, and when diving.
    for (const { sprite, normal } of this.labels) sprite.visible = !this.diving && normal.dot(this.view) > 0.42;
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
  }
}
