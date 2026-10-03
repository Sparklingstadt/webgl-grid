import * as THREE from 'three';
import { DEG } from '../constants';
import { requestDraw, startTicking } from '../loop';
import { selModel } from '../selection';
import { ZERO_BONE, type BoneValue, type Obj } from '../types';
import { bump } from '../ui';
import { ensureAnimHelper } from './motion';
import { physicsList } from './physics';

// --- 表情 (モーフ) とボーンを手で動かす (サイドバーの「表情」「ボーン」) ---
// VMD で動かしている表情はモーション側が優先され、手で動かしたボーンはモーションより優先される

export interface MorphItem { name: string; index: number; panel: number }
export function getMorphs(): MorphItem[] {
  const obj = selModel();
  if (!obj) return [];
  const mesh = obj.model, panels: Map<string, number> | undefined = mesh.userData.morphPanels;
  mesh.userData.morphList ??= Object.entries(mesh.morphTargetDictionary ?? {}).map(([name, index]) => ({
    name, index, panel: panels?.get(name) || 4, // 分類が分からないものは「その他」に
  }));
  return mesh.userData.morphList;
}
export const getMorphValue = (i: number): number => selModel()?.model.morphTargetInfluences?.[i] ?? 0;
export function setMorphValue(i: number, v: number) {
  const inf = selModel()?.model.morphTargetInfluences;
  if (!inf) return;
  inf[i] = v;
  bump('values');
  requestDraw();
}
export function resetMorphs() {
  selModel()?.model.morphTargetInfluences?.fill(0);
  bump('values');
  requestDraw();
}

// --- ボーン ---
// 並べるのは、MMD で操作できるボーン (表示 0x08・操作可 0x10) で、回転 0x02 か移動 0x04 ができるもの。
// 表示枠ごとにまとめる
export const BONE_ROTATE = 0x02, BONE_MOVE = 0x04;
const BONE_VISIBLE = 0x08, BONE_OPERABLE = 0x10;
export interface BoneGroup { label: string; bones: { index: number; name: string }[] }
export function getBoneGroups(): BoneGroup[] {
  const obj = selModel();
  if (!obj) return [];
  const mesh = obj.model;
  if (mesh.userData.boneGroups) return mesh.userData.boneGroups;
  const flags: number[] = mesh.userData.boneFlags ?? [], bones: THREE.Bone[] = mesh.skeleton.bones;
  const ok = new Set(flags.map((_, i) => i).filter(i => (flags[i] & BONE_VISIBLE) && (flags[i] & BONE_OPERABLE) && (flags[i] & (BONE_ROTATE | BONE_MOVE))));
  const used = new Set<number>(), groups: BoneGroup[] = [];
  const addGroup = (label: string, list: number[]) => {
    const g: BoneGroup = { label, bones: [] };
    for (const i of list) {
      if (!ok.has(i) || used.has(i)) continue;
      used.add(i);
      g.bones.push({ index: i, name: bones[i].name });
    }
    if (g.bones.length) groups.push(g);
  };
  for (const f of mesh.userData.boneFrames ?? []) addGroup(f.name || 'Root', f.bones);
  addGroup('その他', [...ok]);
  return mesh.userData.boneGroups = groups;
}
export function getBoneSel(): number | undefined {
  const obj = selModel();
  if (!obj) return;
  const all = getBoneGroups().flatMap(g => g.bones.map(b => b.index));
  if (obj.boneSel === undefined || !all.includes(obj.boneSel)) obj.boneSel = all[0];
  return obj.boneSel;
}
export function setBoneSel(i: number) {
  const obj = selModel();
  if (obj) { obj.boneSel = i; bump('values'); }
}
export const getBoneFlags = (i: number): number => selModel()?.model.userData.boneFlags?.[i] ?? 0;
export const getBoneValue = (i: number): BoneValue => selModel()?.pose?.get(i) ?? ZERO_BONE;
export function boneNote(i: number) {
  const obj = selModel();
  if (!obj) return '';
  if (obj.keys?.size) return 'キーフレームがあるので、フレームを動かすとキーフレームの値に戻ります (「◆ キー挿入」で残せます)';
  if (obj.animated) return 'モーション再生中は、ここで動かしたボーンがモーションより優先されます';
  return (getBoneFlags(i) & BONE_MOVE) && /ＩＫ|IK/.test(obj.model.skeleton.bones[i].name) ? 'IK を動かすと、つながった骨がついてきます' : '';
}
export function setBoneValue(i: number, key: keyof BoneValue, v: number) {
  const obj = selModel();
  if (!obj) return;
  obj.pose ??= new Map();
  const cur = { ...(obj.pose.get(i) ?? ZERO_BONE) };
  cur[key] = v;
  obj.pose.set(i, cur);
  solvePose(obj);
  startTicking();
  bump('values');
  requestDraw();
}
export function resetPose() {
  const obj = selModel();
  if (!obj) return;
  obj.pose?.clear();
  solvePose(obj);
  bump('values');
  requestDraw();
}

// 手で動かした値をボーンに当てる (モーションの姿勢を上書きする)
const _poseEuler = new THREE.Euler();
const _poseQ = new THREE.Quaternion();
export function applyPose(obj: Obj) {
  const bones: THREE.Bone[] = obj.model.skeleton.bones, rest = obj.model.userData.rest;
  for (const [i, v] of obj.pose!) {
    bones[i].quaternion.copy(rest[i].q).multiply(_poseQ.setFromEuler(_poseEuler.set(v.rx * DEG, v.ry * DEG, v.rz * DEG, 'YXZ')));
    bones[i].position.set(rest[i].p.x + v.px, rest[i].p.y + v.py, rest[i].p.z + v.pz);
  }
}
// モーションのないモデルは、最初の姿勢に戻してから手の値を当て、IK と付与 (連動する骨) を計算し直す。
// (付与は今の姿勢に足し込む計算なので、毎回最初の姿勢からやり直さないと回り続ける)
// 物理演算で動く骨はそのままにする
export async function solvePose(obj: Obj) {
  if (obj.animated) return; // モーションのあるモデルは、毎フレームのモーションのあとに applyPose する
  const mesh = obj.model, bones: THREE.Bone[] = mesh.skeleton.bones, rest = mesh.userData.rest;
  const p = physicsList.find(p => p.obj === obj);
  const physicsBones = new Set(p?.dynamic.map(b => b.bone));
  bones.forEach((b, i) => {
    if (physicsBones.has(b)) return;
    b.position.copy(rest[i].p);
    b.quaternion.copy(rest[i].q);
  });
  if (obj.pose) applyPose(obj);
  if (!obj.solvers) {
    const [helper, { CCDIKSolver }] = await Promise.all([ensureAnimHelper(), import('three/examples/jsm/animation/CCDIKSolver.js')]);
    obj.solvers = { ik: new CCDIKSolver(mesh, mesh.geometry.userData.MMD.iks), grant: helper.createGrantSolver(mesh) };
  }
  mesh.updateMatrixWorld(true);
  obj.solvers!.ik.update();
  obj.solvers!.grant.update();
  requestDraw();
}
