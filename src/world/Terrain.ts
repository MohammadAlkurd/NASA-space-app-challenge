import * as THREE from 'three';
import type { Heightfield, SiteData } from './SiteData';

const CHUNK_CELLS = 128;
const LOD_STEPS = [1, 2, 4, 8];
// Distance from the camera to the nearest edge of a chunk at which each level ends.
const LOD_DISTANCES = [70, 420, 1100];

const NOISE_GLSL = /* glsl */ `
float marsHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float marsNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(marsHash(i), marsHash(i + vec2(1.0, 0.0)), u.x),
             mix(marsHash(i + vec2(0.0, 1.0)), marsHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float marsFbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * marsNoise(p);
    p = p * 2.03 + 17.1;
    amp *= 0.5;
  }
  return sum;
}
vec3 marsRamp(float g) {
  vec3 dark = vec3(0.25, 0.17, 0.13);
  vec3 mid = vec3(0.56, 0.40, 0.29);
  vec3 bright = vec3(0.82, 0.66, 0.50);
  return g < 0.5 ? mix(dark, mid, g * 2.0) : mix(mid, bright, g * 2.0 - 2.0 + 1.0);
}
`;

/** Object-space normal map (RGB = normal * 0.5 + 0.5) computed from the heightfield. */
function buildNormalTexture(field: Heightfield): THREE.DataTexture {
  const n = field.n;
  const data = new Uint8Array(n * n * 4);
  const inv = 1 / (2 * field.cell);
  const h = field.data;
  for (let j = 0; j < n; j += 1) {
    const jUp = Math.max(j - 1, 0) * n;
    const jDown = Math.min(j + 1, n - 1) * n;
    for (let i = 0; i < n; i += 1) {
      const dx = (h[j * n + Math.min(i + 1, n - 1)] - h[j * n + Math.max(i - 1, 0)]) * inv;
      const dz = (h[jDown + i] - h[jUp + i]) * inv;
      const length = Math.hypot(dx, 1, dz);
      const o = (j * n + i) * 4;
      data[o] = (-dx / length) * 127.5 + 127.5;
      data[o + 1] = (1 / length) * 127.5 + 127.5;
      data[o + 2] = (-dz / length) * 127.5 + 127.5;
      data[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function loadGrayTexture(url: string): Promise<THREE.Texture> {
  return new THREE.TextureLoader().loadAsync(url).then((texture) => {
    texture.flipY = false;
    texture.colorSpace = THREE.NoColorSpace;
    texture.anisotropy = 8;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.needsUpdate = true;
    return texture;
  });
}

/** Shared terrain look: grayscale HiRISE image mapped to Mars colours, plus procedural detail close up. */
export interface OverlayUniforms {
  uOverlay: { value: THREE.Texture };
  uOverlayOpacity: { value: number };
}

function createTerrainMaterial(
  ortho: THREE.Texture,
  normal: THREE.Texture,
  detail: number,
  overlay: OverlayUniforms,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    map: ortho,
    normalMap: normal,
    normalMapType: THREE.ObjectSpaceNormalMap,
    roughness: 0.96,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = { value: detail };
    shader.uniforms.uOverlay = overlay.uOverlay;
    shader.uniforms.uOverlayOpacity = overlay.uOverlayOpacity;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrainPos = transformed;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vTerrainPos;\nuniform float uDetail;\nuniform sampler2D uOverlay;\nuniform float uOverlayOpacity;\n${NOISE_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        float marsGray = texture2D(map, vMapUv).r;
        float marsDist = length(vTerrainPos - cameraPosition);
        float marsNear = uDetail * (1.0 - smoothstep(40.0, 220.0, marsDist));
        float marsClose = uDetail * (1.0 - smoothstep(5.0, 45.0, marsDist));
        float marsMottle = marsFbm(vTerrainPos.xz * 0.45);
        float marsGrain = marsFbm(vTerrainPos.xz * 5.0);
        // The orbital image has sunlight baked in; flatten it so scene lighting does the shading.
        marsGray = 0.2 + marsGray * 0.66;
        float marsPebble = marsNoise(vTerrainPos.xz * 23.0);
        marsGray += (marsMottle - 0.5) * 0.2 * marsNear + (marsGrain - 0.5) * 0.26 * marsClose;
        // Dark pebbles and bright dust pockets right under the traveller.
        marsGray += (smoothstep(0.62, 0.8, marsPebble) * -0.16 + smoothstep(0.3, 0.1, marsPebble) * 0.07) * marsClose;
        vec3 marsColor = marsRamp(clamp(marsGray, 0.0, 1.0));
        marsColor *= mix(vec3(1.0), vec3(1.05, 0.97, 0.9), marsFbm(vTerrainPos.xz * 0.012));
        diffuseColor.rgb *= pow(marsColor, vec3(2.2));
        vec4 marsOverlay = texture2D(uOverlay, vMapUv);
        // Keep the photo's shading under the data colour so landmarks stay recognisable.
        vec3 marsTint = marsOverlay.rgb * (0.55 + 0.75 * marsGray);
        diffuseColor.rgb = mix(diffuseColor.rgb, marsTint, marsOverlay.a * uOverlayOpacity);
        `,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        vec3 marsNormal = texture2D(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
        vec2 marsP = vTerrainPos.xz;
        float marsB0 = marsFbm(marsP * 0.9);
        vec2 marsBump = vec2(marsFbm(marsP * 0.9 + vec2(0.15, 0.0)) - marsB0, marsFbm(marsP * 0.9 + vec2(0.0, 0.15)) - marsB0);
        float marsG0 = marsFbm(marsP * 7.0);
        vec2 marsFine = vec2(marsFbm(marsP * 7.0 + vec2(0.2, 0.0)) - marsG0, marsFbm(marsP * 7.0 + vec2(0.0, 0.2)) - marsG0);
        marsNormal.xz -= marsBump * 3.0 * marsNear + marsFine * 2.6 * marsClose;
        normal = normalize(normalMatrix * marsNormal);
        `,
      );
  };
  return material;
}

class Chunk {
  readonly center = new THREE.Vector3();
  private readonly meshes: (THREE.Mesh | null)[] = LOD_STEPS.map(() => null);
  private current = -1;

  constructor(
    private readonly field: Heightfield,
    private readonly material: THREE.Material,
    private readonly group: THREE.Group,
    private readonly i0: number,
    private readonly j0: number,
  ) {
    const mid = CHUNK_CELLS / 2;
    const x = field.coord(Math.min(i0 + mid, field.n - 1));
    const z = field.coord(Math.min(j0 + mid, field.n - 1));
    this.center.set(x, field.heightAt(x, z), z);
  }

  setLod(lod: number): void {
    if (lod === this.current) return;
    const previous = this.meshes[this.current];
    if (previous) previous.visible = false;
    let mesh = this.meshes[lod];
    if (!mesh) {
      mesh = new THREE.Mesh(
        buildGridGeometry(this.field, this.i0, this.j0, CHUNK_CELLS, LOD_STEPS[lod], 3 * LOD_STEPS[lod]),
        this.material,
      );
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.meshes[lod] = mesh;
      this.group.add(mesh);
    }
    mesh.visible = true;
    this.current = lod;
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh?.geometry.dispose();
  }
}

/**
 * Grid patch over samples [i0, i0 + cells] x [j0, j0 + cells] taking every `step`-th sample,
 * with a downward skirt that hides cracks between patches of different detail.
 * `hole` (in sample indices) leaves out cells that a finer mesh covers.
 */
function buildGridGeometry(
  field: Heightfield,
  i0: number,
  j0: number,
  cells: number,
  step: number,
  skirt: number,
  hole?: { i0: number; i1: number; j0: number; j1: number },
): THREE.BufferGeometry {
  const last = field.n - 1;
  const iEnd = Math.min(i0 + cells, last);
  const jEnd = Math.min(j0 + cells, last);
  const cols: number[] = [];
  const rows: number[] = [];
  for (let i = i0; i < iEnd; i += step) cols.push(i);
  cols.push(iEnd);
  for (let j = j0; j < jEnd; j += step) rows.push(j);
  rows.push(jEnd);

  const nx = cols.length;
  const nz = rows.length;
  const ring = 2 * (nx + nz);
  const vertexCount = nx * nz + ring;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const normals = new Float32Array(vertexCount * 3);
  const indices: number[] = [];

  const put = (index: number, i: number, j: number, drop: number) => {
    const x = field.coord(i);
    const z = field.coord(j);
    positions[index * 3] = x;
    positions[index * 3 + 1] = field.sample(i, j) - drop;
    positions[index * 3 + 2] = z;
    uvs[index * 2] = (x + field.half) / field.size;
    uvs[index * 2 + 1] = (z + field.half) / field.size;
    normals[index * 3 + 1] = 1;
  };

  for (let r = 0; r < nz; r += 1) {
    for (let c = 0; c < nx; c += 1) put(r * nx + c, cols[c], rows[r], 0);
  }
  for (let r = 0; r < nz - 1; r += 1) {
    for (let c = 0; c < nx - 1; c += 1) {
      if (hole && cols[c] >= hole.i0 && cols[c + 1] <= hole.i1 && rows[r] >= hole.j0 && rows[r + 1] <= hole.j1) continue;
      const a = r * nx + c;
      indices.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1);
    }
  }

  let next = nx * nz;
  const addSkirt = (edge: number[], flip: boolean) => {
    const start = next;
    for (const top of edge) {
      const c = top % nx;
      const r = (top - c) / nx;
      put(next, cols[c], rows[r], skirt);
      next += 1;
    }
    for (let k = 0; k < edge.length - 1; k += 1) {
      const a = edge[k];
      const b = edge[k + 1];
      const c = start + k;
      const d = start + k + 1;
      if (flip) indices.push(a, c, b, b, c, d);
      else indices.push(a, b, c, b, d, c);
    }
  };
  const north: number[] = [];
  const south: number[] = [];
  const west: number[] = [];
  const east: number[] = [];
  for (let c = 0; c < nx; c += 1) {
    north.push(c);
    south.push((nz - 1) * nx + c);
  }
  for (let r = 0; r < nz; r += 1) {
    west.push(r * nx);
    east.push(r * nx + nx - 1);
  }
  addSkirt(north, false);
  addSkirt(south, true);
  addSkirt(west, true);
  addSkirt(east, false);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(vertexCount > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

export class Terrain {
  readonly group = new THREE.Group();
  private readonly chunks: Chunk[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly blank = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
  private readonly overlay: OverlayUniforms = { uOverlay: { value: this.blank }, uOverlayOpacity: { value: 0 } };
  private readonly noOverlay: OverlayUniforms = { uOverlay: { value: this.blank }, uOverlayOpacity: { value: 0 } };

  private constructor(private readonly site: SiteData) {
    this.group.name = 'terrain';
    this.blank.needsUpdate = true;
  }

  static async create(site: SiteData): Promise<Terrain> {
    const terrain = new Terrain(site);
    const [ortho, regionalOrtho] = await Promise.all([
      loadGrayTexture(`${site.baseUrl}ortho.jpg`),
      loadGrayTexture(`${site.baseUrl}regional_ortho.jpg`),
    ]);
    terrain.buildLocal(ortho);
    terrain.buildRegional(regionalOrtho);
    return terrain;
  }

  /** Drape a data layer over the local terrain; null shows the plain orbital image. */
  setOverlay(texture: THREE.Texture | null, opacity = 1): void {
    this.overlay.uOverlay.value = texture ?? this.blank;
    this.overlay.uOverlayOpacity.value = texture ? opacity : 0;
  }

  /** Pick each chunk's level of detail from its distance to the camera. */
  update(camera: THREE.Vector3): void {
    for (const chunk of this.chunks) {
      const distance = Math.max(chunk.center.distanceTo(camera) - 230, 0);
      let lod = LOD_DISTANCES.length;
      for (let k = 0; k < LOD_DISTANCES.length; k += 1) {
        if (distance < LOD_DISTANCES[k]) {
          lod = k;
          break;
        }
      }
      chunk.setLod(lod);
    }
  }

  dispose(): void {
    for (const chunk of this.chunks) chunk.dispose();
    for (const item of this.disposables) item.dispose();
  }

  private buildLocal(ortho: THREE.Texture): void {
    const field = this.site.local;
    const normal = buildNormalTexture(field);
    const material = createTerrainMaterial(ortho, normal, 1, this.overlay);
    this.disposables.push(ortho, normal, material);
    for (let j = 0; j < field.n - 1; j += CHUNK_CELLS) {
      for (let i = 0; i < field.n - 1; i += CHUNK_CELLS) {
        this.chunks.push(new Chunk(field, material, this.group, i, j));
      }
    }
  }

  private buildRegional(ortho: THREE.Texture): void {
    const field = this.site.regional;
    const normal = buildNormalTexture(field);
    const material = createTerrainMaterial(ortho, normal, 0, this.noOverlay);
    // Leave out the area the local terrain covers (kept one cell inside its edge so the seam is hidden).
    const inner = this.site.local.half - field.cell * 2;
    const lo = Math.ceil((field.half - inner) / field.cell - 0.5);
    const hi = Math.floor((field.half + inner) / field.cell - 0.5);
    const geometry = buildGridGeometry(field, 0, 0, field.n, 4, 60, { i0: lo, i1: hi, j0: lo, j1: hi });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = -1.5;
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = false;
    this.group.add(mesh);
    this.disposables.push(ortho, normal, material, geometry);
  }
}
