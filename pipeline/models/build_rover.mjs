import { io, components } from './comp.mjs';
import { Document } from '@gltf-transform/core';
import { EXTMeshoptCompression, EXTTextureWebP } from '@gltf-transform/extensions';
import { weld, simplify, meshopt, prune, dedup } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const SRC = process.argv[2];
const OUT = process.argv[3];
// Model units to metres: roof (hull top) sits 3.0 m above the ground, NASA's SEV fact sheet height.
const GROUND = 2.24, MID = -0.87, SCALE = 3.0 / (GROUND + 1.25);
const STATIONS = [];
for (const x of [1.7, -1.7]) for (const y of [0.83, -0.87, -2.57]) STATIONS.push({ x, y });
const AXLE = 1.86, WHEEL_R = 0.39, GLASS_LUM = 26;

const src = await io.read(SRC);
const prim = src.getRoot().listMeshes()[0].listPrimitives()[0];
const { comps, find, pos, idx, n } = components(prim);
const nor = prim.getAttribute('NORMAL').getArray();
const uv = prim.getAttribute('TEXCOORD_0').getArray();

// part ids: 0 body, 1 door, 2+2i module i, 3+2i wheel i
const partOf = new Map();
const count = {};
for (const c of comps) {
  let part = 0;
  const cx = (c.min[0] + c.max[0]) / 2;
  STATIONS.forEach((s, i) => {
    const side = Math.sign(s.x);
    const inX = c.min[0] * side > 1.3 && c.max[0] * side > 1.3 && Math.abs(c.min[0]) < 2.06 && Math.abs(c.max[0]) < 2.06;
    if (!inX || c.min[1] < s.y - 0.46 || c.max[1] > s.y + 0.46 || c.min[2] < 0.8) return;
    const r = Math.max(Math.hypot(c.min[1] - s.y, c.min[2] - AXLE), Math.hypot(c.max[1] - s.y, c.max[2] - AXLE), Math.hypot(c.min[1] - s.y, c.max[2] - AXLE), Math.hypot(c.max[1] - s.y, c.min[2] - AXLE));
    part = r <= WHEEL_R * 1.02 ? 3 + 2 * i : 2 + 2 * i;
  });
  if (part === 0 && c.min[0] >= 1.74 && Math.max(Math.abs(c.min[1]), Math.abs(c.max[1]), Math.abs(c.min[2]), Math.abs(c.max[2])) < 0.73) part = 1;
  partOf.set(c.root, part);
  count[part] = (count[part] ?? 0) + c.n;
}
const world = (x, y, z) => [x * SCALE, (GROUND - z) * SCALE, (y - MID) * SCALE];
// Window glass: body triangles painted near-black on the cabin, split off so the game can light them from inside.
const srcTex = await sharp(prim.getMaterial().getBaseColorTexture().getImage()).resize(2048, 2048).removeAlpha().raw().toBuffer();
const lum = (u, v) => { const x = Math.min(2047, Math.max(0, Math.floor((u - Math.floor(u)) * 2048))), y = Math.min(2047, Math.max(0, Math.floor((v - Math.floor(v)) * 2048))); const o = (y * 2048 + x) * 3; return (srcTex[o] + srcTex[o + 1] + srcTex[o + 2]) / 3; };
const glassTri = new Uint8Array(idx.length / 3);
let glassCount = 0;
for (let t = 0; t < idx.length; t += 3) {
  if (partOf.get(find(idx[t])) !== 0) continue;
  let dark = true, cu = 0, cv = 0; const c = [0, 0, 0];
  for (let k = 0; k < 3; k++) { const v = idx[t + k]; cu += uv[2 * v] / 3; cv += uv[2 * v + 1] / 3; if (lum(uv[2 * v], uv[2 * v + 1]) > GLASS_LUM) dark = false; const w = world(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]); for (let a = 0; a < 3; a++) c[a] += w[a] / 3; }
  if (!dark || lum(cu, cv) > GLASS_LUM || c[2] < 1.0 || c[1] < 1.2) continue;
  // 1 cockpit windows, 2 the six lamp pods on the brow. The dark seal around each side hatch stays on the body.
  const ring = Math.abs(c[0]) > 1.2 && Math.hypot(c[1] - 1.93, c[2] - 0.75) < 0.9;
  const kind = c[1] > 2.55 ? 2 : c[2] > 1.45 && !ring ? 1 : 0;
  if (kind) { glassTri[t / 3] = kind; glassCount++; }
}
console.log('glass triangles', glassCount);

