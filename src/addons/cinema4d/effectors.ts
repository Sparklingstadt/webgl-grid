import type { Effector, FieldLayer, Placement, Vec3 } from './cloner';

// --- MoGraph の登録口: エフェクタ・フィールド・クローナーの並べ方 ---
// 種類は、ほかのアドオン (MoGraph エフェクタ・フィールド・配置) が Cinema4d.addEffector・addField・addClonerMode で登録する。
// クローナーは、並べたクローンの置き場所に、エフェクタを上から順にかける。登録されていない種類 (アドオンを切った) は飛ばす (設定は残す)。
// どのエフェクタにも、Cinema 4D の「パラメータ」タブと同じ、位置・回転・大きさがある (transform: false なら使わない)。
// エフェクタの強さは、フィールド (効く範囲) と MoGraph 選択 (効くクローン) で決まる
export type EffectorValue = number | boolean | string;
export interface EffectorParam {
  key: string;
  label: string;
  // number・boolean・select (options から)・text (文字)・object (場面の物の id。0 はなし)
  type: 'number' | 'boolean' | 'select' | 'text' | 'object';
  default: EffectorValue;
  min?: number; max?: number; step?: number; digits?: number; unit?: string;
  options?: { value: string; label: string }[];
  hint?: string; // 欄の説明
}
export interface Point3 { x: number; y: number; z: number }
// クローナー (元の物) の位置 (底面の中心) と向き
export interface Origin { x: number; y: number; z: number; r: number }

// 1 つのクローンにかけるときに渡すもの
export interface EffectorContext {
  index: number;  // クローンの番号 (0 から)
  count: number;  // クローンの数
  time: number;   // タイムラインの時刻 (秒)
  origin: Origin;
  world: Point3;  // クローンの場面での位置 (このエフェクタをかける前)
  field: number;  // フィールドと MoGraph 選択で決まる強さ (0〜1。フィールドがなければ 1)
  params: Record<string, EffectorValue>;
  random(): number; // このエフェクタの、このクローンの乱数 (0〜1。シードで決まる)
}
export interface EffectorDef {
  key: string;   // 種類 (保存するときの名前)
  name: string;
  description?: string;
  transform?: boolean;  // 位置・回転・大きさを使う (既定は使う)
  defaults?: { position?: Vec3; rotationDeg?: number; scale?: number };
  params?: EffectorParam[];
  live?: boolean | ((e: Effector) => boolean); // 時刻・物の位置で変わる (描くたびに並べ直す)
  note?(isModel: boolean): string; // パネルに出す注意 (MMD モデルのクローナーか)
  check?(e: Effector): string | null; // 設定のまちがい (式が読めないなど。パネルに出す)
  // 強さ (既定 1)。フィールドの強さを掛けて、位置・回転・大きさに足す
  strength?(ctx: EffectorContext): number;
  // 自分でかける (strength の代わり。ctx.field を自分で使う)
  apply?(p: Placement, e: Effector, ctx: EffectorContext): void;
  // 全部のクローンを見てかける (プッシュアパートなど。ctxs はクローンごと)
  applyAll?(out: Placement[], e: Effector, ctxs: EffectorContext[]): void;
}

// フィールド (Cinema 4D のフィールド): 場面の位置 (と時刻) ごとの値 0〜1。エフェクタの効く範囲を決める
export interface FieldContext { index: number; count: number; time: number; params: Record<string, EffectorValue>; random(): number }
export interface FieldDef {
  key: string;
  name: string;
  description?: string;
  params?: EffectorParam[];
  live?: boolean; // 時刻で変わる
  value(pos: Point3, ctx: FieldContext): number;
  // ビューポートに出す枠 (場所を持つフィールド)。size: 球は [半径]、円柱は [半径, 高さ]、ボックスは [幅, 高さ, 奥行き]
  gizmo?(params: Record<string, EffectorValue>): FieldGizmo | null;
}
export interface FieldGizmo { shape: 'sphere' | 'box' | 'cylinder' | 'plane'; center: [number, number, number]; size: number[]; inner?: number; axis?: 'x' | 'y' | 'z' }
// フィールドの重ね方 (Cinema 4D のブレンドモード)
export const FIELD_BLENDS: { value: FieldLayer['blend']; label: string }[] = [
  { value: 'normal', label: '標準' }, { value: 'max', label: '最大' }, { value: 'min', label: '最小' },
  { value: 'add', label: '加算' }, { value: 'subtract', label: '減算' }, { value: 'multiply', label: '乗算' },
];

// クローナーの並べ方 (直線・放射・グリッドのほかに、アドオンが足すもの)
export interface ClonerModeDef {
  key: string;
  name: string;
  description?: string;
  params?: EffectorParam[];
  live?: boolean; // 物の位置で変わる (オブジェクトに並べるなど)
  layout(params: Record<string, EffectorValue>, max: number, origin: Origin): Placement[];
}

// 並べるときに使うもの (登録されたエフェクタ・フィールド・並べ方・時刻・クローナーの位置)
export interface LayoutEnv {
  effector(kind: string): EffectorDef | undefined;
  field?(kind: string): FieldDef | undefined;
  mode?(kind: string): ClonerModeDef | undefined;
  time: number;
  origin: Origin;
}

const D = Math.PI / 180;
// 位置・回転・大きさを、強さ w (と、軸ごとの強さ) で足す
export function addTransform(p: Placement, e: Effector, w: number, wp: Vec3 = [w, w, w]) {
  p.x += e.position[0] * wp[0];
  p.y += e.position[1] * wp[1];
  p.z += e.position[2] * wp[2];
  p.ry += e.rotationDeg * D * w;
  p.scale *= Math.max(1 + (e.scale - 1) * w, 0);
}

