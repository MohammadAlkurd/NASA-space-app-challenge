import * as THREE from 'three';
import { devilShape } from '../data/Events';
import { DUST_COLOR } from './Sky';
import type { SiteData } from './SiteData';

const GRAINS = 5200;
const PUFFS = 70;
const DEVILS = 3;
const DEVIL_POINTS = 420;
const DEVIL_HEIGHT = 110;

/**
 * Weather you can see: wind-blown dust around the camera, drifting dust banks in a storm, and dust
 * devils on gusty afternoons. It is drawn from the wind speed and dust level, not simulated.
 */
export class Weather {
  readonly group = new THREE.Group();
  private readonly dust: THREE.Points;
  private readonly devils: THREE.Points;
  private readonly dustMaterial: THREE.ShaderMaterial;
  private readonly devilMaterial: THREE.ShaderMaterial;
  private readonly drift = new THREE.Vector3();
  private readonly bases = Array.from({ length: DEVILS }, () => new THREE.Vector3(0, -1e5, 0));
  private readonly color = new THREE.Color();
  private readonly ahead = new THREE.Vector3();
  private devilLevel = 0;
  /** Seconds left of a dust devil passing close to the crew. */
  private passing = 0;
  private time = 0;

  constructor(private readonly site: SiteData) {
    const seeds = new Float32Array((GRAINS + PUFFS) * 3);
    const sizes = new Float32Array(GRAINS + PUFFS);
    for (let i = 0; i < GRAINS + PUFFS; i += 1) {
      seeds.set([Math.random(), Math.random(), Math.random()], i * 3);
      // The first points are large soft banks of dust, the rest are grains.
      sizes[i] = i < PUFFS ? 12 + 16 * Math.random() : 0.5 + Math.random();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    this.dustMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: {
        uCenter: { value: new THREE.Vector3() },
        uDrift: { value: this.drift },
        uBox: { value: new THREE.Vector3(70, 22, 70) },
        uScale: { value: 1 },
        uGrain: { value: 0.16 },
        uStreak: { value: 0 },
        uPixels: { value: 900 },
        uOpacity: { value: 0 },
        uColor: { value: this.color },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        uniform vec3 uCenter;
        uniform vec3 uDrift;
        uniform vec3 uBox;
        uniform float uScale;
        uniform float uGrain;
        uniform float uPixels;
        varying float vAlpha;
        varying float vBank;
        void main() {
          // Each point keeps its place in the world and wraps round a box that follows the camera.
          vec3 local = fract((position * uBox + uDrift - uCenter) / uBox) - 0.5;
          vec4 view = viewMatrix * vec4(uCenter + local * uBox, 1.0);
          float edge = 1.0 - smoothstep(0.36, 0.5, max(abs(local.x), abs(local.z)));
          float near = smoothstep(0.02, 0.09, -view.z / uBox.x);
          vBank = step(4.0, aSize);
          vAlpha = edge * near * mix(1.0, 0.22, vBank);
          // Banks are metres across; grains are drawn as short streaks a few centimetres thick.
          float metres = mix(aSize * uGrain, aSize, vBank) * uScale;
          gl_PointSize = clamp(metres * uPixels / max(-view.z, 0.1), 2.0, 220.0);
          gl_Position = projectionMatrix * view;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uStreak;
        varying float vAlpha;
        varying float vBank;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          // In strong wind a grain smears into a streak along the wind.
          p.y *= 1.0 + 5.0 * uStreak * (1.0 - vBank);
          float soft = smoothstep(0.5, 0.05, length(p));
          gl_FragColor = vec4(uColor, soft * vAlpha * uOpacity);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.dust = new THREE.Points(geometry, this.dustMaterial);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 3;

    const devilData = new Float32Array(DEVILS * DEVIL_POINTS * 3);
    const devilIndex = new Float32Array(DEVILS * DEVIL_POINTS);
    for (let i = 0; i < DEVILS * DEVIL_POINTS; i += 1) {
      // x: height up the column, y: place round it, z: spread.
      devilData.set([Math.pow(Math.random(), 1.4), Math.random(), Math.random()], i * 3);
      devilIndex[i] = Math.floor(i / DEVIL_POINTS);
    }
    const devilGeometry = new THREE.BufferGeometry();
    devilGeometry.setAttribute('position', new THREE.BufferAttribute(devilData, 3));
    devilGeometry.setAttribute('aDevil', new THREE.BufferAttribute(devilIndex, 1));
    this.devilMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: {
        uBase: { value: this.bases },
        uTime: { value: 0 },
        uPixels: { value: 900 },
        uOpacity: { value: 0 },
        uColor: { value: this.color },
      },
      vertexShader: /* glsl */ `
        attribute float aDevil;
        uniform vec3 uBase[${DEVILS}];
        uniform float uTime;
        uniform float uPixels;
        varying float vAlpha;
        void main() {
          float h = position.x;
          vec3 base = uBase[int(aDevil + 0.5)];
          float radius = (1.5 + 13.0 * pow(h, 1.5)) * (0.55 + 0.9 * position.z);
          float angle = position.y * 6.2832 + uTime * (3.2 - 2.0 * h) + aDevil * 2.1;
          float lean = sin(uTime * 0.6 + aDevil * 1.7 + h * 2.5) * 9.0 * h;
          vec3 world = base + vec3(cos(angle) * radius + lean, h * ${DEVIL_HEIGHT.toFixed(1)}, sin(angle) * radius);
          vec4 view = viewMatrix * vec4(world, 1.0);
          // A near one is spread over more of the screen, so each grain is drawn denser to keep the column readable.
          vAlpha = (1.0 - 0.75 * h) * smoothstep(0.0, 0.04, h) * (1.0 + 2.0 * smoothstep(400.0, 120.0, -view.z));
          gl_PointSize = clamp((2.5 + 6.0 * h) * uPixels / max(-view.z, 1.0), 1.5, 90.0);
          gl_Position = projectionMatrix * view;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vAlpha;
        void main() {
          float soft = smoothstep(0.5, 0.05, length(gl_PointCoord - 0.5));
          gl_FragColor = vec4(uColor, soft * vAlpha * uOpacity * 0.28);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.devils = new THREE.Points(devilGeometry, this.devilMaterial);
    this.devils.frustumCulled = false;
    this.devils.renderOrder = 2;
    this.group.add(this.devils, this.dust);
  }

  /** True while dust devils are on the plain. */
  get devilsActive(): boolean {
    return this.devilLevel > 0.5;
  }

  /**
   * @param storm 0 on a clear sol, 1 in a full dust storm.
   * @param mapHeight camera height when looking straight down at the map, otherwise 0.
   */
  update(dt: number, camera: THREE.PerspectiveCamera, traveller: THREE.Vector3, windMs: number, windFromDeg: number | null, hour: number, storm: number, daylight: number, viewportHeight: number, mapHeight: number): void {
    this.time += dt;
    // Dust moves downwind of the measured direction. Without one, the wind blows from the west and veers slowly.
    const bearing = windFromDeg === null ? 1.45 + 0.35 * Math.sin(this.time * 0.04) : THREE.MathUtils.degToRad(windFromDeg + 180);
    const windX = Math.sin(bearing);
    const windZ = -Math.cos(bearing) * (windFromDeg === null ? 0.4 : 1);
    const gust = 1 + 0.25 * Math.sin(this.time * 0.9);
    this.drift.x += windX * windMs * gust * dt;
    this.drift.z += windZ * windMs * gust * dt;
    this.drift.y += Math.sin(this.time * 0.5) * 0.4 * dt;
    // Blowing sand catches the light, so it reads brighter than the murk behind it.
    this.color.copy(DUST_COLOR).multiplyScalar((0.25 + 0.75 * daylight) * (1 - 0.12 * storm));

    const pixels = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const uniforms = this.dustMaterial.uniforms;
    uniforms.uPixels.value = pixels;
    uniforms.uStreak.value = Math.min(1, windMs / 18);
    // Faster wind smears each grain into a longer streak.
    uniforms.uGrain.value = 0.16 + 0.3 * storm;
    if (mapHeight > 0) {
      // From above, the storm is banks of dust sliding over the map.
      const span = mapHeight * 1.9;
      uniforms.uBox.value.set(span, mapHeight * 0.08, span);
      uniforms.uCenter.value.set(camera.position.x, camera.position.y - mapHeight * 0.75, camera.position.z);
      uniforms.uScale.value = span / 220;
      uniforms.uOpacity.value = 0.8 * storm;
    } else {
      uniforms.uBox.value.set(70, 22, 70);
      uniforms.uCenter.value.set(camera.position.x, camera.position.y + 5, camera.position.z);
      uniforms.uScale.value = 1;
      // A little dust always moves in the wind; a storm fills the air.
      uniforms.uOpacity.value = Math.min(1, 0.1 + 0.035 * windMs) * 0.5 * (1 - storm) + 0.7 * storm;
    }
    this.dust.visible = uniforms.uOpacity.value > 0.01;
    const grains = mapHeight > 0 ? 1400 : Math.round(GRAINS * Math.min(1, 0.25 + 0.75 * storm + windMs / 40));
    // The banks come first in the buffer and are only drawn in a storm.
    const banks = storm > 0.05 ? PUFFS : 0;
    this.dust.geometry.setDrawRange(PUFFS - banks, banks + grains);

    // Dust devils: gusty daytime, and not inside a storm, where nothing that far away can be seen.
    // Perseverance's weather station logged the most whirlwinds between 12:00 and 13:00 (Newman et al. 2022).
    // They build up and die away around that hour; the 09:00-17:00 window is our own shape, not a measured one.
    this.passing = storm < 0.3 ? Math.max(0, this.passing - dt) : 0;
    const wanted = this.passing > 0 ? 1 : windMs > 6.5 && daylight > 0.6 && storm < 0.3 ? devilShape(hour) : 0;
    this.devilLevel += (wanted - this.devilLevel) * Math.min(1, dt * 0.5);
    this.devils.visible = this.devilLevel > 0.02;
    if (!this.devils.visible) return;
    const limit = this.site.local.half - 60;
    this.bases.forEach((base, i) => {
      const away = Math.hypot(base.x - traveller.x, base.z - traveller.z);
      if (base.y < -1e4 || away > 900 || Math.abs(base.x) > limit || Math.abs(base.z) > limit) {
        // Start a new one ahead of the camera so it is seen, at a different distance for each.
        camera.getWorldDirection(this.ahead);
        // The one sent past the crew starts nearer and closer to the middle of the view.
        const near = i === 0 && this.passing > 0;
        const angle = Math.atan2(this.ahead.x, -this.ahead.z) + (Math.random() - 0.5) * (near ? 0.7 : 1.5);
        const distance = near ? 120 : 180 + 190 * i + 120 * Math.random();
        base.x = THREE.MathUtils.clamp(traveller.x + Math.sin(angle) * distance, -limit, limit);
        base.z = THREE.MathUtils.clamp(traveller.z - Math.cos(angle) * distance, -limit, limit);
      }
      base.x += (windX * 4 + Math.sin(this.time * 0.3 + i * 2) * 1.5) * dt;
      base.z += (windZ * 4 + Math.cos(this.time * 0.23 + i) * 1.5) * dt;
      base.y = this.site.groundAt(base.x, base.z);
    });
    this.devilMaterial.uniforms.uTime.value = this.time;
    this.devilMaterial.uniforms.uPixels.value = pixels;
    this.devilMaterial.uniforms.uOpacity.value = this.devilLevel;
  }

  /** Send one dust devil past the crew, starting about 120 m away. The far ones on the plain are scenery. */
  passBy(): void {
    // Marks the first one as gone, so the next frame starts it again, close and in view.
    this.bases[0].y = -Infinity;
    this.passing = 45;
  }

  dispose(): void {
    this.dust.geometry.dispose();
    this.devils.geometry.dispose();
    this.dustMaterial.dispose();
    this.devilMaterial.dispose();
  }
}
