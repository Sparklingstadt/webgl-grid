import type { Placement } from '../cinema4d/cloner';
import type { ClonerModeDef, EffectorDef, EffectorValue, Origin } from '../cinema4d/effectors';
import { sampleAlong, type Polyline } from '../cinema4d/splines';

// --- スプラインを使う MoGraph: クローナーの並べ方「スプライン」と、スプライン・エフェクタ ---
// スプラインは、ほかの物 (MoSpline・トレーサー) が出す曲線 (Cinema4d.splinesOf)
const N = (v: EffectorValue | undefined) => Number(v ?? 0);

// 場面での点と向きを、クローナー (origin) から見た位置と、縦軸まわりの向きにする
export function toLocal(point: { x: number; y: number; z: number }, tangent: { x: number; z: number } | null, o: Origin) {
  const dx = point.x - o.x, dz = point.z - o.z, c = Math.cos(o.r), s = Math.sin(o.r);
  return { x: dx * c - dz * s, y: point.y - o.y, z: dx * s + dz * c, ry: tangent && Math.hypot(tangent.x, tangent.z) > 1e-6 ? Math.atan2(tangent.x, tangent.z) - o.r : 0 };
}
// 数 n のクローンを、start〜end に等しく
const tOf = (i: number, n: number, a: number, b: number) => (n > 1 ? a + (b - a) * i / (n - 1) : a);

export function splineMode(splines: (id: number) => Polyline[]): ClonerModeDef {
  return {
    key: 'spline', name: 'スプライン', description: 'ほかの物のスプライン (MoSpline・トレーサー) にそって並べる',
    params: [
      { key: 'target', label: 'スプライン', type: 'object', default: 0 },
      { key: 'count', label: '数', type: 'number', default: 20, min: 1, step: 1 },
      { key: 'start', label: '始め', type: 'number', default: 0, min: 0, max: 1, step: 0.05, digits: 2 },
      { key: 'end', label: '終わり', type: 'number', default: 1, min: 0, max: 1, step: 0.05, digits: 2 },
      { key: 'align', label: '向きに合わせる', type: 'boolean', default: true },
    ],
    live: true,
    layout: (q, max, origin) => {
      const lines = splines(N(q.target));
      const n = Math.min(Math.max(Math.round(N(q.count)), 1), max), out: Placement[] = [];
      if (!lines.length) return out;
      for (let i = 0; i < n; i++) {
        const s = sampleAlong(lines, tOf(i, n, N(q.start), N(q.end)));
        if (!s) break;
        const l = toLocal(s.point, q.align ? s.tangent : null, origin);
        out.push({ x: l.x, y: l.y, z: l.z, ry: l.ry, scale: 1, delay: 0 });
      }
      return out;
    },
  };
}

export function splineEffector(splines: (id: number) => Polyline[]): EffectorDef {
  return {
    key: 'spline', name: 'スプライン', description: 'クローンを、ほかの物のスプラインの上へ動かす (番号の順に、始めから終わりへ。強さはフィールドで)',
    transform: false,
    params: [
      { key: 'target', label: 'スプライン', type: 'object', default: 0 },
      { key: 'start', label: '始め', type: 'number', default: 0, min: 0, max: 1, step: 0.05, digits: 2 },
      { key: 'end', label: '終わり', type: 'number', default: 1, min: 0, max: 1, step: 0.05, digits: 2 },
      { key: 'align', label: '向きに合わせる', type: 'boolean', default: true },
    ],
    live: true,
    applyAll: (out, _e, cs) => {
      const q = cs[0]?.params;
      const lines = q ? splines(N(q.target)) : [];
      if (!lines.length) return;
      out.forEach((p, i) => {
        const w = cs[i].field;
        const s = w ? sampleAlong(lines, tOf(i, out.length, N(q.start), N(q.end))) : null;
        if (!s) return;
        const l = toLocal(s.point, q.align ? s.tangent : null, cs[i].origin);
        p.x += (l.x - p.x) * w; p.y += (l.y - p.y) * w; p.z += (l.z - p.z) * w;
        if (q.align) p.ry += Math.atan2(Math.sin(l.ry - p.ry), Math.cos(l.ry - p.ry)) * w;
      });
    },
  };
}