const out = new Document();
out.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
const buffer = out.createBuffer();
const srcMat = prim.getMaterial();
const color = await sharp(srcMat.getBaseColorTexture().getImage()).resize(2048, 2048).webp({ quality: 82 }).toBuffer();
out.createExtension(EXTTextureWebP).setRequired(true);
const tex = out.createTexture('sev_color').setImage(color).setMimeType('image/webp');
const mat = out.createMaterial('sev').setBaseColorTexture(tex).setRoughnessFactor(0.55).setMetallicFactor(0).setDoubleSided(false);
const scene = out.createScene('rover');

function build(part, name, pivot, glass = 0, material = mat) {
  const map = new Int32Array(n).fill(-1);
  const P = [], N = [], U = [], I = [];
  for (let t = 0; t < idx.length; t += 3) {
    if (partOf.get(find(idx[t])) !== part || glassTri[t / 3] !== glass) continue;
    for (let k = 0; k < 3; k++) {
      const v = idx[t + k];
      if (map[v] < 0) {
        map[v] = P.length / 3;
        const w = world(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]);
        P.push(w[0] - pivot[0], w[1] - pivot[1], w[2] - pivot[2]);
        N.push(nor[3 * v], -nor[3 * v + 2], nor[3 * v + 1]);
        U.push(uv[2 * v], uv[2 * v + 1]);
      }
      I.push(map[v]);
    }
  }
  const p = out.createPrimitive().setMaterial(material)
    .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(new Float32Array(P)).setBuffer(buffer))
    .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(new Float32Array(N)).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(new Float32Array(U)).setBuffer(buffer))
    .setIndices(out.createAccessor().setType('SCALAR').setArray(new Uint32Array(I)).setBuffer(buffer));
  return out.createNode(name).setMesh(out.createMesh(name).addPrimitive(p));
}
scene.addChild(build(0, 'body', [0, 0, 0]));
const glassMat = out.createMaterial('glass').setBaseColorFactor([0.03, 0.05, 0.06, 1]).setRoughnessFactor(0.08).setMetallicFactor(0.6);
scene.addChild(build(0, 'glass', [0, 0, 0], 1, glassMat));
const lampMat = out.createMaterial('lamps').setBaseColorFactor([0.75, 0.74, 0.7, 1]).setRoughnessFactor(0.3).setMetallicFactor(0.1);
scene.addChild(build(0, 'lamps', [0, 0, 0], 2, lampMat));
// Hatch hinge: the rear edge of the round door.
const hinge = world(1.76, -0.72, 0);
scene.addChild(build(1, 'door', hinge).setTranslation(hinge));
STATIONS.forEach((s, i) => {
  const pivot = world(s.x, s.y, AXLE);
  const module = build(2 + 2 * i, `module_${i}`, pivot).setTranslation(pivot);
  module.addChild(build(3 + 2 * i, `wheel_${i}`, pivot));
  scene.addChild(module);
});
await MeshoptEncoder.ready;
await out.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: +(process.argv[4] ?? 0.12), error: +(process.argv[5] ?? 0.005) }), prune(), dedup(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
let tris = 0;
for (const m of out.getRoot().listMeshes()) for (const p of m.listPrimitives()) tris += p.getIndices().getCount() / 3;
console.log('triangles', tris, 'scale', SCALE.toFixed(3), 'wheel radius m', (0.38 * SCALE).toFixed(3), 'stations', STATIONS.map((s) => world(s.x, s.y, AXLE).map((v) => v.toFixed(2)).join('/')).join(' '));
await io.registerExtensions([EXTMeshoptCompression, EXTTextureWebP]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder }).write(OUT, out);
