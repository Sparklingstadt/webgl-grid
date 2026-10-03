import * as THREE from 'three';
import { msg } from '../../core/i18n';
import type { AddonModule } from '../../engine/addons/Addons';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import { MAX_DELAY_FRAMES } from '../cinema4d/cloner';
import { noise3 } from '../cinema4d/noise';
import { addTransform, type EffectorDef, type Point3 } from '../cinema4d/effectors';
import { evaluate, formula } from './expr';
import { BANDS, levelAt, analyzeFile, type SoundLevels } from './sound';

// --- MoGraph エフェクタ: Cinema 4D のエフェクタ (クローナーのクローンを動かす) ---
// Cinema 4D アドオンのクローナーに、エフェクタの種類を登録する。どれも上から順にかけ、
// 位置・回転・大きさ (Cinema 4D の「パラメータ」) を、エフェクタの強さで足す
// 場面を見るエフェクタ (ボリューム・継承・サウンド) が使うもの
export interface EffectorDeps {
  bounds(id: number): { min: Point3; max: Point3 } | null;        // 物の場面での大きさ (箱)
  worldLayout(id: number): { x: number; y: number; z: number; ry: number; scale: number }[]; // クローナーのクローンの場面での置き場所
  sound(t: number, band?: number): number;                         // 曲の大きさ (0〜1)
  hasSound(): boolean;
}
const NO_DEPS: EffectorDeps = { bounds: () => null, worldLayout: () => [], sound: () => 0, hasSound: () => false };
const N = (v: unknown) => Number(v ?? 0);

