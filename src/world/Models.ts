import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// One loader for every model, so the Meshopt decoder is set up once.
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

/** Load `public/models/<name>.glb`. The files are built from NASA 3D Resources models; see the Sources panel. */
export async function loadModel(name: string): Promise<GLTF> {
  const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}models/${name}.glb`);
  gltf.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const map = (mesh.material as THREE.MeshStandardMaterial).map;
    if (map) map.anisotropy = 4;
  });
  return gltf;
}

/** Find a material by its glTF name. */
export function materialNamed(root: THREE.Object3D, name: string): THREE.MeshStandardMaterial | undefined {
  let found: THREE.MeshStandardMaterial | undefined;
  root.traverse((object) => {
    const material = (object as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (material?.name === name) found = material;
  });
  return found;
}

export function disposeModel(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const material = mesh.material as THREE.MeshStandardMaterial;
    material.map?.dispose();
    material.dispose();
  });
}
