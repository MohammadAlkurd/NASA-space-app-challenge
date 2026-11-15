import * as THREE from 'three';

export const DUST_COLOR = new THREE.Color('#cfa983');
export const STORM_COLOR = new THREE.Color('#b08055');

// Daytime: butterscotch at the horizon, darker overhead (Viking, Pathfinder and rover colour-calibrated images).
const DAY_HORIZON = new THREE.Color('#d9b48c');
const DAY_ZENITH = new THREE.Color('#9c7a5e');
// Sunset and sunrise: the sky away from the sun goes dull red-brown while the sky around it turns blue
// (NASA PIA19400, Curiosity sol 956, Gale Crater).
const DUSK_HORIZON = new THREE.Color('#8a6c5c');
const DUSK_ZENITH = new THREE.Color('#4c403c');
const DUSK_FOG = new THREE.Color('#8f7464');
const NIGHT_HORIZON = new THREE.Color('#0b0e16');
const NIGHT_ZENITH = new THREE.Color('#04060b');
const SUN_DAY = new THREE.Color('#fff0dc');
const SUN_LOW = new THREE.Color('#dfe6f2');
const AMBIENT_DAY = new THREE.Color('#e2c3a2');
const AMBIENT_DUSK = new THREE.Color('#b3a3a6');
const AMBIENT_MURK = new THREE.Color('#c79a70');
const AMBIENT_NIGHT = new THREE.Color('#7f8fb0');
// Forward scattering by dust, in linear light: warm and broad by day, blue when the sun is low.
const GLOW_DAY = new THREE.Color().setRGB(0.30, 0.27, 0.24);
const GLOW_LOW = new THREE.Color().setRGB(0.13, 0.26, 0.5);
const HALO_DAY = new THREE.Color().setRGB(0.55, 0.62, 0.72);
const HALO_LOW = new THREE.Color().setRGB(0.4, 0.6, 1.0);
const CLOUD = new THREE.Color().setRGB(0.8, 0.86, 1.0);

const { smoothstep } = THREE.MathUtils;

/** How far dust has taken over the sky: 0 in very clear air, about 0.05 at tau 0.4, 0.25 at tau 1, 0.95 in a global storm. */
export function murk(tau: number): number {
  return 1 - Math.exp(-Math.max(0, tau - 0.3) / 2.5);
}

/** 0 on an ordinary sol, 1 once the dust is storm-thick. Drives blowing dust and the flat storm sky. */
export function stormLevel(tau: number): number {
  return smoothstep(tau, 1.5, 6);
}

/**
 * Dusty Martian sky, sun and haze, coloured by the sun's height and the dust optical depth (tau).
 * The palette is an artistic fit to rover photographs, not a radiative-transfer model. The dome follows the camera.
 */
