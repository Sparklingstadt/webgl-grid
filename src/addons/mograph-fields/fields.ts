import { msg } from '../../core/i18n';
import { noise3 } from '../cinema4d/noise';
import type { EffectorParam, EffectorValue, FieldDef, Point3 } from '../cinema4d/effectors';

// --- MoGraph フィールド (Cinema 4D のフィールド) の種類 ---
// 値は 0〜1 (エフェクタの強さ)。場所を持つフィールドは、場面の位置 (中心) と大きさを持つ
const N = (v: EffectorValue | undefined) => Number(v ?? 0);
const center = (y = 0): EffectorParam[] => [
  { key: 'cx', label: msg('中心 X'), type: 'number', default: 0, step: 0.5, digits: 1 },
  { key: 'cy', label: msg('中心 Y'), type: 'number', default: y, step: 0.5, digits: 1 },
  { key: 'cz', label: msg('中心 Z'), type: 'number', default: 0, step: 0.5, digits: 1 },
];
const inner: EffectorParam = { key: 'inner', label: msg('内側'), type: 'number', default: 0.5, min: 0, max: 1, step: 0.05, digits: 2, hint: msg('中心からこの割合までは 1、そこから外へなめらかに 0 へ') };
const AXES = [{ value: 'x', label: 'X' }, { value: 'y', label: msg('Y (縦)') }, { value: 'z', label: 'Z' }];
const smooth = (t: number) => { const c = Math.min(Math.max(t, 0), 1); return c * c * (3 - 2 * c); };
// 中心から外へ: 内側 (割合) までは 1、端で 0
const falloff = (d: number, r: number, k: number) => (r <= 0 ? 0 : 1 - smooth((d / r - k) / Math.max(1 - k, 1e-6)));
const local = (p: Point3, q: Record<string, EffectorValue>) => ({ x: p.x - N(q.cx), y: p.y - N(q.cy), z: p.z - N(q.cz) });
const c3 = (q: Record<string, EffectorValue>): [number, number, number] => [N(q.cx), N(q.cy), N(q.cz)];

