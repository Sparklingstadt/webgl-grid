import type { Effector, Placement, Vec3 } from './cloner';

// --- エフェクタ (Cinema 4D の MoGraph エフェクタ) の登録口 ---
// エフェクタの種類は、ほかのアドオン (MoGraph エフェクタ) が Cinema4d.addEffector で登録する。
// クローナーは、並べたクローンの置き場所に、エフェクタを上から順にかける。登録されていない種類 (アドオンを切った) は飛ばす (設定は残す)。
// どのエフェクタにも、Cinema 4D の「パラメータ」タブと同じ、位置・回転・大きさがある (transform: false なら使わない)
export type EffectorValue = number | boolean | string;
export interface EffectorParam {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'select';
  default: EffectorValue;
  min?: number; max?: number; step?: number; digits?: number; unit?: string;
  options?: { value: string; label: string }[];
}
// 1 つのクローンにかけるときに渡すもの
export interface EffectorContext {
  index: number;  // クローンの番号 (0 から)
  count: number;  // クローンの数
  time: number;   // タイムラインの時刻 (秒)
  origin: { x: number; z: number; r: number }; // クローナー (元の物) の位置と向き
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
  live?: boolean;       // 時刻・クローナーの位置で変わる (描くたびに並べ直す)
  note?(isModel: boolean): string; // パネルに出す注意 (MMD モデルのクローナーか)
  // 強さ (既定 1)。位置・回転・大きさに掛けて足す
  strength?(ctx: EffectorContext): number;
  // 自分でかける (strength の代わり)
  apply?(p: Placement, e: Effector, ctx: EffectorContext): void;
}
// 並べるときに使うもの (登録されたエフェクタ・時刻・クローナーの位置)
export interface LayoutEnv {
  effector(kind: string): EffectorDef | undefined;
  time: number;
  origin: { x: number; z: number; r: number };
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

// 新しいエフェクタ (種類の既定の値で)
export const newEffector = (def: EffectorDef): Effector => ({
  kind: def.key, enabled: true,
  position: [...(def.defaults?.position ?? [0, 0, 0])] as Vec3, rotationDeg: def.defaults?.rotationDeg ?? 0, scale: def.defaults?.scale ?? 1,
  params: Object.fromEntries((def.params ?? []).map(p => [p.key, p.default])),
});
// 設定のない値は、種類の既定の値で
export const paramOf = (def: EffectorDef, e: Effector, key: string) => e.params[key] ?? def.params?.find(p => p.key === key)?.default;

// 同じシードなら同じ値 (エフェクタの番号・クローンの番号・シードから)
function hashRandom(...n: number[]) {
  let h = 0x811c9dc5;
  for (const v of n) { h ^= v >>> 0; h = Math.imul(h, 0x01000193); h ^= h >>> 13; }
  return () => { h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
}

// クローンの置き場所に、エフェクタを上から順にかける
export function applyEffectors(out: Placement[], effectors: Effector[], env: LayoutEnv) {
  effectors.forEach((e, k) => {
    const def = e.enabled ? env.effector(e.kind) : undefined;
    if (!def) return;
    const params = Object.fromEntries((def.params ?? []).map(p => [p.key, paramOf(def, e, p.key)!]));
    const seed = Number(params.seed ?? 0);
    out.forEach((p, i) => {
      const ctx: EffectorContext = { index: i, count: out.length, time: env.time, origin: env.origin, params, random: hashRandom(k, i, seed) };
      if (def.apply) def.apply(p, e, ctx);
      else addTransform(p, e, def.strength ? def.strength(ctx) : 1);
    });
  });
}
// 描くたびに並べ直すエフェクタがあるか
export const hasLive = (effectors: Effector[], env: Pick<LayoutEnv, 'effector'>) => effectors.some(e => e.enabled && env.effector(e.kind)?.live);