export class Sky {
  readonly group = new THREE.Group();
  readonly sun = new THREE.DirectionalLight(SUN_DAY, 3.4);
  readonly ambient = new THREE.HemisphereLight(AMBIENT_DAY, '#6b4a36', 1.15);
  /** Direction the sunlight comes from. Kept a little above the horizon so low light still models the ground. */
  readonly sunDirection = new THREE.Vector3();
  /** Scene fog colour that matches the sky at the horizon. */
  readonly fog = new THREE.Color(DUST_COLOR);
  private readonly discDirection = new THREE.Vector3();
  private readonly horizon = new THREE.Color();
  private readonly zenith = new THREE.Color();
  private readonly glow = new THREE.Color();
  private readonly halo = new THREE.Color();
  private readonly cloud = new THREE.Color();
  private readonly scratch = new THREE.Color();
  private readonly dome: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(radius: number) {
    this.material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uSunDir: { value: this.discDirection },
        uHorizon: { value: this.horizon },
        uZenith: { value: this.zenith },
        uGlow: { value: this.glow },
        uHalo: { value: this.halo },
        uCloud: { value: this.cloud },
        uDisc: { value: 1 },
        uGlowPower: { value: 6 },
        uStars: { value: 0 },
        uClouds: { value: 0 },
        uTau: { value: 0.5 },
        uTime: { value: 0 },
        uStorm: { value: 0 },
        uStormColor: { value: new THREE.Color() },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir;
        uniform vec3 uHorizon;
        uniform vec3 uZenith;
        uniform vec3 uGlow;
        uniform vec3 uHalo;
        uniform vec3 uCloud;
        uniform float uDisc;
        uniform float uGlowPower;
        uniform float uStars;
        uniform float uClouds;
        uniform float uTau;
        uniform float uTime;
        uniform float uStorm;
        uniform vec3 uStormColor;
        varying vec3 vDir;
        float hash2(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float hash3(vec3 p) {
          return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
        }
        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        void main() {
          vec3 dir = normalize(vDir);
          float up = clamp(dir.y, 0.0, 1.0);
          vec3 color = mix(uHorizon, uZenith, pow(up, 0.55));
          color = mix(color, uHorizon * 0.92, smoothstep(0.0, -0.08, dir.y));
          // Starlight is dimmed by the dust it crosses, most near the horizon.
          if (uStars > 0.001 && dir.y > 0.0) {
            vec3 cell = dir * 190.0;
            float seed = hash3(floor(cell));
            float point = smoothstep(0.42, 0.05, length(fract(cell) - 0.5));
            color += vec3(0.75, 0.8, 0.9) * point * smoothstep(0.985, 1.0, seed) * uStars * exp(-uTau / max(dir.y, 0.08));
          }
          // Thin water-ice cloud streaks high above the dust.
          if (uClouds > 0.001 && dir.y > 0.02) {
            vec2 p = dir.xz / (dir.y + 0.25) * vec2(1.6, 4.5) + vec2(uTime * 0.004, 0.0);
            float wisp = noise(p) * 0.55 + noise(p * 2.3 + 7.0) * 0.3 + noise(p * 5.1 + 3.0) * 0.15;
            color = mix(color, uCloud, smoothstep(0.5, 0.85, wisp) * smoothstep(0.02, 0.3, dir.y) * uClouds);
          }
          float toSun = max(dot(dir, uSunDir), 0.0);
          color += uGlow * pow(toSun, uGlowPower);
          color += uHalo * pow(toSun, 90.0);
          color += vec3(4.0, 3.8, 3.5) * smoothstep(0.99990, 0.99996, toSun) * uDisc;
          gl_FragColor = vec4(color, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          // Dust storm: a flat brown-orange murk with the sun reduced to a dull glow. Fog is mixed in
          // after tone mapping, so the murk is too; only then do ground and sky meet at the horizon.
          vec3 murk = uStormColor * (1.0 - 0.25 * smoothstep(0.15, 1.0, up) + 0.1 * pow(toSun, 4.0));
          gl_FragColor.rgb = mix(gl_FragColor.rgb, murk, uStorm);
        }
      `,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), this.material);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1;
    this.group.add(this.dome, this.ambient, this.sun, this.sun.target);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const shadowCamera = this.sun.shadow.camera;
    shadowCamera.near = 1;
    shadowCamera.far = 260;
    shadowCamera.left = -32;
    shadowCamera.right = 32;
    shadowCamera.top = 32;
    shadowCamera.bottom = -32;
    this.sun.shadow.bias = -0.0006;
    this.setConditions(38, 245, 0.5, 0, 0);
  }

  /**
   * Colours the sky, the sunlight and the fog for the sun's position and the dust in the air.
   * @param elevationDeg sun above the horizon, degrees. @param azimuthDeg clockwise from north.
   * @param tau dust optical depth. @param clouds 0..1, how strongly the water-ice cloud season shows.
   * @returns daylight: 1 in full day, 0 at night, with a long dusty twilight in between.
   */
  setConditions(elevationDeg: number, azimuthDeg: number, tau: number, clouds: number, dt: number): number {
    const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
    const point = (target: THREE.Vector3, degrees: number) => {
      const elevation = THREE.MathUtils.degToRad(degrees);
      target.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));
    };
    point(this.discDirection, elevationDeg);
    point(this.sunDirection, Math.max(7, elevationDeg));

    const dust = murk(tau);
    const storm = stormLevel(tau);
    // 1 with the sun on or under the horizon, 0 once it is well up.
    const low = 1 - smoothstep(elevationDeg, 2, 16);
    // Dust high in the air keeps scattering sunlight long after sunset, so a dim twilight lingers.
    const daylight = 0.75 * smoothstep(elevationDeg, -4, 10) + 0.25 * smoothstep(elevationDeg, -16, 0);

    this.horizon.copy(DAY_HORIZON).lerp(DUSK_HORIZON, low);
    this.zenith.copy(DAY_ZENITH).lerp(DUSK_ZENITH, low);
    // More dust: less contrast between horizon and zenith, and a browner sky.
    this.scratch.copy(STORM_COLOR).multiplyScalar(1 - 0.35 * low);
    this.zenith.lerp(this.horizon, 0.6 * dust).lerp(this.scratch, dust);
    this.horizon.lerp(this.scratch, dust);
    this.horizon.multiplyScalar(daylight).lerp(NIGHT_HORIZON, 1 - daylight);
    this.zenith.multiplyScalar(daylight).lerp(NIGHT_ZENITH, 1 - daylight);

    this.glow.copy(GLOW_DAY).lerp(GLOW_LOW, low).multiplyScalar(smoothstep(elevationDeg, -14, -2) * (1 - 0.85 * dust));
    this.halo.copy(HALO_DAY).lerp(HALO_LOW, low).multiplyScalar(smoothstep(elevationDeg, -8, 0) * (1 - dust));
    // The disc fades as its light crosses more dust near the horizon.
    const path = 1 / Math.max(Math.sin(THREE.MathUtils.degToRad(elevationDeg)), 0.08) - 1;
    const uniforms = this.material.uniforms;
    uniforms.uDisc.value = (1 - dust) ** 2 * Math.exp(-0.15 * tau * path) * smoothstep(elevationDeg, -1.2, -0.2);
    // By day the dust glow is broad; at sunset the blue is a fan some 20 degrees wide around the sun.
    uniforms.uGlowPower.value = 6 + 18 * low;
    uniforms.uStars.value = 1 - smoothstep(elevationDeg, -14, -5);
    uniforms.uTau.value = tau;
    uniforms.uClouds.value = 0.4 * clouds * (1 - dust);
    uniforms.uTime.value += dt;
    this.cloud.copy(CLOUD).multiplyScalar(0.05 + 0.95 * daylight);

    this.sun.color.copy(SUN_DAY).lerp(SUN_LOW, low);
    this.sun.intensity = (1.2 + 2.4 * this.sunDirection.y) * smoothstep(elevationDeg, -3, 6) * (1 - 0.9 * dust);
    this.ambient.color.copy(AMBIENT_DAY).lerp(AMBIENT_DUSK, low).lerp(AMBIENT_MURK, dust).lerp(AMBIENT_NIGHT, 1 - daylight);
    this.ambient.intensity = 1.15 * (0.3 + 0.7 * daylight) * (1 - 0.25 * dust);

    this.fog.copy(DUST_COLOR).lerp(DUSK_FOG, low).lerp(this.scratch, Math.max(dust, storm)).multiplyScalar(0.04 + 0.96 * daylight);
    uniforms.uStorm.value = storm;
    uniforms.uStormColor.value.copy(this.fog).convertLinearToSRGB();
    return daylight;
  }

  /** Keep the dome on the camera and the shadow box on the point of interest. */
  update(camera: THREE.Vector3, focus: THREE.Vector3): void {
    this.dome.position.copy(camera);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDirection, 130);
  }

  dispose(): void {
    this.dome.geometry.dispose();
    this.material.dispose();
  }
}
