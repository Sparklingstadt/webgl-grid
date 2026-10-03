import * as THREE from 'three';
import { seededRandom } from '../../core/random';
import type { AddonModule } from '../../engine/addons/Addons';
import { isModel, type Any, type Obj } from '../../engine/types';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import type { Placement } from '../cinema4d/cloner';
import type { ClonerModeDef, EffectorValue, Origin } from '../cinema4d/effectors';

// --- MoGraph 配置: クローナーの並べ方を足す (Cinema 4D のクローナーのモード) ---
//   ハニカム: 蜂の巣のように、1 段おきにずらして並べる
//   オブジェクト: ほかの物の頂点・面の中心・表面 (ランダム)・中身 (ランダム) に並べる (その物を動かすと、ついていく)
const N = (v: EffectorValue | undefined) => Number(v ?? 0);
const at = (x: number, y: number, z: number, ry = 0): Placement => ({ x, y, z, ry, scale: 1, delay: 0 });

export function honeycomb(q: Record<string, EffectorValue>, max: number): Placement[] {
  const w = Math.max(Math.round(N(q.width)), 1), h = Math.max(Math.round(N(q.height)), 1), s = N(q.spacing);
  const rowH = s * Math.sqrt(3) / 2, wall = q.plane === 'xy';
  const out: Placement[] = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w && out.length < max; i++) {
    const x = (i - (w - 1) / 2 + (j % 2 ? 0.5 : 0)) * s, v = j * rowH;
    out.push(wall ? at(x, v, 0) : at(x, 0, v - (h - 1) * rowH / 2));
  }
  return out;
}

// 物の形の点 (物の node から見た位置と、上から見た向き)。分布ごとに覚えておき、物の位置と向きだけ毎回当てる
interface Sample { p: THREE.Vector3; yaw: number }
function samplesOf(mesh: THREE.Mesh, dist: string, count: number, seed: number, max: number): Sample[] {
  const g = mesh.geometry as THREE.BufferGeometry, pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (!pos) return [];
  const idx = g.index ? Array.from(g.index.array) : Array.from({ length: pos.count }, (_, i) => i);
  const v = (i: number) => new THREE.Vector3().fromBufferAttribute(pos, i);
  const yawOf = (n: THREE.Vector3) => (Math.hypot(n.x, n.z) > 1e-3 ? Math.atan2(n.x, n.z) : 0);
  const out: Sample[] = [];
  if (dist === 'vertices') {
    const step = Math.max(Math.ceil(pos.count / max), 1);
    for (let i = 0; i < pos.count && out.length < max; i += step) out.push({ p: v(i), yaw: nor ? yawOf(new THREE.Vector3().fromBufferAttribute(nor, i)) : 0 });
    return out;
  }
  const tris: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [];
  for (let i = 0; i + 2 < idx.length; i += 3) tris.push([v(idx[i]), v(idx[i + 1]), v(idx[i + 2])]);
  const normal = (t: THREE.Vector3[]) => new THREE.Vector3().subVectors(t[1], t[0]).cross(new THREE.Vector3().subVectors(t[2], t[0]));
  if (dist === 'faces') {
    const step = Math.max(Math.ceil(tris.length / max), 1);
    for (let i = 0; i < tris.length && out.length < max; i += step) {
      const t = tris[i];
      out.push({ p: new THREE.Vector3().add(t[0]).add(t[1]).add(t[2]).divideScalar(3), yaw: yawOf(normal(t)) });
    }
    return out;
  }
  const rnd = seededRandom(seed), n = Math.min(Math.max(Math.round(count), 1), max);
  if (dist === 'volume') {
    // 中身: 物の箱の中のランダムな点のうち、形の中 (上下に線を引いて、面を奇数回またぐ) のもの
    if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox!, ray = new THREE.Ray(), hit = new THREE.Vector3();
    for (let k = 0; k < n * 8 && out.length < n; k++) {
      const p = new THREE.Vector3(b.min.x + rnd() * (b.max.x - b.min.x), b.min.y + rnd() * (b.max.y - b.min.y), b.min.z + rnd() * (b.max.z - b.min.z));
      ray.set(p, new THREE.Vector3(0.0123, 1, 0.0071).normalize());
      let crossings = 0;
      for (const t of tris) if (ray.intersectTriangle(t[0], t[1], t[2], false, hit)) crossings++;
      if (crossings % 2) out.push({ p, yaw: rnd() * Math.PI * 2 });
    }
    return out;
  }
  // 表面: 面の広さに合わせて、ランダムな点
  const areas = tris.map(t => normal(t).length() / 2), total = areas.reduce((a, b) => a + b, 0);
  if (!total) return out;
  const acc: number[] = [];
  areas.reduce((a, b, i) => (acc[i] = a + b), 0);
  for (let k = 0; k < n; k++) {
    const r = rnd() * total;
    let lo = 0, hi = acc.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (acc[m] < r) lo = m + 1; else hi = m; }
    const t = tris[lo];
    let a = rnd(), b = rnd();
    if (a + b > 1) { a = 1 - a; b = 1 - b; }
    out.push({ p: t[0].clone().addScaledVector(new THREE.Vector3().subVectors(t[1], t[0]), a).addScaledVector(new THREE.Vector3().subVectors(t[2], t[0]), b), yaw: yawOf(normal(t)) });
  }
  return out;
}

