import * as THREE from 'three';
import { DEG } from './constants';
import { msg } from './i18n';
import { ZERO_BONE, type BoneValue } from './types';

// --- キーフレームのアニメーション (ボーン・表情・物のチャンネルごと) ---
// チャンネル (ボーン 1 本・表情 1 つ・物の位置 X など 1 つ) ごとに、フレーム → キー を持つ。
// キーには、1 つ前のキーからこのキーまでのつなぎ方 (補間曲線) を持たせる (MMD と同じく、行き先のキーに付ける)。
// 補間曲線は (0,0)-(x1,y1)-(x2,y2)-(1,1) の 3 次ベジェ曲線で、横が時間・縦が進み具合 (0〜1)
export type Curve = [x1: number, y1: number, x2: number, y2: number];
export const LINEAR: Curve = [0.25, 0.25, 0.75, 0.75];
export const CURVE_PRESETS: { name: string; curve: Curve }[] = [
  { name: msg('直線'), curve: LINEAR },
  { name: msg('なめらか'), curve: [0.42, 0, 0.58, 1] },
  { name: msg('ゆっくり始まる'), curve: [0.42, 0, 1, 1] },
  { name: msg('ゆっくり終わる'), curve: [0, 0, 0.58, 1] },
];

export interface BoneKey { v: BoneValue; curve: Curve }
export interface MorphKey { v: number; curve: Curve }
export interface Animation {
  bones: Map<number, Map<number, BoneKey>>;  // ボーンの番号 → フレーム → キー
  morphs: Map<number, Map<number, MorphKey>>; // 表情の番号 → フレーム → キー
  props: Map<number, Map<number, MorphKey>>;  // 物の値 (PROPS の番号: 位置 X・位置 Z・回転・大きさ) → フレーム → キー
}
export type Channel = { kind: 'bone' | 'morph' | 'prop'; index: number };
// 物 (形・ライト) のキーにする値 (Blender の位置・回転・拡大縮小)。回転はラジアン
export const PROPS = [
  { key: 'x', name: msg('位置 X') },
  { key: 'z', name: msg('位置 Z') },
  { key: 'r', name: msg('回転') },
  { key: 'scale', name: msg('大きさ') },
] as const;
export type PropKey = typeof PROPS[number]['key'];

export const createAnimation = (): Animation => ({ bones: new Map(), morphs: new Map(), props: new Map() });
export const isEmpty = (a: Animation | null | undefined) => !a || (!a.bones.size && !a.morphs.size && !a.props.size);
const mapsOf = (a: Animation) => [a.bones, a.morphs, a.props] as Map<number, Map<number, unknown>>[];
const mapOf = (a: Animation, kind: Channel['kind']) => (kind === 'bone' ? a.bones : kind === 'morph' ? a.morphs : a.props) as Map<number, Map<number, unknown>>;

// 補間曲線の、時間 x (0〜1) のときの進み具合
export function curveAt([x1, y1, x2, y2]: Curve, x: number) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bez = (a: number, b: number, t: number) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  // 横の値が x になる t を二分法で探す (横は t について単調に増える)
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (bez(x1, x2, mid) < x) lo = mid; else hi = mid;
  }
  return bez(y1, y2, (lo + hi) / 2);
}

// --- 補間 ---
// フレーム f の前後のキーから値を求める。最初のキーより前・最後より後は、そのキーの値のまま
function around<K>(keys: Map<number, K>, f: number): [number, K, number, K] | null {
  let f0 = -Infinity, f1 = Infinity;
  for (const k of keys.keys()) {
    if (k <= f && k > f0) f0 = k;
    if (k > f && k < f1) f1 = k;
  }
  if (f0 === -Infinity && f1 === Infinity) return null;
  if (f0 === -Infinity) f0 = f1;
  if (f1 === Infinity) f1 = f0;
  return [f0, keys.get(f0)!, f1, keys.get(f1)!];
}
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _e = new THREE.Euler();

