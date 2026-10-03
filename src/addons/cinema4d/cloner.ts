import { msg } from '../../core/i18n';
import { int, num, vec3 as vec } from '../../core/normalize';
import { seededRandom } from '../../core/random';
import { applyEffectors, paramsOf, type EffectorValue, type LayoutEnv } from './effectors';

// --- クローナー (Cinema 4D のクローナー): 物を直線・放射・グリッドに並べる ---
// 並べる場所は、元の物 (クローナー) の位置と向きから見た座標。元の物を動かす・回すと、クローンも一緒に動く
// 並べ方: 直線・放射・グリッドと、アドオンが足したもの (effectors.ts の ClonerModeDef)
export type ClonerMode = string;
export type Vec3 = [number, number, number];
// エフェクタ (Cinema 4D の MoGraph エフェクタ)。上から順にかける。種類 (kind) は、アドオンが登録する (effectors.ts)
export interface Effector {
  kind: string;
  enabled: boolean;
  position: Vec3;      // ずらす量
  rotationDeg: number; // 縦軸まわりの回転 (度)
  scale: number;       // 大きさ (1 でそのまま)
  params: Record<string, EffectorValue>; // 種類ごとの設定 (ディレイの遅れ・ランダムのシードなど)
  select: string;        // MoGraph 選択: 効くクローンの番号 ("0-4, 7"・"偶数"・"奇数"。空なら全部)
  fields: FieldLayer[];  // フィールド (効く範囲。上から重ねる。なければ全体に効く)
}
// フィールドの層
export interface FieldLayer {
  kind: string;
  enabled: boolean;
  blend: 'normal' | 'max' | 'min' | 'add' | 'subtract' | 'multiply';
  opacity: number;  // 0〜1
  invert: boolean;
  params: Record<string, EffectorValue>;
}
export const MAX_DELAY_FRAMES = 300; // ディレイで遅らせられる長さ (覚えておく姿勢の数)
export interface ClonerSettings {
  mode: ClonerMode;
  count: number;          // 直線・放射の数
  step: Vec3;             // 直線: 1 つごとのずれ
  stepRotDeg: number;     // 直線: 1 つごとの、縦軸まわりの回転 (度)
  radius: number;         // 放射: 半径
  startDeg: number;       // 放射: 並べる角度の範囲 (0° が奥 (+Z)、90° が右 (+X))
  endDeg: number;
  align: boolean;         // 放射: 外を向く
  grid: Vec3;             // グリッド: X・Y・Z の数
  spacing: Vec3;          // グリッド: 間隔
  random: { position: number; rotationDeg: number; seed: number }; // ばらつき (Cinema 4D のランダム・エフェクタ)
  modeParams: Record<string, EffectorValue>; // アドオンが足した並べ方の設定
  effectors: Effector[];
}
// クローン 1 つの置き場所 (元の物から見た位置と、縦軸まわりの回転 (ラジアン))・大きさ・遅れ (フレーム)
export interface Placement { x: number; y: number; z: number; ry: number; scale: number; delay: number }

export const CLONER_MODES: { key: ClonerMode; name: string }[] = [
  { key: 'linear', name: msg('直線') }, { key: 'radial', name: msg('放射') }, { key: 'grid', name: msg('グリッド') },
];
export const CLONER_DEFAULT: ClonerSettings = {
  mode: 'grid', count: 5, step: [1.5, 0, 0], stepRotDeg: 0,
  radius: 3, startDeg: 0, endDeg: 360, align: true,
  grid: [3, 1, 3], spacing: [1.5, 1.2, 1.5],
  random: { position: 0, rotationDeg: 0, seed: 1 },
  modeParams: {},
  effectors: [],
};
// 数の上限 (MMD モデルは 1 つずつ骨を動かして描くので少なめ)
export const MAX_CLONES = { shape: 400, model: 25 };

// エフェクタの設定をそろえる (知らない種類も残す。前の版のディレイの frames は params に)
const KIND = /^[a-z][a-z0-9_.-]{0,40}$/;
const isKind = (k: unknown): k is string => typeof k === 'string' && KIND.test(k);
// 種類ごとの設定 (数・真偽・文字だけ。文字は 2000 字まで)
function normalizeParams(o: unknown) {
  const params: Record<string, EffectorValue> = {};
  for (const [k, v] of Object.entries(o && typeof o === 'object' ? o : {})) {
    if (Object.keys(params).length >= 32) break;
    if (typeof v === 'number' && Number.isFinite(v) || typeof v === 'boolean') params[k] = v;
    else if (typeof v === 'string') params[k] = v.slice(0, 2000);
  }
  return params;
}
const BLENDS = ['normal', 'max', 'min', 'add', 'subtract', 'multiply'] as const;
function normalizeField(l: Partial<FieldLayer>): FieldLayer {
  return {
    kind: l.kind!, enabled: l.enabled !== false, blend: BLENDS.includes(l.blend!) ? l.blend! : 'normal',
    opacity: num(l.opacity, 1, 0, 1), invert: l.invert === true, params: normalizeParams(l.params),
  };
}
function normalizeEffector(e: Partial<Effector> & { frames?: unknown }): Effector {
  const params = normalizeParams(e.params);
  if (typeof e.frames === 'number' && params.frames === undefined) params.frames = Math.min(Math.max(e.frames, 0), MAX_DELAY_FRAMES);
  return {
    kind: e.kind!, enabled: e.enabled !== false, position: vec(e.position, [0, 0, 0]), rotationDeg: num(e.rotationDeg, 0),
    scale: num(e.scale, 1, 0.01, 100), params, select: typeof e.select === 'string' ? e.select.slice(0, 200) : '',
    fields: (Array.isArray(e.fields) ? e.fields : []).filter(l => isKind(l?.kind)).slice(0, 16).map(normalizeField),
  };
}