export const FIELDS: FieldDef[] = [
  {
    key: 'linear', name: msg('リニア'), description: msg('軸にそって、0 から 1 へなめらかに変わる'),
    params: [...center(), { key: 'axis', label: msg('軸'), type: 'select', default: 'x', options: AXES }, { key: 'length', label: msg('長さ'), type: 'number', default: 4, min: 0.01, step: 0.5, digits: 1 }],
    value: (p, c) => {
      const l = local(p, c.params), a = String(c.params.axis) as 'x' | 'y' | 'z';
      return smooth(l[a] / N(c.params.length) + 0.5);
    },
    gizmo: q => ({ shape: 'plane', center: c3(q), size: [N(q.length)], axis: String(q.axis) as 'x' }),
  },
  {
    key: 'sphere', name: msg('球'), description: msg('中心から半径の中で効く'),
    params: [...center(1), { key: 'radius', label: msg('半径'), type: 'number', default: 2, min: 0.01, step: 0.25, digits: 2 }, inner],
    value: (p, c) => { const l = local(p, c.params); return falloff(Math.hypot(l.x, l.y, l.z), N(c.params.radius), N(c.params.inner)); },
    gizmo: q => ({ shape: 'sphere', center: c3(q), size: [N(q.radius)], inner: N(q.inner) }),
  },
  {
    key: 'box', name: msg('ボックス'), description: msg('箱の中で効く'),
    params: [...center(1),
      { key: 'sx', label: msg('幅'), type: 'number', default: 3, min: 0.01, step: 0.25, digits: 2 },
      { key: 'sy', label: msg('高さ'), type: 'number', default: 3, min: 0.01, step: 0.25, digits: 2 },
      { key: 'sz', label: msg('奥行き'), type: 'number', default: 3, min: 0.01, step: 0.25, digits: 2 }, inner],
    value: (p, c) => {
      const l = local(p, c.params), k = N(c.params.inner);
      // 軸ごとに中心からの割合を見て、いちばん外側の軸で決める
      const t = Math.max(Math.abs(l.x) / (N(c.params.sx) / 2), Math.abs(l.y) / (N(c.params.sy) / 2), Math.abs(l.z) / (N(c.params.sz) / 2));
      return falloff(t, 1, k);
    },
    gizmo: q => ({ shape: 'box', center: c3(q), size: [N(q.sx), N(q.sy), N(q.sz)], inner: N(q.inner) }),
  },
  {
    key: 'cylinder', name: msg('円柱'), description: msg('縦の円柱の中で効く'),
    params: [...center(1), { key: 'radius', label: msg('半径'), type: 'number', default: 2, min: 0.01, step: 0.25, digits: 2 },
      { key: 'height', label: msg('高さ'), type: 'number', default: 3, min: 0.01, step: 0.25, digits: 2 }, inner],
    value: (p, c) => {
      const l = local(p, c.params), k = N(c.params.inner);
      return Math.min(falloff(Math.hypot(l.x, l.z), N(c.params.radius), k), falloff(Math.abs(l.y), N(c.params.height) / 2, k));
    },
    gizmo: q => ({ shape: 'cylinder', center: c3(q), size: [N(q.radius), N(q.height)], inner: N(q.inner) }),
  },
  {
    key: 'radial', name: msg('放射'), description: msg('中心のまわりの角度で、0 から 1 へ変わる (真上から見て、奥 (+Z) から右回り)'),
    params: [...center(), { key: 'turns', label: msg('回数'), type: 'number', default: 1, min: 0.01, step: 0.25, digits: 2, hint: msg('一周で何回 0→1 をくり返すか') }],
    value: (p, c) => {
      const l = local(p, c.params);
      const a = (Math.atan2(l.x, l.z) / (2 * Math.PI) + 1) % 1;
      return (a * N(c.params.turns)) % 1;
    },
  },
  {
    key: 'random', name: msg('ランダム'), description: msg('クローンごとに、ばらばらの値 (シードで決まる)'),
    params: [{ key: 'seed', label: msg('シード'), type: 'number', default: 1, min: 0, step: 1 }],
    value: (_p, c) => c.random(),
  },
  {
    key: 'noise', name: msg('ノイズ'), description: msg('場所でなめらかに変わる値 (シェーダーのノイズ)。速さを付けると時刻で流れる'),
    params: [
      { key: 'size', label: msg('大きさ'), type: 'number', default: 2, min: 0.01, step: 0.25, digits: 2, hint: msg('ノイズの模様の大きさ') },
      { key: 'speed', label: msg('速さ'), type: 'number', default: 0, step: 0.1, digits: 2, hint: msg('1 秒に流れる量') },
      { key: 'contrast', label: msg('コントラスト'), type: 'number', default: 1, min: 0, step: 0.1, digits: 2 },
      { key: 'seed', label: msg('シード'), type: 'number', default: 1, min: 0, step: 1 },
    ],
    live: true,
    value: (p, c) => {
      const s = N(c.params.size) || 1, t = N(c.params.speed) * c.time;
      const v = noise3(p.x / s + t, p.y / s, p.z / s - t * 0.5, N(c.params.seed));
      return (v - 0.5) * N(c.params.contrast) * 2 + 0.5;
    },
  },
  {
    key: 'time', name: msg('タイム'), description: msg('時刻に合わせて 0 から 1 へ (始めから長さの秒数で)'),
    params: [
      { key: 'start', label: msg('始め'), type: 'number', default: 0, min: 0, step: 0.5, digits: 1, unit: msg('秒') },
      { key: 'length', label: msg('長さ'), type: 'number', default: 3, min: 0.01, step: 0.5, digits: 1, unit: msg('秒') },
    ],
    live: true,
    value: (_p, c) => smooth((c.time - N(c.params.start)) / N(c.params.length)),
  },
];
