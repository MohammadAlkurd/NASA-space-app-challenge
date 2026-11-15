import { io, components } from './comp.mjs';
import { Document } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { meshopt, prune } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

const src = await io.read(process.argv[2]);
const node = src.getRoot().listNodes()[0];
const M = node.getWorldMatrix();
// Source pose: feet at y 0.294, 1.99 tall, facing -z, standing slightly off centre.
const CX = -0.055, CZ = -0.36, FLOOR = 0.2936, SCALE = 1.9 / 1.99;
const tf = (x, y, z) => { const wx = M[0]*x+M[4]*y+M[8]*z+M[12], wy = M[1]*x+M[5]*y+M[9]*z+M[13], wz = M[2]*x+M[6]*y+M[10]*z+M[14]; return [-(wx - CX) * SCALE, (wy - FLOOR) * SCALE, -(wz - CZ) * SCALE]; };
const tn = (x, y, z) => [-(M[0]*x+M[4]*y+M[8]*z), M[1]*x+M[5]*y+M[9]*z, -(M[2]*x+M[6]*y+M[10]*z)];
const at = (x, y, z) => [-(x - CX) * SCALE, (y - FLOOR) * SCALE, -(z - CZ) * SCALE];

const MATERIALS = {
  fabric: { color: [0.86, 0.84, 0.80], rough: 0.92, metal: 0 },
  shell: { color: [0.93, 0.92, 0.89], rough: 0.5, metal: 0 },
  metal: { color: [0.52, 0.54, 0.57], rough: 0.4, metal: 0.75 },
  visor: { color: [0.72, 0.5, 0.14], rough: 0.18, metal: 0.35 },
  boot: { color: [0.13, 0.13, 0.14], rough: 0.9, metal: 0 },
  trim: { color: [0.82, 0.34, 0.12], rough: 0.6, metal: 0 },
  lamp: { color: [0.81, 0.84, 0.86], rough: 0.3, metal: 0 },
};
const ASSIGN = (name, index) => {
  if (/lambert5SG/.test(name)) return null; // agency logo patch
  if (/steel2SG|blinn2SG|steelholesSG|lambert4SG/.test(name)) return 'metal';
  if (/blinn1SG/.test(name)) return 'visor';
  if (/lambert3SG/.test(name)) return 'boot';
  if (/bluesteelSG/.test(name)) return 'trim';
  if (/lambert6SG/.test(name)) return 'lamp';
  if (/legsSG|hand_lambert2SG/.test(name)) return 'fabric';
  return 'shell';
};

// Joints in game space (+y up, +z forward, +x left), read off the source mesh.
const J = {
  hips: at(CX, 1.02, CZ),
  thighL: at(CX - 0.15, 1.08, CZ), shinL: at(CX - 0.15, 0.8, CZ),
  thighR: at(CX + 0.15, 1.08, CZ), shinR: at(CX + 0.15, 0.8, CZ),
  armL: at(CX - 0.3, 1.72, CZ), armR: at(CX + 0.3, 1.72, CZ),
};
const BONES = ['hips', 'thighL', 'shinL', 'thighR', 'shinR', 'armL', 'armR'];
const PARENT = { thighL: 'hips', shinL: 'thighL', thighR: 'hips', shinR: 'thighR', armL: 'hips', armR: 'hips' };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const Y = (y) => (y - FLOOR) * SCALE;
// The suit is built from separate shells joined at bearings, so each shell follows one bone; only the knee bends.
function weights(p, shell) {
  const w = new Float32Array(BONES.length);
  const side = (shell.min[0] + shell.max[0]) / 2 >= 0 ? 'L' : 'R';
  const wide = shell.max[0] - shell.min[0];
  if (shell.arm) { w[BONES.indexOf('arm' + side)] = 1; return w; }
  if (shell.max[1] < Y(1.26) && wide < 0.45) {
    const leg = smooth(Y(1.2), Y(1.06), p[1]);
    const shin = smooth(J.shinL[1] + 0.06, J.shinL[1] - 0.06, p[1]);
    w[BONES.indexOf('thigh' + side)] = leg * (1 - shin);
    w[BONES.indexOf('shin' + side)] = leg * shin;
    w[0] = 1 - leg;
    return w;
  }
  w[0] = 1;
  return w;
}

