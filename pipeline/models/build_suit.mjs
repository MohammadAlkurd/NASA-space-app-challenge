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
const BONES = ['hips', 'thighL', 'shinL', 'thighR', 'shinR', 'armL', 'armR', 'foreL', 'foreR'];
const PARENT = { thighL: 'hips', shinL: 'thighL', thighR: 'hips', shinR: 'thighR', armL: 'hips', armR: 'hips', foreL: 'armL', foreR: 'armR' };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const Y = (y) => (y - FLOOR) * SCALE;
// The suit is built from separate shells joined at bearings, so each shell follows one bone; only the knee bends.
function weights(p, shell) {
  const w = new Float32Array(BONES.length);
  const side = (shell.min[0] + shell.max[0]) / 2 >= 0 ? 'L' : 'R';
  const wide = shell.max[0] - shell.min[0];
  if (shell.arm) {
    // The arm leaves the torso through a bearing ring: the ring end stays with the torso, and the sleeve bends at the elbow.
    const a = ARMS[side];
    const free = smooth(0.02, 0.2, Math.hypot(p[0]-a.root[0], p[1]-a.root[1], p[2]-a.root[2]));
    const fore = smooth(-0.06, 0.06, (p[0]-a.elbow[0])*a.bis[0] + (p[1]-a.elbow[1])*a.bis[1] + (p[2]-a.elbow[2])*a.bis[2]);
    w[0] = 1 - free;
    w[BONES.indexOf('arm' + side)] = free * (1 - fore);
    w[BONES.indexOf('fore' + side)] = free * fore;
    return w;
  }
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

const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a); return [a[0]/l, a[1]/l, a[2]/l]; };
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const mean = (list) => { const c = [0, 0, 0]; for (const p of list) for (let k = 0; k < 3; k++) c[k] += p[k] / list.length; return c; };
/** Shortest rotation taking unit vector a to unit vector b, as [x, y, z, w]. */
const arc = (a, b) => { const c = cross(a, b), w = 1 + dot(a, b), l = Math.hypot(c[0], c[1], c[2], w); return [c[0]/l, c[1]/l, c[2]/l, w/l]; };
const qmul = (a, b) => [a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1], a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0], a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3], a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qrot = (q, v) => { const r = qmul(qmul(q, [...v, 0]), qinv(q)); return [r[0], r[1], r[2]]; };

// Arms: read each arm's centreline off the mesh (the source pose has them held out in front, each differently).
const isArm = (name, minY) => /hand_lambert2SG/.test(name) || (/legsSG/.test(name) && minY > Y(1.3));
const armPts = { L: [], R: [] }, handPts = { L: [], R: [] };
node.getMesh().listPrimitives().forEach((prim) => {
  const name = prim.getMaterial().getName();
  if (!/hand_lambert2SG|legsSG/.test(name)) return;
  const pos = prim.getAttribute('POSITION').getArray(); const { find } = components(prim); const shells = new Map();
  for (let i = 0; i < pos.length; i += 3) {
    const r = find(i / 3), p = tf(pos[i], pos[i+1], pos[i+2]);
    let sh = shells.get(r); if (!sh) shells.set(r, sh = { minY: 1e9, sx: 0, n: 0, pts: [] });
    sh.minY = Math.min(sh.minY, p[1]); sh.sx += p[0]; sh.n++; sh.pts.push(p);
  }
  for (const sh of shells.values()) if (isArm(name, sh.minY)) { const side = sh.sx >= 0 ? 'L' : 'R'; armPts[side].push(...sh.pts); if (/hand_/.test(name)) handPts[side].push(...sh.pts); }
});
const ARMS = {};
for (const side of ['L', 'R']) {
  const pts = armPts[side], hand = mean(handPts[side]);
  const far = [...pts].sort((a, b) => len(sub(b, hand)) - len(sub(a, hand))).slice(0, Math.ceil(pts.length * 0.02));
  const root = mean(far);
  const reach = Math.max(...pts.map((p) => len(sub(p, root))));
  const line = Array.from({ length: 16 }, () => []);
  for (const p of pts) line[Math.min(15, Math.floor(len(sub(p, root)) / reach * 16))].push(p);
  const centre = line.filter((b) => b.length > 20).map(mean);
  const chord = unit(sub(hand, root));
  let elbow = centre[Math.floor(centre.length / 2)], most = 0.03;
  for (const c of centre.slice(3, -3)) { const v = sub(c, root), off = len(sub(v, chord.map((x) => x * dot(v, chord)))); if (off > most) { most = off; elbow = c; } }
  const pivot = centre[2];
  const upper = unit(sub(elbow, pivot)), lower = unit(sub(hand, elbow));
  const out = side === 'L' ? 1 : -1;
  // Rest pose: arms hanging a little out from the body with the hands beside the thighs, the elbow only just bent.
  const upperTo = unit([0.22 * out, -1, -0.04]), lowerTo = unit([0.16 * out, -1, 0.08]);
  const qs = arc(upper, upperTo);
  const d = arc(qrot(qs, lower), lowerTo);
  ARMS[side] = { root, pivot, elbow, hand, bis: unit([upper[0]+lower[0], upper[1]+lower[1], upper[2]+lower[2]]), shoulder: qs, fore: qmul(qmul(qinv(qs), d), qs) };
  J['arm' + side] = pivot; J['fore' + side] = elbow;
  console.log(side, 'root', root.map((v) => v.toFixed(2)), 'pivot', pivot.map((v) => v.toFixed(2)), 'elbow', elbow.map((v) => v.toFixed(2)), 'hand', hand.map((v) => v.toFixed(2)), 'bend', most.toFixed(2));
}

const out = new Document();
out.createExtension(EXTMeshoptCompression).setRequired(true);
const buffer = out.createBuffer();
const scene = out.createScene('astronaut');
const bones = {};
for (const name of BONES) {
  const parent = PARENT[name]; const p = J[name], q = parent ? J[parent] : [0, 0, 0];
  bones[name] = out.createNode(name).setTranslation([p[0]-q[0], p[1]-q[1], p[2]-q[2]]);
  const arm = /^(arm|fore)([LR])$/.exec(name);
  if (arm) bones[name].setRotation(arm[1] === 'arm' ? ARMS[arm[2]].shoulder : ARMS[arm[2]].fore);
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
  for (const sh of shells.values()) sh.arm = isArm(name, sh.min[1]);
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