const DISTS = [
  { value: 'vertices', label: '頂点' }, { value: 'faces', label: '面の中心' },
  { value: 'surface', label: '表面 (ランダム)' }, { value: 'volume', label: '中身 (ランダム)' },
];

export function makeModes(find: (id: number) => Obj | null): ClonerModeDef[] {
  const cache = new WeakMap<THREE.BufferGeometry, Map<string, Sample[]>>();
  return [
    {
      key: 'honeycomb', name: 'ハニカム', description: '蜂の巣のように、1 段おきに半分ずらして並べる',
      params: [
        { key: 'width', label: '横の数', type: 'number', default: 5, min: 1, max: 50, step: 1 },
        { key: 'height', label: '段の数', type: 'number', default: 5, min: 1, max: 50, step: 1 },
        { key: 'spacing', label: '間隔', type: 'number', default: 1.2, min: 0.01, step: 0.1, digits: 2 },
        { key: 'plane', label: '向き', type: 'select', default: 'xz', options: [{ value: 'xz', label: '床 (XZ)' }, { value: 'xy', label: '壁 (XY)' }] },
      ],
      layout: (q, max) => honeycomb(q, max),
    },
    {
      key: 'object', name: 'オブジェクト', description: 'ほかの物の頂点・面の中心・表面・中身に並べる (その物を動かすと、ついていく。MMD モデルは動かす前の形)',
      params: [
        { key: 'target', label: '物', type: 'object', default: 0 },
        { key: 'distribution', label: '分布', type: 'select', default: 'surface', options: DISTS },
        { key: 'count', label: '数', type: 'number', default: 50, min: 1, step: 1, hint: '表面・中身のときの数' },
        { key: 'seed', label: 'シード', type: 'number', default: 1, min: 0, step: 1 },
        { key: 'align', label: '面の向きに合わせる', type: 'boolean', default: true },
      ],
      live: true,
      layout: (q, max, origin: Origin) => {
        const o = find(N(q.target));
        const mesh: THREE.Mesh | undefined = o ? (isModel(o) ? o.model as Any : o.mesh) : undefined;
        if (!o || !mesh || o.light) return [];
        const key = `${q.distribution}|${q.count}|${q.seed}|${max}`;
        let m = cache.get(mesh.geometry);
        if (!m) cache.set(mesh.geometry, m = new Map());
        let samples = m.get(key);
        if (!samples) { m.set(key, samples = samplesOf(mesh, String(q.distribution), N(q.count), N(q.seed), max)); if (m.size > 8) m.delete(m.keys().next().value!); }
        // 物の形の点を場面へ (物の node の位置・向き) → このクローナーから見た位置へ
        o.node.updateMatrixWorld();
        mesh.updateMatrixWorld();
        const c = Math.cos(origin.r), s = Math.sin(origin.r), w = new THREE.Vector3();
        return samples.map(({ p, yaw }) => {
          w.copy(p).applyMatrix4(mesh.matrixWorld);
          const dx = w.x - origin.x, dz = w.z - origin.z;
          return at(dx * c - dz * s, w.y - origin.y, dx * s + dz * c, q.align ? yaw + o.r - origin.r : 0);
        });
      },
    },
  ];
}

const mographModes: AddonModule = {
  id: 'mograph-modes',
  name: 'MoGraph 配置',
  version: '1.0.0',
  author: 'webgl-grid',
  category: 'MoGraph',
  description: 'クローナーの並べ方を足す: ハニカム (蜂の巣) と、オブジェクト (ほかの物の頂点・面・表面・中身に並べる)。クローナーの「並べ方」から選びます。',
  enabledByDefault: true,
  requires: ['cinema4d'],
  register(api) {
    const c4d = api.require<Cinema4d>('cinema4d');
    const offs = makeModes(id => (id ? api.engine.world.find(id) : null)).map(def => c4d.addClonerMode(def));
    return () => { for (const off of offs) off(); };
  },
};
export default mographModes;