const out = new Document();
out.createExtension(EXTMeshoptCompression).setRequired(true);
const buffer = out.createBuffer();
const scene = out.createScene('astronaut');
const bones = {};
for (const name of BONES) {
  const parent = PARENT[name]; const p = J[name], q = parent ? J[parent] : [0, 0, 0];
  bones[name] = out.createNode(name).setTranslation([p[0]-q[0], p[1]-q[1], p[2]-q[2]]);
  if (parent) bones[parent].addChild(bones[name]); else scene.addChild(bones[name]);
}
const ibm = new Float32Array(16 * BONES.length);
BONES.forEach((name, i) => { ibm.set([1,0,0,0, 0,1,0,0, 0,0,1,0, -J[name][0], -J[name][1], -J[name][2], 1], 16 * i); });
const skin = out.createSkin('suit').setInverseBindMatrices(out.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer));
for (const name of BONES) skin.addJoint(bones[name]);
skin.setSkeleton(bones.hips);

const groups = {};
node.getMesh().listPrimitives().forEach((prim, index) => {
  const key = ASSIGN(prim.getMaterial().getName(), index);
  if (!key) return;
  const g = groups[key] ??= { P: [], N: [], Jn: [], W: [], I: [] };
  const pos = prim.getAttribute('POSITION').getArray(), nor = prim.getAttribute('NORMAL').getArray(), idx = prim.getIndices().getArray();
  const base = g.P.length / 3;
  const { find } = components(prim); const shells = new Map();
  const name = prim.getMaterial().getName();
  for (let i = 0; i < pos.length; i += 3) {
    const r = find(i / 3), p = tf(pos[i], pos[i+1], pos[i+2]);
    let sh = shells.get(r); if (!sh) shells.set(r, sh = { min: [1e9,1e9,1e9], max: [-1e9,-1e9,-1e9] });
    for (let k = 0; k < 3; k++) { sh.min[k] = Math.min(sh.min[k], p[k]); sh.max[k] = Math.max(sh.max[k], p[k]); }
  }
  for (const sh of shells.values()) sh.arm = /hand_lambert2SG/.test(name) || (/legsSG/.test(name) && sh.min[1] > Y(1.3));
  for (let i = 0; i < pos.length; i += 3) {
    const p = tf(pos[i], pos[i+1], pos[i+2]); g.P.push(...p); g.N.push(...tn(nor[i], nor[i+1], nor[i+2]));
    const w = weights(p, shells.get(find(i / 3)));
    const top = [...w.keys()].sort((a, b) => w[b] - w[a]).slice(0, 4); const sum = top.reduce((s, k) => s + w[k], 0);
    for (const k of top) { g.Jn.push(w[k] > 0 ? k : 0); g.W.push(w[k] / sum); }
  }
  for (const i of idx) g.I.push(base + i);
});
const mesh = out.createMesh('suit');
let tris = 0;
for (const [key, g] of Object.entries(groups)) {
  const m = MATERIALS[key];
  const mat = out.createMaterial(key).setBaseColorFactor([...m.color, 1]).setRoughnessFactor(m.rough).setMetallicFactor(m.metal).setDoubleSided(true);
  mesh.addPrimitive(out.createPrimitive().setMaterial(mat)
    .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(new Float32Array(g.P)).setBuffer(buffer))
    .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(new Float32Array(g.N)).setBuffer(buffer))
    .setAttribute('JOINTS_0', out.createAccessor().setType('VEC4').setArray(new Uint8Array(g.Jn)).setBuffer(buffer))
    .setAttribute('WEIGHTS_0', out.createAccessor().setType('VEC4').setArray(new Float32Array(g.W)).setBuffer(buffer))
    .setIndices(out.createAccessor().setType('SCALAR').setArray(new Uint32Array(g.I)).setBuffer(buffer)));
  tris += g.I.length / 3;
}
scene.addChild(out.createNode('suit').setMesh(mesh).setSkin(skin));
await MeshoptEncoder.ready;
await out.transform(prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
console.log('triangles', tris);
await io.registerExtensions([EXTMeshoptCompression]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder }).write(process.argv[3], out);