// 種類ごとの設定の既定の値
export const defaultParams = (params: EffectorParam[] | undefined) => Object.fromEntries((params ?? []).map(p => [p.key, p.default]));
// 設定のない値は、種類の既定の値で
export const paramsOf = (defs: EffectorParam[] | undefined, set: Record<string, EffectorValue>) => ({ ...defaultParams(defs), ...set });
export const paramOf = (def: EffectorDef, e: Effector, key: string) => e.params[key] ?? def.params?.find(p => p.key === key)?.default;

// 新しいエフェクタ・フィールドの層 (種類の既定の値で)
export const newEffector = (def: EffectorDef): Effector => ({
  kind: def.key, enabled: true,
  position: [...(def.defaults?.position ?? [0, 0, 0])] as Vec3, rotationDeg: def.defaults?.rotationDeg ?? 0, scale: def.defaults?.scale ?? 1,
  params: defaultParams(def.params), select: '', fields: [],
});
export const newFieldLayer = (def: FieldDef): FieldLayer => ({ kind: def.key, enabled: true, blend: 'normal', opacity: 1, invert: false, params: defaultParams(def.params) });

// 同じシードなら同じ値
export function hashRandom(...n: number[]) {
  let h = 0x811c9dc5;
  for (const v of n) { h ^= Math.floor(v) >>> 0; h = Math.imul(h, 0x01000193); h ^= h >>> 13; }
  return () => { h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
}

// MoGraph 選択: "0-4, 7, 9-" のように番号を選ぶ (空なら全部)。"偶数"・"奇数" も使える
export function parseSelection(text: string, count: number): ((i: number) => boolean) | null {
  const t = text.trim();
  if (!t) return null;
  if (t === '偶数' || t === 'even') return i => i % 2 === 0;
  if (t === '奇数' || t === 'odd') return i => i % 2 === 1;
  const ranges: [number, number][] = [];
  for (const part of t.split(/[,、\s]+/)) {
    const m = /^(\d*)\s*[-~〜]\s*(\d*)$/.exec(part);
    if (m) ranges.push([m[1] ? +m[1] : 0, m[2] ? +m[2] : count - 1]);
    else if (/^\d+$/.test(part)) ranges.push([+part, +part]);
  }
  return i => ranges.some(([a, b]) => i >= a && i <= b);
}

// クローンの場面での位置
export function worldOf(p: Placement, o: Origin): Point3 {
  const c = Math.cos(o.r), s = Math.sin(o.r);
  return { x: o.x + p.x * c + p.z * s, y: o.y + p.y, z: o.z - p.x * s + p.z * c };
}

// フィールドの層を重ねた値 (層がなければ 1)
export function fieldValue(layers: FieldLayer[], pos: Point3, env: LayoutEnv, index: number, count: number, salt: number) {
  const on = layers.filter(l => l.enabled && env.field?.(l.kind));
  if (!on.length) return 1;
  let v = 0;
  on.forEach((l, k) => {
    const def = env.field!(l.kind)!;
    let f = Math.min(Math.max(def.value(pos, { index, count, time: env.time, params: paramsOf(def.params, l.params), random: hashRandom(salt, k, index, Number(l.params.seed ?? 0)) }), 0), 1);
    if (l.invert) f = 1 - f;
    const mixed = l.blend === 'max' ? Math.max(v, f) : l.blend === 'min' ? Math.min(v, f) : l.blend === 'add' ? v + f
      : l.blend === 'subtract' ? v - f : l.blend === 'multiply' ? v * f : f;
    v += (mixed - v) * l.opacity;
  });
  return Math.min(Math.max(v, 0), 1);
}

// クローンの置き場所に、エフェクタを上から順にかける
export function applyEffectors(out: Placement[], effectors: Effector[], env: LayoutEnv) {
  effectors.forEach((e, k) => {
    const def = e.enabled ? env.effector(e.kind) : undefined;
    if (!def) return;
    const params = paramsOf(def.params, e.params);
    const seed = Number(params.seed ?? 0);
    const picked = parseSelection(e.select, out.length);
    const ctxs = out.map((p, i): EffectorContext => {
      const world = worldOf(p, env.origin);
      const field = picked && !picked(i) ? 0 : fieldValue(e.fields, world, env, i, out.length, k);
      return { index: i, count: out.length, time: env.time, origin: env.origin, world, field, params, random: hashRandom(k, i, seed) };
    });
    if (def.applyAll) { def.applyAll(out, e, ctxs); return; }
    out.forEach((p, i) => {
      const ctx = ctxs[i];
      if (def.apply) def.apply(p, e, ctx);
      else if (ctx.field) addTransform(p, e, (def.strength ? def.strength(ctx) : 1) * ctx.field);
    });
  });
}
// 描くたびに並べ直すもの (時刻・物の位置で変わるエフェクタ・フィールド) があるか
export const hasLive = (effectors: Effector[], env: Pick<LayoutEnv, 'effector' | 'field'>) => effectors.some(e => {
  const def = e.enabled ? env.effector(e.kind) : undefined;
  if (!def) return false;
  if (typeof def.live === 'function' ? def.live(e) : def.live) return true;
  return e.fields.some(l => l.enabled && env.field?.(l.kind)); // (フィールドは場面に置くので、クローナーを動かすと変わる)
});
