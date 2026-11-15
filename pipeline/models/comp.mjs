import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
export const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule(), 'draco3d.encoder': await draco3d.createEncoderModule() });
/** Connected components of a primitive, joining vertices that share a position. */
export function components(prim) {
  const pos = prim.getAttribute('POSITION').getArray();
  const idx = prim.getIndices().getArray();
  const n = pos.length / 3;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const seen = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos[3*i]*2000)},${Math.round(pos[3*i+1]*2000)},${Math.round(pos[3*i+2]*2000)}`;
    const j = seen.get(k); if (j === undefined) seen.set(k, i); else union(i, j);
  }
  for (let t = 0; t < idx.length; t += 3) { union(idx[t], idx[t+1]); union(idx[t], idx[t+2]); }
  const comps = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i); let c = comps.get(r);
    if (!c) comps.set(r, c = { root: r, n: 0, min: [1e9,1e9,1e9], max: [-1e9,-1e9,-1e9] });
    c.n++; for (let a = 0; a < 3; a++) { c.min[a] = Math.min(c.min[a], pos[3*i+a]); c.max[a] = Math.max(c.max[a], pos[3*i+a]); }
  }
  return { comps: [...comps.values()], find, pos, idx, n };
}
if (process.argv[1]?.endsWith('/comp.mjs')) {
  const doc = await io.read(process.argv[2]);
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    const { comps, pos, n, idx } = components(prim);
    const min=[1e9,1e9,1e9], max=[-1e9,-1e9,-1e9];
    for (let i=0;i<n;i++) for (let a=0;a<3;a++){min[a]=Math.min(min[a],pos[3*i+a]);max[a]=Math.max(max[a],pos[3*i+a]);}
    console.log(mesh.getName(), prim.getMaterial()?.getName(), 'verts', n, 'tris', idx.length/3, 'bbox', min.map(v=>v.toFixed(2)), max.map(v=>v.toFixed(2)), 'comps', comps.length);
    if (process.argv[3]) for (const c of comps.sort((a,b)=>b.n-a.n).slice(0, +process.argv[3])) console.log('  ', c.n, c.min.map(v=>v.toFixed(2)).join(','), '->', c.max.map(v=>v.toFixed(2)).join(','));
  }
}