export function evaluate(anim: Animation, f: number): { pose: Map<number, BoneValue>; morphs: Map<number, number>; props: Map<number, number> } {
  const pose = new Map<number, BoneValue>();
  for (const [bone, keys] of anim.bones) {
    const r = around(keys, f);
    if (!r) continue;
    const [f0, k0, f1, k1] = r;
    const s = f1 > f0 ? curveAt(k1.curve, (f - f0) / (f1 - f0)) : 0;
    const a = k0.v, c = k1.v;
    _qa.setFromEuler(_e.set(a.rx * DEG, a.ry * DEG, a.rz * DEG, 'YXZ'));
    _qb.setFromEuler(_e.set(c.rx * DEG, c.ry * DEG, c.rz * DEG, 'YXZ'));
    _e.setFromQuaternion(_qa.slerp(_qb, s), 'YXZ');
    pose.set(bone, {
      // (+ 0 で -0 を 0 にする。保存して開き直したときと同じ値にするため)
      rx: _e.x / DEG + 0, ry: _e.y / DEG + 0, rz: _e.z / DEG + 0,
      px: a.px + (c.px - a.px) * s, py: a.py + (c.py - a.py) * s, pz: a.pz + (c.pz - a.pz) * s,
    });
  }
  const morphs = new Map<number, number>();
  for (const [m, keys] of anim.morphs) {
    const r = around(keys, f);
    if (!r) continue;
    const [f0, k0, f1, k1] = r;
    const s = f1 > f0 ? curveAt(k1.curve, (f - f0) / (f1 - f0)) : 0;
    morphs.set(m, k0.v + (k1.v - k0.v) * s);
  }
  const props = new Map<number, number>();
  for (const [p, keys] of anim.props) {
    const r = around(keys, f);
    if (!r) continue;
    const [f0, k0, f1, k1] = r;
    const s = f1 > f0 ? curveAt(k1.curve, (f - f0) / (f1 - f0)) : 0;
    props.set(p, k0.v + (k1.v - k0.v) * s);
  }
  return { pose, morphs, props };
}

// --- 編集 ---
// フレーム frame にキーを打つ。ボーンは pose にあるもの (手で動かした・すでにチャンネルがある)、
// 表情は 0 でないものと、すでにチャンネルがあるもの。only を渡すと、そのボーンだけ。
// すでにキーがあれば値だけ替え、補間曲線はそのまま。打ったチャンネルの数を返す。
// 新しく作るチャンネルは、それより前にほかのキーがあれば、最初のキーのフレームに最初の姿勢 (0) のキーも置く
// (MMD と同じく、キーを打つまでは最初の姿勢だったものとして、そこからつなぐ)
export function insertKeys(anim: Animation, frame: number, pose: Map<number, BoneValue>, morphs: ArrayLike<number> | null, only?: number[]) {
  let n = 0;
  const first = keyFrames(anim)[0];
  const put = <K extends { curve: Curve }>(map: Map<number, Map<number, K>>, ch: number, make: (curve: Curve) => K, rest: () => K) => {
    let keys = map.get(ch);
    if (!keys) {
      map.set(ch, keys = new Map());
      if (first !== undefined && first < frame) keys.set(first, rest());
    }
    keys.set(frame, make(keys.get(frame)?.curve ?? LINEAR));
    n++;
  };
  const bones = only ?? [...new Set([...pose.keys(), ...anim.bones.keys()])];
  for (const b of bones) put(anim.bones, b, curve => ({ v: { ...(pose.get(b) ?? ZERO_BONE) }, curve: [...curve] as Curve }), () => ({ v: { ...ZERO_BONE }, curve: [...LINEAR] as Curve }));
  if (morphs && !only) {
    for (let m = 0; m < morphs.length; m++) {
      if (morphs[m] !== 0 || anim.morphs.has(m)) put(anim.morphs, m, curve => ({ v: morphs[m], curve: [...curve] as Curve }), () => ({ v: 0, curve: [...LINEAR] as Curve }));
    }
  }
  return n;
}
// 物の値 (values: PROPS の順) を、フレームに打つ。すでにキーがあれば値だけ替える。打ったチャンネルの数を返す
export function insertPropKeys(anim: Animation, frame: number, values: number[]) {
  values.forEach((v, p) => {
    let keys = anim.props.get(p);
    if (!keys) anim.props.set(p, keys = new Map());
    keys.set(frame, { v, curve: [...(keys.get(frame)?.curve ?? LINEAR)] as Curve });
  });
  return values.length;
}
// キーのあるフレーム (全チャンネルをまとめて)
export function keyFrames(anim: Animation | null | undefined): number[] {
  if (!anim) return [];
  const all = new Set<number>();
  for (const map of mapsOf(anim)) for (const keys of map.values()) for (const f of keys.keys()) all.add(f);
  return [...all].sort((a, b) => a - b);
}
export const channelKeys = (anim: Animation, ch: Channel) => mapOf(anim, ch.kind).get(ch.index) as Map<number, BoneKey | MorphKey> | undefined;
// frames のキーを、すべてのチャンネル (channel を渡せばそのチャンネルだけ) から消す。消した数を返す
export function deleteKeys(anim: Animation, frames: Iterable<number>, channel?: Channel) {
  let n = 0;
  const fs = [...frames];
  for (const map of mapsOf(anim)) {
    for (const [ch, keys] of map) {
      if (channel && (map !== mapOf(anim, channel.kind) || ch !== channel.index)) continue;
      for (const f of fs) if (keys.delete(f)) n++;
      if (!keys.size) map.delete(ch);
    }
  }
  return n;
}
// frames のキーを delta フレームずらす (重なった先は上書き)。ずらした先のフレームを返す
export function moveKeys(anim: Animation, frames: Iterable<number>, delta: number) {
  const fs = new Set(frames);
  for (const map of mapsOf(anim)) {
    for (const keys of map.values()) {
      const moving = [...keys].filter(([f]) => fs.has(f));
      for (const [f] of moving) keys.delete(f);
      for (const [f, k] of moving) keys.set(Math.max(0, f + delta), k);
    }
  }
  return [...fs].map(f => Math.max(0, f + delta));
}