export const makeEffectors = (deps: EffectorDeps = NO_DEPS): EffectorDef[] => [
  {
    key: 'plain', name: msg('プレーン'), description: msg('全部のクローンに、同じだけ位置・回転・大きさを足す'),
  },
  {
    key: 'step', name: msg('ステップ'), description: msg('最初のクローンの 0 から最後のクローンの値まで、だんだん強くする'),
    defaults: { scale: 1.5 },
    strength: c => (c.count > 1 ? c.index / (c.count - 1) : 0),
  },
  {
    key: 'random', name: msg('ランダム'), description: msg('クローンごとに、位置・回転・大きさをばらつかせる (同じシードなら同じばらつき)'),
    defaults: { position: [0.5, 0, 0.5], rotationDeg: 30 },
    params: [{ key: 'seed', label: msg('シード'), type: 'number', default: 1, min: 0, step: 1 }],
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
    key: 'formula', name: msg('フォーミュラ'), description: msg('式で強さを決める (Cinema 4D と同じ変数: t 時刻・f 周波数・id 番号・count 数・x y z 位置・rnd 乱数。三角関数は度)'),
    defaults: { position: [0, 0.5, 0] },
    params: [
      { key: 'expression', label: msg('式'), type: 'text', default: 'sin((t*f + id/count*w)*360)', hint: 'sin((t*f + id/count*w)*360)' },
      { key: 'frequency', label: msg('周波数 f'), type: 'number', default: 1, min: 0, step: 0.1, digits: 2, unit: 'Hz' },
      { key: 'waves', label: msg('波の数 w'), type: 'number', default: 1, step: 0.1, digits: 2 },
    ],
    live: true,
    check: e => formula(String(e.params.expression ?? 'sin((t*f + id/count*w)*360)')).error,
    strength: c => evaluate(String(c.params.expression), {
      t: c.time, f: Number(c.params.frequency), w: Number(c.params.waves), id: c.index, count: c.count,
      x: c.world.x, y: c.world.y, z: c.world.z, rnd: c.random(),
    }),
  },
  {
    key: 'time', name: msg('タイム'), description: msg('時刻 (秒) に合わせて強くする (1 秒で値のぶんだけ。再生すると動く)'),
    defaults: { rotationDeg: 90 },
    live: true,
    strength: c => c.time,
  },
  {
    key: 'target', name: msg('ターゲット'), description: msg('クローンを、決めた場所 (地面の X・Z) へ向ける'),
    transform: false,
    params: [
      { key: 'x', label: msg('ターゲット X'), type: 'number', default: 0, step: 0.5, digits: 1 },
      { key: 'z', label: msg('ターゲット Z'), type: 'number', default: 5, step: 0.5, digits: 1 },
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
    key: 'delay', name: msg('ディレイ'), description: msg('MMD モデルのクローンを、1 つごとに遅らせて動かす'),
    transform: false,
    params: [{ key: 'frames', label: msg('遅れ'), type: 'number', default: 5, min: 0, max: MAX_DELAY_FRAMES, step: 1, unit: msg('フレーム') }],
    note: isModel => (isModel ? msg('ディレイは、再生すると効きます (元のモデルの動きを覚えて、遅れて写す)') : msg('ディレイは MMD モデルのクローナーで効きます')),
    apply: (p, _e, c) => { p.delay += Number(c.params.frames) * c.index * c.field; },
  },
  {
    key: 'shader', name: msg('シェーダー'), description: msg('ノイズの模様で強さを決める (場所でなめらかに変わる。速さを付けると流れる)'),
    defaults: { position: [0, 0.5, 0] },
    params: [
      { key: 'size', label: msg('大きさ'), type: 'number', default: 2, min: 0.01, step: 0.25, digits: 2 },
      { key: 'speed', label: msg('速さ'), type: 'number', default: 0.5, step: 0.1, digits: 2 },
      { key: 'seed', label: msg('シード'), type: 'number', default: 1, min: 0, step: 1 },
    ],
    live: true,
    strength: c => { const s = N(c.params.size) || 1, t = N(c.params.speed) * c.time; return noise3(c.world.x / s + t, c.world.y / s, c.world.z / s - t * 0.5, N(c.params.seed)); },
  },
  {
    key: 'pushapart', name: msg('プッシュアパート'), description: msg('近すぎるクローンどうしを、半径の距離まで押し離す'),
    transform: false,
    params: [
      { key: 'radius', label: msg('半径'), type: 'number', default: 1, min: 0, step: 0.1, digits: 2 },
      { key: 'iterations', label: msg('くり返し'), type: 'number', default: 8, min: 1, max: 50, step: 1 },
    ],
    applyAll: (out, _e, cs) => {
      const r = N(cs[0]?.params.radius), it = Math.min(Math.max(Math.round(N(cs[0]?.params.iterations)), 1), 50);
      for (let k = 0; k < it; k++) {
        for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
          const a = out[i], b = out[j];
          const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
          if (d >= r) continue;
          // 離す向き (同じ場所なら、番号で決まる横の向き)
          const g = (i * 7 + j * 13) % 360 * Math.PI / 180;
          const [dx, dy, dz] = d < 1e-6 ? [Math.cos(g), 0, Math.sin(g)] : [(b.x - a.x) / d, (b.y - a.y) / d, (b.z - a.z) / d];
          const push = (r - d) / 2;
          const wa = cs[i].field, wb = cs[j].field;
          a.x -= dx * push * wa; a.y -= dy * push * wa; a.z -= dz * push * wa;
          b.x += dx * push * wb; b.y += dy * push * wb; b.z += dz * push * wb;
        }
      }
    },
  },
  {
    key: 'volume', name: msg('ボリューム'), description: msg('選んだ物の中 (その物の箱の中) にあるクローンだけに効く'),
    params: [{ key: 'target', label: msg('物'), type: 'object', default: 0 }],
    defaults: { scale: 0.5 },
    live: true,
    applyAll: (out, e, cs) => {
      const b = deps.bounds(N(cs[0]?.params.target));
      if (!b) return;
      out.forEach((p, i) => {
        const w = cs[i].world, inside = w.x >= b.min.x && w.x <= b.max.x && w.y >= b.min.y - 1e-3 && w.y <= b.max.y && w.z >= b.min.z && w.z <= b.max.z;
        if (inside && cs[i].field) addTransform(p, e, cs[i].field);
      });
    },
  },
  {
    key: 'inheritance', name: msg('継承'), description: msg('ほかのクローナーのクローンの置き場所・向き・大きさへ近づける (番号ごと)'),
    transform: false,
    params: [{ key: 'target', label: msg('クローナー'), type: 'object', default: 0 }],
    live: true,
    applyAll: (out, _e, cs) => {
      const from = deps.worldLayout(N(cs[0]?.params.target));
      if (!from.length) return;
      out.forEach((p, i) => {
        const w = cs[i].field, t = from[i % from.length], o = cs[i].origin;
        if (!w) return;
        // 場面での置き場所を、このクローナーから見た置き場所に直す
        const dx = t.x - o.x, dz = t.z - o.z, c = Math.cos(o.r), s = Math.sin(o.r);
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        p.x += (lx - p.x) * w; p.y += (t.y - o.y - p.y) * w; p.z += (lz - p.z) * w;
        const dr = Math.atan2(Math.sin(t.ry - o.r - p.ry), Math.cos(t.ry - o.r - p.ry));
        p.ry += dr * w;
        p.scale += (t.scale - p.scale) * w;
      });
    },
  },
  {
    key: 'sound', name: msg('サウンド'), description: msg('読み込んだ曲の大きさで強さを決める (クローンごとに低い音から高い音の帯を受け持つか、全体の大きさ)'),
    defaults: { position: [0, 1, 0] },
    params: [
      { key: 'mode', label: msg('受け持ち'), type: 'select', default: 'bands', options: [{ value: 'bands', label: msg('クローンごとに帯域') }, { value: 'all', label: msg('全体の大きさ') }] },
      { key: 'gain', label: msg('強さ'), type: 'number', default: 1, min: 0, step: 0.1, digits: 2 },
    ],
    live: true,
    note: () => (deps.hasSound() ? '' : msg('サウンドは、曲を読み込むと効きます (ファイル > MMD を読み込む… で曲を選ぶ)')),
    strength: c => N(c.params.gain) * (c.params.mode === 'all' ? deps.sound(c.time) : deps.sound(c.time, Math.min(Math.floor(c.index * BANDS / Math.max(c.count, 1)), BANDS - 1))),
  },
];
export const EFFECTORS = makeEffectors();
const mograph: AddonModule = {
  id: 'mograph',
  name: msg('MoGraph エフェクタ'),
  version: '1.0.0',
  author: 'webgl-grid',
  category: 'MoGraph',
  description: msg('Cinema 4D のエフェクタ: プレーン・ステップ・ランダム・フォーミュラ (式)・タイム・ターゲット・ディレイ・シェーダー・プッシュアパート・ボリューム・継承・サウンド。クローナーのパネルの「エフェクタ」から足します。'),
  enabledByDefault: true,
  requires: ['cinema4d'],
  register(api) {
    const c4d = api.require<Cinema4d>('cinema4d');
    const { engine } = api;
    // 曲の大きさ (曲を読み込んだら、一度だけ調べる)
    let levels: SoundLevels | null = null, analyzed: File | null = null;
    const analyzeSong = () => {
      const f = engine.music.file;
      if (f === analyzed) return;
      analyzed = f;
      levels = null;
      if (f) void analyzeFile(f).then(l => { if (analyzed === f) { levels = l; engine.viewport.requestDraw(); api.refresh(); } });
    };
    analyzeSong();
    const offMusic = engine.music.events.on('loaded', analyzeSong);
    // 継承が、お互いを継承しているクローナーで回り続けないように
    let depth = 0;
    const deps: EffectorDeps = {
      bounds: id => {
        const o = id ? engine.world.find(id) : null;
        if (!o) return null;
        const b = new THREE.Box3().setFromObject(o.node);
        return b.isEmpty() ? null : { min: b.min, max: b.max };
      },
      worldLayout: id => {
        const o = id ? engine.world.find(id) : null;
        if (!o || depth > 2) return [];
        depth++;
        try { return c4d.worldLayout(o); } finally { depth--; }
      },
      sound: (t, band) => { if (engine.music.file !== analyzed) analyzeSong(); return levelAt(levels, t, band); },
      hasSound: () => !!engine.music.file,
    };
    const offs = makeEffectors(deps).map(def => c4d.addEffector(def));
    return () => { offMusic(); for (const off of offs) off(); };
  },
};
export default mograph;
