import type * as THREE from 'three';
import { SHAPE_NAMES } from './constants';
import { requestDraw } from './loop';
import { boxes } from './objects';
import type { Obj } from './types';
import { bump, ui } from './ui';

// --- 選択 (Blender のように、選んだ物はオレンジの輪郭線で囲む) ---
export let selObj: Obj | null = null;
export const selectedKeys = new Set<number>(); // タイムラインで選んだキーフレーム (選んでいるモデルの)
// 選んでいる MMD モデル (形を選んでいるときや、何も選んでいないときは null)
export const selModel = () => (selObj?.s === 3 ? selObj : null);

export function selectObj(obj: Obj | null) {
  if (selObj === obj) return;
  selObj = obj;
  selectedKeys.clear();
  publishSel();
  bump('modelVersion');
  bump('keysVersion');
  requestDraw();
}
export const selectById = (id: number | null) => selectObj(boxes.find(b => b.id === id) ?? null);

// 選んでいる物の名前・位置などを画面に知らせる (変わったときだけ)
export function publishSel() {
  const o = selObj;
  if (!o) { ui.set({ sel: null }); return; }
  const prev = ui.get().sel;
  const name = o.s === 3 ? (o.model.name || 'モデル') : SHAPE_NAMES[o.s];
  if (prev && prev.id === o.id && prev.x === o.x && prev.y === o.y && prev.z === o.z && prev.r === o.r &&
      prev.c === o.c && prev.animated === !!o.animated && prev.name === name) return;
  ui.set({ sel: { id: o.id, kind: o.s === 3 ? 'model' : 'shape', name, c: o.c, x: o.x, y: o.y, z: o.z, r: o.r, animated: !!o.animated } });
}

// 輪郭線 (OutlineEffect) の色・太さを、選択中はオレンジに変える。MMD モデルは輪郭線のない材質にも付ける
const SELECT_COLOR = [1, 0.35, 0.02]; // #ffa028 (リニア)
export function setOutlined(obj: Obj, on: boolean) {
  if (!!obj.outlined === on) return;
  obj.outlined = on;
  obj.node.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    for (const m of [mesh.material].flat()) {
      const ud = m.userData;
      ud.baseOutline ??= { ...(ud.outlineParameters ?? { visible: false }) };
      ud.outlineParameters = on
        ? { ...ud.baseOutline, visible: true, color: SELECT_COLOR, alpha: 1,
            thickness: obj.s === 3 ? Math.max(ud.baseOutline.thickness ?? 0, 0.004) : 0.008 }
        : { ...ud.baseOutline };
    }
  });
}
