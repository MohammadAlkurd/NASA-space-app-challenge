import * as THREE from 'three';

const HORIZON = new THREE.Color('#d9b48c');
const ZENITH = new THREE.Color('#9c7a5e');
export const DUST_COLOR = new THREE.Color('#cfa983');

/** Dusty Martian sky, sun and haze. The dome follows the camera. */
export class Sky {
  readonly group = new THREE.Group();
  readonly sun = new THREE.DirectionalLight('#fff0dc', 3.4);
  readonly ambient = new THREE.HemisphereLight('#e2c3a2', '#6b4a36', 1.15);
  readonly sunDirection = new THREE.Vector3();
  private readonly dome: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(radius: number) {
    this.material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uSunDir: { value: this.sunDirection },
        uHorizon: { value: HORIZON },
        uZenith: { value: ZENITH },
        uDay: { value: 1 },
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
        uniform float uDay;
        varying vec3 vDir;
        void main() {
          vec3 dir = normalize(vDir);
          float up = clamp(dir.y, 0.0, 1.0);
          vec3 color = mix(uHorizon, uZenith, pow(up, 0.55));
          color = mix(color, uHorizon * 0.92, smoothstep(0.0, -0.08, dir.y));
          float toSun = max(dot(dir, normalize(uSunDir)), 0.0);
          // Forward scattering by dust: a broad pale glow, bluish-white right around the sun.
          color += vec3(0.30, 0.27, 0.24) * pow(toSun, 6.0);
          color += vec3(0.55, 0.62, 0.72) * pow(toSun, 90.0);
          color += vec3(4.0, 3.8, 3.5) * smoothstep(0.99990, 0.99996, toSun);
          // Night: the dust sky fades to a faint blue-grey.
          color = mix(vec3(0.012, 0.014, 0.02), color, uDay);
          gl_FragColor = vec4(color, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
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
    this.setSun(38, 245);
  }

  /** Sun position: elevation above the horizon and azimuth clockwise from north, in degrees. */
  setSun(elevationDeg: number, azimuthDeg: number): void {
    const elevation = THREE.MathUtils.degToRad(elevationDeg);
    const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
    this.sunDirection.set(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      -Math.cos(azimuth) * Math.cos(elevation),
    );
  }

  /** 1 in full daylight, 0 at night. */
  setDaylight(day: number): void {
    this.material.uniforms.uDay.value = day;
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
