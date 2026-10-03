import { FPS } from './constants';
import { interpolateKeys } from './keyframeMath';
import { requestDraw } from './loop';
import { solvePose } from './mmd/pose';
import { boxes } from './objects';
import { selModel, selectedKeys } from './selection';
import { currentFrame, setRange, tl } from './timeline';
import type { BoneValue, Obj } from './types';
import { bump, bumpValuesThrottled, toast } from './ui';

// --- キーフレーム (Blender の I キー) ---
// 選んでいるモデルの、いまのポーズ (手で動かしたボーン) と表情を、いまのフレームに記録する。
// キーフレームのあいだは、回転は球面線形補間、位置と表情は線形補間でつなぐ

export function insertKey() {
  const obj = selModel();
  if (!obj) { toast('キーフレームを打つ MMD モデルをクリックして選んでください。'); return; }
  const f = currentFrame();
  const pose = new Map<number, BoneValue>();
  for (const [i, v] of obj.pose ?? []) pose.set(i, { ...v });
  const inf: number[] | undefined = obj.model.morphTargetInfluences;
  obj.keys ??= new Map();
  obj.keys.set(f, { pose, morphs: inf ? Float32Array.from(inf) : null });
  selectedKeys.clear();
  selectedKeys.add(f);
  if (f > tl.end) setRange(tl.start, f);
  bump('keysVersion');
  bump('values');
  toast(`フレーム ${f} にキーフレームを挿入しました (ボーン ${pose.size} 本と表情)`, 2500);
}

export const getSelectedKeys = () => selectedKeys;
// frames を選ぶ。add なら今の選択に足す (選んであるものは外す)
export function selectKeys(frames: number[], add: boolean) {
  if (!add) selectedKeys.clear();
  for (const f of frames) {
    if (add && selectedKeys.has(f)) selectedKeys.delete(f); else selectedKeys.add(f);
  }
  bump('keysVersion');
}
// 選んだキーフレームを delta フレームずらす (重なった先のキーフレームは上書き)
export function moveSelectedKeys(delta: number) {
  const obj = selModel();
  if (!obj?.keys || !delta) return;
  const keys = obj.keys;
  const moving = [...selectedKeys].filter(f => keys.has(f)).map(f => [f, keys.get(f)!] as const);
  for (const [f] of moving) keys.delete(f);
  selectedKeys.clear();
  for (const [f, k] of moving) {
    const nf = Math.max(0, f + delta);
    keys.set(nf, k);
    selectedKeys.add(nf);
  }
  applyAllKeys(true);
  bump('keysVersion');
}
// 選んだキーフレームを削除する。消したら true
export function deleteSelectedKeys() {
  const obj = selModel();
  if (!obj?.keys || !selectedKeys.size) return false;
  const keys = obj.keys;
  const n = [...selectedKeys].filter(f => keys.delete(f)).length;
  selectedKeys.clear();
  if (!keys.size) obj.keys = null;
  applyAllKeys(true);
  bump('keysVersion');
  if (n) toast(`キーフレームを ${n} 個削除しました`, 2500);
  return n > 0;
}
// いまのフレームにあるキーフレームを削除 (Alt+I)
export function deleteKeyHere() {
  const obj = selModel();
  const f = currentFrame();
  if (!obj?.keys?.has(f)) { toast(`フレーム ${f} にはキーフレームがありません`, 2500); return; }
  selectedKeys.clear();
  selectedKeys.add(f);
  deleteSelectedKeys();
}

// フレーム f (小数も可) の姿勢を、前後のキーフレームから求めて obj.pose と表情に入れる
function evalKeys(obj: Obj, f: number) {
  const { pose, morphs } = interpolateKeys(obj.keys!, f);
  obj.pose = pose;
  const inf: number[] | undefined = obj.model.morphTargetInfluences;
  if (inf && morphs) for (let m = 0; m < inf.length; m++) inf[m] = morphs[m];
}
// キーフレームのあるモデルを、いまのフレームの姿勢にする。
// force でなければ、サイドバーの描き直しは間引く (再生中は毎フレーム呼ばれるので)
export function applyAllKeys(force = false) {
  const f = tl.t * FPS;
  let any = false;
  for (const obj of boxes) {
    if (!obj.keys?.size) continue;
    evalKeys(obj, f);
    any = true;
    if (!obj.animated) solvePose(obj); // モーションのあるモデルは、描画ループの中で applyPose する
  }
  if (!any) return;
  if (force) bump('values'); else bumpValuesThrottled();
  requestDraw();
}
