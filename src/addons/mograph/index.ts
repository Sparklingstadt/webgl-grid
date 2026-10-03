import type { AddonModule } from '../../engine/addons/Addons';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import { MAX_DELAY_FRAMES } from '../cinema4d/cloner';
import type { EffectorDef } from '../cinema4d/effectors';

// --- MoGraph エフェクタ: Cinema 4D のエフェクタ (クローナーのクローンを動かす) ---
// Cinema 4D アドオンのクローナーに、エフェクタの種類を登録する。どれも上から順にかけ、
// 位置・回転・大きさ (Cinema 4D の「パラメータ」) を、エフェクタの強さで足す
export const EFFECTORS: EffectorDef[] = [
  {
    key: 'plain', name: 'プレーン', description: '全部のクローンに、同じだけ位置・回転・大きさを足す',
  },
  {
    key: 'step', name: 'ステップ', description: '最初のクローンの 0 から最後のクローンの値まで、だんだん強くする',
    defaults: { scale: 1.5 },
    strength: c => (c.count > 1 ? c.index / (c.count - 1) : 0),
  },
  {
    key: 'random', name: 'ランダム', description: 'クローンごとに、位置・回転・大きさをばらつかせる (同じシードなら同じばらつき)',
    defaults: { position: [0.5, 0, 0.5], rotationDeg: 30 },
    params: [{ key: 'seed', label: 'シード', type: 'number', default: 1, min: 0, step: 1 }],
    // 軸ごとに -1〜1 の強さ (大きさは 0〜1)
    apply: (p, e, c) => {
      const f = c.field, r = () => (c.random() * 2 - 1) * f;
      const wp: [number, number, number] = [r(), r(), r()], wr = r(), ws = c.random() * f;
      p.x += e.position[0] * wp[0]; p.y += e.position[1] * wp[1]; p.z += e.position[2] * wp[2];
      p.ry += e.rotationDeg * Math.PI / 180 * wr;
      p.scale *= Math.max(1 + (e.scale - 1) * ws, 0);
    },
  },
  {
    key: 'formula', name: 'フォーミュラ', description: '時刻とクローンの番号で、波のように強さを変える (sin)',
    defaults: { position: [0, 0.5, 0] },
    params: [
      { key: 'frequency', label: '周波数', type: 'number', default: 1, min: 0, step: 0.1, digits: 2, unit: 'Hz' },
      { key: 'waves', label: '波の数', type: 'number', default: 1, step: 0.1, digits: 2 },
    ],
    live: true,
    strength: c => Math.sin(2 * Math.PI * (Number(c.params.frequency) * c.time + Number(c.params.waves) * c.index / Math.max(c.count, 1))),
  },
  {
    key: 'time', name: 'タイム', description: '時刻 (秒) に合わせて強くする (1 秒で値のぶんだけ。再生すると動く)',
    defaults: { rotationDeg: 90 },
    live: true,
    strength: c => c.time,
  },
  {
    key: 'target', name: 'ターゲット', description: 'クローンを、決めた場所 (地面の X・Z) へ向ける',
    transform: false,
    params: [
      { key: 'x', label: 'ターゲット X', type: 'number', default: 0, step: 0.5, digits: 1 },
      { key: 'z', label: 'ターゲット Z', type: 'number', default: 5, step: 0.5, digits: 1 },
    ],
    live: true, // (クローナーを動かすと、向きも変わる)
    apply: (p, _e, c) => {
      // ターゲットを、クローナー (元の物) から見た場所に直して、クローンからの向きにする (前は +Z)
      const dx = Number(c.params.x) - c.origin.x, dz = Number(c.params.z) - c.origin.z;
      const cos = Math.cos(c.origin.r), sin = Math.sin(c.origin.r);
      const lx = dx * cos - dz * sin, lz = dx * sin + dz * cos;
      // フィールドの強さのぶんだけ、いまの向きからターゲットの向きへ回す (近い回りで)
      const to = Math.atan2(lx - p.x, lz - p.z);
      const d = Math.atan2(Math.sin(to - p.ry), Math.cos(to - p.ry));
      p.ry += d * c.field;
    },
  },
  {
    key: 'delay', name: 'ディレイ', description: 'MMD モデルのクローンを、1 つごとに遅らせて動かす',
    transform: false,
    params: [{ key: 'frames', label: '遅れ', type: 'number', default: 5, min: 0, max: MAX_DELAY_FRAMES, step: 1, unit: 'フレーム' }],
    note: isModel => (isModel ? 'ディレイは、再生すると効きます (元のモデルの動きを覚えて、遅れて写す)' : 'ディレイは MMD モデルのクローナーで効きます'),
    apply: (p, _e, c) => { p.delay += Number(c.params.frames) * c.index * c.field; },
  },
];
const mograph: AddonModule = {
  id: 'mograph',
  name: 'MoGraph エフェクタ',
  version: '1.0.0',
  author: 'webgl-grid',
  category: 'MoGraph',
  description: 'Cinema 4D のエフェクタ: プレーン・ステップ・ランダム・フォーミュラ・タイム・ターゲット・ディレイ。クローナーのパネルの「エフェクタ」から足します。',
  enabledByDefault: true,
  requires: ['cinema4d'],
  register(api) {
    const c4d = api.require<Cinema4d>('cinema4d');
    const offs = EFFECTORS.map(def => c4d.addEffector(def));
    return () => { for (const off of offs) off(); };
  },
};
export default mograph;
