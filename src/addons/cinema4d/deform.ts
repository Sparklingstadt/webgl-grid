import { msg } from '../../core/i18n';
import { num } from '../../core/normalize';

// --- デフォーマ (Cinema 4D のデフォーマ): 形を曲げる・ねじる・細くする・ふくらませる ---
// 物の大きさ (バウンディングボックス) の範囲で、軸にそって変形する。軸の向きの 0 (底) 〜 1 (上) を t とする
export type DeformerKind = 'bend' | 'twist' | 'taper' | 'bulge';
export type Axis = 'x' | 'y' | 'z';
export interface Deformer {
  kind: DeformerKind;
  enabled: boolean;
  axis: Axis;
  amount: number;       // ベンド・ツイスト: 角度 (度)、テーパー・バルジ: 強さ (0 でそのまま)
  directionDeg: number; // ベンド: 曲げる向き (軸まわりの角度)
}
export interface Box { min: [number, number, number]; max: [number, number, number] }

export const DEFORMER_KINDS: { key: DeformerKind; name: string; unit: string; min: number; max: number; step: number; def: number }[] = [
  { key: 'bend', name: msg('ベンド'), unit: '°', min: -360, max: 360, step: 1, def: 90 },
  { key: 'twist', name: msg('ツイスト'), unit: '°', min: -720, max: 720, step: 1, def: 90 },
  { key: 'taper', name: msg('テーパー'), unit: '', min: -1, max: 2, step: 0.01, def: -0.5 },
  { key: 'bulge', name: msg('バルジ'), unit: '', min: -1, max: 2, step: 0.01, def: 0.5 },
];
export const newDeformer = (kind: DeformerKind): Deformer =>
  ({ kind, enabled: true, axis: 'y', amount: DEFORMER_KINDS.find(k => k.key === kind)!.def, directionDeg: 0 });
export const activeDeformers = (list: Deformer[] | null | undefined) => (list ?? []).filter(d => d.enabled && d.amount !== 0);

export function normalizeDeformers(list: unknown): Deformer[] {
  if (!Array.isArray(list)) return [];
  return list.filter(d => DEFORMER_KINDS.some(k => k.key === d?.kind)).slice(0, 16).map(d => {
    const k = DEFORMER_KINDS.find(x => x.key === d.kind)!;
    return {
      kind: d.kind, enabled: d.enabled !== false, axis: (['x', 'y', 'z'] as const).includes(d.axis) ? d.axis : 'y',
      amount: num(d.amount, k.def, k.min, k.max), directionDeg: num(d.directionDeg, 0),
    };
  });
}

const D = Math.PI / 180;
// 軸を Y に入れ替える (入れ替えは 2 回で元に戻る)
function swap(p: number[], axis: Axis) {
  if (axis === 'x') [p[0], p[1]] = [p[1], p[0]];
  else if (axis === 'z') [p[2], p[1]] = [p[1], p[2]];
}

// 点 p (書き換える) を変形する
function deformOne(p: number[], d: Deformer, box: Box) {
  const lo = [...box.min], hi = [...box.max];
  swap(p, d.axis); swap(lo, d.axis); swap(hi, d.axis);
  const L = hi[1] - lo[1];
  if (L > 1e-9) {
    const cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2;
    const t = Math.min(Math.max((p[1] - lo[1]) / L, 0), 1);
    let x = p[0] - cx, z = p[2] - cz;
    if (d.kind === 'twist') {
      const a = d.amount * D * t, c = Math.cos(a), s = Math.sin(a);
      [x, z] = [x * c - z * s, x * s + z * c];
    } else if (d.kind === 'taper' || d.kind === 'bulge') {
      const k = d.kind === 'taper' ? 1 + d.amount * t : 1 + d.amount * (1 - (2 * t - 1) ** 2);
      x *= k; z *= k;
    } else {
      // ベンド: 曲げる向きを +X にそろえ、底から上へ円弧にそって曲げる
      const th = d.amount * D, phi = d.directionDeg * D;
      if (Math.abs(th) > 1e-9) {
        const c = Math.cos(phi), s = Math.sin(phi);
        const u = x * c + z * s, w = -x * s + z * c;
        const R = L / th, a = th * t;
        const nu = R - (R - u) * Math.cos(a);
        p[1] = lo[1] + (R - u) * Math.sin(a);
        x = nu * c - w * s; z = nu * s + w * c;
      }
    }
    p[0] = x + cx; p[2] = z + cz;
  }
  swap(p, d.axis);
}
export function deformPoint(p: [number, number, number], list: Deformer[], box: Box): [number, number, number] {
  const q = [...p];
  for (const d of activeDeformers(list)) deformOne(q, d, box);
  return q as [number, number, number];
}

// 頂点の位置と法線を変形する (新しい配列を返す)。法線は、変形のヤコビ行列の逆転置で回す
export function deformArrays(pos: ArrayLike<number>, nor: ArrayLike<number> | null, list: Deformer[], box: Box) {
  const active = activeDeformers(list);
  const outP = Float32Array.from(pos), outN = nor ? Float32Array.from(nor) : null;
  if (!active.length) return { positions: outP, normals: outN };
  const size = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2], 1e-6);
  const e = size * 1e-4;
  const f = (x: number, y: number, z: number) => { const q = [x, y, z]; for (const d of active) deformOne(q, d, box); return q; };
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    const p0 = f(x, y, z);
    outP[i] = p0[0]; outP[i + 1] = p0[1]; outP[i + 2] = p0[2];
    if (!outN || !nor) continue;
    // ヤコビ行列の列 (x・y・z 方向に少し動かしたときの動き)
    const a = f(x + e, y, z), b = f(x, y + e, z), c = f(x, y, z + e);
    const J = [
      [(a[0] - p0[0]) / e, (b[0] - p0[0]) / e, (c[0] - p0[0]) / e],
      [(a[1] - p0[1]) / e, (b[1] - p0[1]) / e, (c[1] - p0[1]) / e],
      [(a[2] - p0[2]) / e, (b[2] - p0[2]) / e, (c[2] - p0[2]) / e],
    ];
    // 余因子行列 (= det · J^-T) を法線に掛ける
    const C = [
      [J[1][1] * J[2][2] - J[1][2] * J[2][1], J[1][2] * J[2][0] - J[1][0] * J[2][2], J[1][0] * J[2][1] - J[1][1] * J[2][0]],
      [J[0][2] * J[2][1] - J[0][1] * J[2][2], J[0][0] * J[2][2] - J[0][2] * J[2][0], J[0][1] * J[2][0] - J[0][0] * J[2][1]],
      [J[0][1] * J[1][2] - J[0][2] * J[1][1], J[0][2] * J[1][0] - J[0][0] * J[1][2], J[0][0] * J[1][1] - J[0][1] * J[1][0]],
    ];
    const nx = nor[i], ny = nor[i + 1], nz = nor[i + 2];
    let rx = C[0][0] * nx + C[0][1] * ny + C[0][2] * nz;
    let ry = C[1][0] * nx + C[1][1] * ny + C[1][2] * nz;
    let rz = C[2][0] * nx + C[2][1] * ny + C[2][2] * nz;
    const det = J[0][0] * C[0][0] + J[0][1] * C[0][1] + J[0][2] * C[0][2];
    const len = Math.hypot(rx, ry, rz) * (det < 0 ? -1 : 1) || 1;
    rx /= len; ry /= len; rz /= len;
    outN[i] = rx; outN[i + 1] = ry; outN[i + 2] = rz;
  }
  return { positions: outP, normals: outN };
}