// エフェクタの並びをそろえる (ほかの MoGraph の物でも使う)
export const normalizeEffectors = (list: unknown): Effector[] => (Array.isArray(list) ? list : []).filter(e => isKind(e?.kind)).slice(0, 16).map(normalizeEffector);

// 保存されていた・外から渡された設定を、使える値にそろえる
export function normalizeCloner(s: Partial<ClonerSettings> | undefined): ClonerSettings {
  const d = CLONER_DEFAULT, o = s ?? {};
  const r: Partial<ClonerSettings['random']> = o.random ?? {};
  return {
    mode: isKind(o.mode) ? o.mode : d.mode,
    count: int(o.count, d.count, 1, MAX_CLONES.shape),
    step: vec(o.step, d.step), stepRotDeg: num(o.stepRotDeg, d.stepRotDeg),
    radius: num(o.radius, d.radius, 0), startDeg: num(o.startDeg, d.startDeg), endDeg: num(o.endDeg, d.endDeg),
    align: typeof o.align === 'boolean' ? o.align : d.align,
    grid: vec(o.grid, d.grid).map(n => int(n, 1, 1, 50)) as Vec3, spacing: vec(o.spacing, d.spacing),
    random: { position: num(r.position, 0, 0), rotationDeg: num(r.rotationDeg, 0, 0), seed: int(r.seed, 1, 0, 1e9) },
    modeParams: normalizeParams(o.modeParams),
    effectors: normalizeEffectors(o.effectors),
  };
}

// クローンの数 (並べ方の設定から。上限で切る)
export function cloneCount(s: ClonerSettings, max: number) {
  const n = s.mode === 'grid' ? s.grid[0] * s.grid[1] * s.grid[2] : s.count;
  return Math.min(n, max);
}

// クローンの置き場所を、元の物 (底面の中心 x, z と向き r) の外から見た位置と向きにする
export function placeAround(p: Placement, x: number, z: number, r: number) {
  const c = Math.cos(r), s = Math.sin(r);
  return { x: x + p.x * c + p.z * s, z: z - p.x * s + p.z * c, r: r + p.ry };
}

// クローンの置き場所。max 個まで。env (登録されたエフェクタ・時刻・クローナーの位置) がなければ、エフェクタはかけない
export function clonerLayout(s: ClonerSettings, max: number, env?: LayoutEnv): Placement[] {
  const out: Placement[] = [];
  const D = Math.PI / 180;
  if (s.mode === 'linear') {
    for (let i = 0; i < s.count && out.length < max; i++) out.push({ x: s.step[0] * i, y: s.step[1] * i, z: s.step[2] * i, ry: s.stepRotDeg * D * i, scale: 1, delay: 0 });
  } else if (s.mode === 'radial') {
    const span = s.endDeg - s.startDeg;
    // 一周なら端と端が重ならないよう count 等分、そうでなければ両端を含めて並べる
    const full = Math.abs(Math.abs(span) - 360) < 1e-6;
    const d = s.count > 1 ? span / (full ? s.count : s.count - 1) : 0;
    for (let i = 0; i < s.count && out.length < max; i++) {
      const a = (s.startDeg + d * i) * D;
      out.push({ x: Math.sin(a) * s.radius, y: 0, z: Math.cos(a) * s.radius, ry: s.align ? a : 0, scale: 1, delay: 0 });
    }
  } else if (s.mode !== 'grid') {
    // アドオンが足した並べ方 (登録されていなければ並べない)
    const def = env?.mode?.(s.mode);
    if (def) out.push(...def.layout(paramsOf(def.params, s.modeParams), max, env!.origin).slice(0, max));
  } else {
    // グリッド: 横 (X・Z) は元の物を真ん中に、縦 (Y) は地面から上へ
    const [nx, ny, nz] = s.grid, [sx, sy, sz] = s.spacing;
    for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      if (out.length >= max) break;
      out.push({ x: (i - (nx - 1) / 2) * sx, y: j * sy, z: (k - (nz - 1) / 2) * sz, ry: 0, scale: 1, delay: 0 });
    }
  }
  const { position, rotationDeg, seed } = s.random;
  if (position || rotationDeg) {
    const rnd = seededRandom(seed);
    for (const p of out) {
      p.x += (rnd() * 2 - 1) * position;
      p.z += (rnd() * 2 - 1) * position;
      p.ry += (rnd() * 2 - 1) * rotationDeg * D;
    }
  }
  // エフェクタ (上から順に。登録されている種類だけ)
  if (env) applyEffectors(out, s.effectors, env);
  return out;
}
