import * as THREE from 'three';

const DEG = Math.PI / 180;

interface Site {
  name: string;
  lat: number;
  lon: number;
  primary?: boolean;
}

/** Where NASA has landed on Mars. Only Jezero is explorable here. */
const SITES: Site[] = [
  { name: 'Jezero Crater · Perseverance', lat: 18.44, lon: 77.45, primary: true },
  { name: 'Gale Crater · Curiosity', lat: -4.59, lon: 137.44 },
  { name: 'Elysium Planitia · InSight', lat: 4.5, lon: 135.62 },
  { name: 'Gusev Crater · Spirit', lat: -14.57, lon: 175.47 },
  { name: 'Meridiani Planum · Opportunity', lat: -1.95, lon: -5.53 },
  { name: 'Chryse Planitia · Viking 1', lat: 22.27, lon: -47.95 },
  { name: 'Ares Vallis · Pathfinder', lat: 19.13, lon: -33.22 },
  { name: 'Utopia Planitia · Viking 2', lat: 47.64, lon: 134.29 },
  { name: 'Vastitas Borealis · Phoenix', lat: 68.22, lon: -125.75 },
];

/** Unit vector for planetocentric latitude / east longitude on a sphere textured with lon -180..180. */
function direction(lat: number, lon: number, target = new THREE.Vector3()): THREE.Vector3 {
  const phi = (lon + 180) * DEG;
  const cos = Math.cos(lat * DEG);
  return target.set(-Math.cos(phi) * cos, Math.sin(lat * DEG), Math.sin(phi) * cos);
}

function label(text: string, primary: boolean): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  const font = `${primary ? 700 : 500} 40px system-ui, sans-serif`;
  context.font = font;
  canvas.width = Math.ceil(context.measureText(text).width) + 40;
  canvas.height = 64;
  context.font = font;
  context.fillStyle = primary ? 'rgba(255, 138, 61, 0.95)' : 'rgba(20, 12, 8, 0.7)';
  context.beginPath();
  context.roundRect(0, 0, canvas.width, canvas.height, 16);
  context.fill();
  context.fillStyle = primary ? '#1d0f06' : '#f1e3d2';
  context.textBaseline = 'middle';
  context.fillText(text, 20, 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, sizeAttenuation: false }));
  const height = primary ? 0.036 : 0.024;
  sprite.scale.set((canvas.width / canvas.height) * height, height, 1);
  sprite.center.set(0.5, -0.6);
  return sprite;
}

/** Intro view: Mars from orbit with NASA's landing sites, then a dive to Jezero. */
export class Globe {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  private readonly labels: { sprite: THREE.Sprite; normal: THREE.Vector3 }[] = [];
  private readonly pulse: THREE.Mesh;
  private readonly target = direction(SITES[0].lat, SITES[0].lon);
  private readonly view = new THREE.Vector3();
  private readonly disposables: { dispose(): void }[] = [];
  private longitude = SITES[0].lon - 38;
  private latitude = 14;
  private distance = 3.3;
  private dive = -1;
  private time = 0;
  private last = performance.now();

  constructor(baseUrl: string) {
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

    const sun = new THREE.DirectionalLight('#fff1e0', 3.2);
    sun.position.copy(direction(12, SITES[0].lon - 55)).multiplyScalar(10);
    this.scene.add(sun, new THREE.AmbientLight('#6b5a66', 0.5));

    const dotGeometry = new THREE.SphereGeometry(1, 12, 8);
    for (const site of SITES) {
      const normal = direction(site.lat, site.lon);
      const dot = new THREE.Mesh(dotGeometry, new THREE.MeshBasicMaterial({ color: site.primary ? '#ff8a3d' : '#f1e3d2' }));
      dot.scale.setScalar(site.primary ? 0.012 : 0.006);
      dot.position.copy(normal).multiplyScalar(1.004);
      const sprite = label(site.name, Boolean(site.primary));
      sprite.position.copy(normal).multiplyScalar(1.01);
      this.scene.add(dot, sprite);
      this.labels.push({ sprite, normal });
      this.disposables.push(dot.material as THREE.Material, sprite.material, sprite.material.map as THREE.Texture);
    }
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
    if (this.dive < 0) this.dive = 0;
  }

  drag(dx: number, dy: number): void {
    if (this.diving) return;
    this.longitude -= dx * 0.25;
    this.latitude = THREE.MathUtils.clamp(this.latitude + dy * 0.2, -70, 70);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    // Keep the whole planet in view on tall screens.
    this.distance = aspect < 1 ? 3.3 / Math.max(aspect, 0.45) : 3.3;
    this.camera.updateProjectionMatrix();
  }

  update(): void {
    // Wall-clock time, so the dive lasts the same on slow machines.
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    let distance = this.distance;
    if (this.diving) {
      this.dive += dt;
      const t = this.progress;
      const ease = t * t * (3 - 2 * t);
      // Swing over Jezero, then fall toward it.
      const lon = SITES[0].lon;
      this.longitude += (lon - this.longitude) * Math.min(1, 4 * dt + ease);
      this.latitude += (SITES[0].lat - this.latitude) * Math.min(1, 4 * dt + ease);
      distance = this.distance + (1.012 - this.distance) * Math.pow(ease, 1.6);
    } else {
      this.longitude += dt * 1.6;
    }
    direction(this.latitude, this.longitude, this.view);
    this.camera.position.copy(this.view).multiplyScalar(distance);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);

    const wave = (this.time * 0.8) % 1;
    this.pulse.scale.setScalar(1 + wave * 2.2);
    (this.pulse.material as THREE.MeshBasicMaterial).opacity = 1 - wave;
    // Hide names on the far side and when diving.
    for (const { sprite, normal } of this.labels) sprite.visible = !this.diving && normal.dot(this.view) > 0.25;
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
  }
}