// --- コピー・貼り付け (Ctrl+C・Ctrl+V) ---
// frames のキーを、チャンネルごとに写す (フレームは写したいちばん前のフレームからの差)
export interface ClipChannel { kind: Channel['kind']; index: number; keys: [number, BoneKey | MorphKey][] }
const cloneKey = <K extends BoneKey | MorphKey>(k: K): K => ({ v: typeof k.v === 'object' ? { ...k.v } : k.v, curve: [...k.curve] as Curve }) as K;
export function copyKeys(anim: Animation, frames: Iterable<number>): ClipChannel[] {
  const fs = new Set(frames), first = Math.min(...fs), out: ClipChannel[] = [];
  for (const kind of ['bone', 'morph', 'prop'] as const) {
    for (const [index, keys] of mapOf(anim, kind) as Map<number, Map<number, BoneKey | MorphKey>>) {
      const ks = [...keys].filter(([f]) => fs.has(f)).sort((a, b) => a[0] - b[0]).map(([f, k]) => [f - first, cloneKey(k)] as [number, BoneKey | MorphKey]);
      if (ks.length) out.push({ kind, index, keys: ks });
    }
  }
  return out;
}
// 写したキーを、フレーム at から貼る (重なったキーは上書き)。貼ったフレームを返す
export function pasteKeys(anim: Animation, clip: ClipChannel[], at: number): number[] {
  const frames = new Set<number>();
  for (const ch of clip) {
    const map = mapOf(anim, ch.kind) as Map<number, Map<number, BoneKey | MorphKey>>;
    const keys = map.get(ch.index) ?? new Map<number, BoneKey | MorphKey>();
    map.set(ch.index, keys);
    for (const [rel, k] of ch.keys) { const f = Math.max(0, at + rel); keys.set(f, cloneKey(k)); frames.add(f); }
  }
  return [...frames].sort((a, b) => a - b);
}

// --- 保存 (JSON にできる形) ---
export interface AnimationJson {
  bones: [number, [number, BoneValue, Curve][]][];
  morphs: [number, [number, number, Curve][]][];
  props?: [number, [number, number, Curve][]][]; // (物の値。前の版にはない)
}
export const animationToJson = (a: Animation): AnimationJson => ({
  bones: [...a.bones].map(([b, keys]) => [b, [...keys].map(([f, k]) => [f, { ...k.v }, [...k.curve] as Curve])]),
  morphs: [...a.morphs].map(([m, keys]) => [m, [...keys].map(([f, k]) => [f, k.v, [...k.curve] as Curve])]),
  ...(a.props.size ? { props: [...a.props].map(([p, keys]) => [p, [...keys].map(([f, k]) => [f, k.v, [...k.curve] as Curve])]) } : {}),
});
export const animationFromJson = (j: AnimationJson): Animation => ({
  bones: new Map(j.bones.map(([b, keys]) => [b, new Map(keys.map(([f, v, curve]) => [f, { v: { ...v }, curve: [...curve] as Curve }]))])),
  morphs: new Map(j.morphs.map(([m, keys]) => [m, new Map(keys.map(([f, v, curve]) => [f, { v, curve: [...curve] as Curve }]))])),
  props: new Map((j.props ?? []).map(([p, keys]) => [p, new Map(keys.map(([f, v, curve]) => [f, { v, curve: [...curve] as Curve }]))])),
});
// 前の形 (フレームごとにポーズ全体と表情すべて) から変換する。つなぎ方は直線
export function animationFromPoseKeys(keys: [number, { pose: [number, BoneValue][]; morphs: number[] | null }][]): Animation {
  const anim = createAnimation();
  const used = new Set<number>(), bones = new Set<number>();
  for (const [, k] of keys) {
    k.morphs?.forEach((v, m) => { if (v !== 0) used.add(m); });
    for (const [b] of k.pose) bones.add(b);
  }
  // (前の形では、そのキーにないボーンは 0 とみなしていたので、すべてのキーに入れる)
  for (const [f, k] of keys) {
    const pose = new Map(k.pose);
    for (const b of bones) {
      if (!anim.bones.has(b)) anim.bones.set(b, new Map());
      anim.bones.get(b)!.set(f, { v: { ...(pose.get(b) ?? ZERO_BONE) }, curve: [...LINEAR] as Curve });
    }
    for (const m of used) {
      if (!anim.morphs.has(m)) anim.morphs.set(m, new Map());
      anim.morphs.get(m)!.set(f, { v: k.morphs?.[m] ?? 0, curve: [...LINEAR] as Curve });
    }
  }
  return anim;
}
