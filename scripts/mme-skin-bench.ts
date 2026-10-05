// --- MME 互換モードの CPU の変形 (モーフ → 骨 → 輪郭線) の速さを測る ---
// 使い方: npm run mme:bench (node scripts/mme-skin-bench.ts)。
// 5 万頂点 (BDEF2 が 7 割・BDEF4 が 2 割・SDEF が 1 割)・骨 200 本・頂点モーフ 30 個 (5 個の重みが 0 でない) の合成データで、
// applyMorphs → skin → expandEdges を 200 回くり返して、1 回の平均を出す。報告のための道具なので、遅くても終了コードは 0。
import { applyMorphs, expandEdges, skin, SKIN, type SkinData } from '../src/core/mme/skinning.ts';

const VERTS = 50_000, BONES = 200, MORPHS = 30, ACTIVE = 5, RUNS = 200;

// 毎回同じ数になるように、乱数は決まった種から (mulberry32)
let seed = 20261005;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (lo: number, hi: number) => lo + (hi - lo) * rand();

// 骨ごとの変形 (回転 + 移動) の行列。列ベクトルの書き方の elements、16 個ずつ
function makeBones(): Float32Array {
  const out = new Float32Array(BONES * 16);
  for (let b = 0; b < BONES; b++) {
    let x = between(-1, 1), y = between(-1, 1), z = between(-1, 1), w = between(-1, 1);
    const l = Math.hypot(x, y, z, w);
    x /= l; y /= l; z /= l; w /= l;
    const o = b * 16;
    out[o] = 1 - 2 * (y * y + z * z); out[o + 1] = 2 * (x * y + z * w); out[o + 2] = 2 * (x * z - y * w);
    out[o + 4] = 2 * (x * y - z * w); out[o + 5] = 1 - 2 * (x * x + z * z); out[o + 6] = 2 * (y * z + x * w);
    out[o + 8] = 2 * (x * z + y * w); out[o + 9] = 2 * (y * z - x * w); out[o + 10] = 1 - 2 * (x * x + y * y);
    out[o + 12] = between(-5, 5); out[o + 13] = between(-5, 5); out[o + 14] = between(-5, 5); out[o + 15] = 1;
  }
  return out;
}

function makeSkin(): SkinData {
  const type = new Uint8Array(VERTS), bones = new Int32Array(VERTS * 4), weights = new Float32Array(VERTS * 4), sdef = new Float32Array(VERTS * 9);
  // 7 : 2 : 1 の割合のまま、頂点の順をかき混ぜる (種類がかたまっていると、分岐の予測が当たりすぎて速く出る)
  const kinds = new Uint8Array(VERTS);
  for (let v = 0; v < VERTS; v++) kinds[v] = v < VERTS * 0.7 ? SKIN.BDEF2 : v < VERTS * 0.9 ? SKIN.BDEF4 : SKIN.SDEF;
  for (let v = VERTS - 1; v > 0; v--) {
    const j = Math.floor(rand() * (v + 1));
    const k = kinds[v]; kinds[v] = kinds[j]; kinds[j] = k;
  }
  for (let v = 0; v < VERTS; v++) {
    type[v] = kinds[v];
    const n = type[v] === SKIN.BDEF4 ? 4 : 2; // BDEF2・SDEF は骨 2 本
    let sum = 0;
    for (let k = 0; k < n; k++) {
      bones[v * 4 + k] = Math.floor(rand() * BONES);
      weights[v * 4 + k] = rand() + 0.01;
      sum += weights[v * 4 + k];
    }
    for (let k = 0; k < n; k++) weights[v * 4 + k] /= sum;
    if (type[v] === SKIN.SDEF) for (let k = 0; k < 9; k++) sdef[v * 9 + k] = between(-2, 2);
  }
  return { count: VERTS, type, bones, weights, sdef };
}

function randomArray(n: number, lo: number, hi: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = between(lo, hi);
  return a;
}

const data = makeSkin();
const bones = makeBones();
const base = randomArray(VERTS * 3, -10, 10);
const normals = new Float32Array(VERTS * 3);
for (let v = 0; v < VERTS; v++) {
  const x = between(-1, 1), y = between(-1, 1), z = between(-1, 1), l = Math.hypot(x, y, z) || 1;
  normals[v * 3] = x / l; normals[v * 3 + 1] = y / l; normals[v * 3 + 2] = z / l;
}
const deltas = Array.from({ length: MORPHS }, () => randomArray(VERTS * 3, -0.1, 0.1));
const weights = new Float32Array(MORPHS);
for (let i = 0; i < ACTIVE; i++) weights[i * 6] = between(0.1, 1);
const edgeSize = randomArray(VERTS, 0.5, 2);

const morphed = new Float32Array(VERTS * 3), outPos = new Float32Array(VERTS * 3), outNrm = new Float32Array(VERTS * 3), edge = new Float32Array(VERTS * 3);
const eye: [number, number, number] = [0, 10, -40];

function once(): void {
  applyMorphs(base, deltas, weights, morphed);
  skin(data, morphed, normals, bones, outPos, outNrm);
  expandEdges(outPos, outNrm, edgeSize, eye, Math.tan(Math.PI / 8), edge);
}

for (let i = 0; i < 20; i++) once(); // 暖機
const start = performance.now();
for (let i = 0; i < RUNS; i++) once();
const ms = (performance.now() - start) / RUNS;
console.log(`${VERTS} 頂点・骨 ${BONES} 本・頂点モーフ ${MORPHS} 個 (重みが 0 でないもの ${ACTIVE} 個): 1 回の平均 ${ms.toFixed(2)} ms (${RUNS} 回)`);
