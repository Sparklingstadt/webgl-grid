import * as THREE from 'three';
import { DEG } from '../../core/constants';
import { ZERO_BONE, type BoneValue } from '../../core/types';
import type { System, Viewport } from '../render/Viewport';
import type { ModelObj } from '../types';
import type { UiChannel } from '../UiChannel';
import type { World } from '../world/World';
import type { Motion } from './Motion';
import type { Physics } from './Physics';

export interface MorphItem { name: string; index: number; panel: number }
export interface BoneGroup { label: string; bones: { index: number; name: string }[] }
// 並べるのは、MMD で操作できるボーン (表示 0x08・操作可 0x10) で、回転 0x02 か移動 0x04 ができるもの
export const BONE_ROTATE = 0x02, BONE_MOVE = 0x04;
const BONE_VISIBLE = 0x08, BONE_OPERABLE = 0x10;

const _e = new THREE.Euler(), _q = new THREE.Quaternion();

// --- 表情 (モーフ) とボーンを手で動かす ---
// VMD で動かしている表情はモーション側が優先され、手で動かしたボーンはモーションより優先される
export class Posing implements System {
  constructor(private world: World, private physics: Physics, private motion: Motion, private viewport: Viewport, private ui: UiChannel) {}

  // --- 表情 ---
  morphs(obj: ModelObj): MorphItem[] {
    const mesh = obj.model, panels: Map<string, number> | undefined = mesh.userData.morphPanels;
    mesh.userData.morphList ??= Object.entries(mesh.morphTargetDictionary ?? {}).map(([name, index]) => ({
      name, index, panel: panels?.get(name) || 4, // 分類が分からないものは「その他」に
    }));
    return mesh.userData.morphList;
  }
  morphValue(obj: ModelObj, i: number): number { return obj.model.morphTargetInfluences?.[i] ?? 0; }
  setMorph(obj: ModelObj, i: number, v: number) {
    const inf = obj.model.morphTargetInfluences;
    if (!inf) return;
    inf[i] = v;
    this.changed();
  }
  resetMorphs(obj: ModelObj) {
    obj.model.morphTargetInfluences?.fill(0);
    this.changed();
  }

  // --- ボーン (表示枠ごとにまとめる) ---
  boneGroups(obj: ModelObj): BoneGroup[] {
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
  // サイドバーで選んでいるボーン (最初は一覧の先頭)
  boneSel(obj: ModelObj): number | undefined {
    const all = this.boneGroups(obj).flatMap(g => g.bones.map(b => b.index));
    if (obj.boneSel === undefined || !all.includes(obj.boneSel)) obj.boneSel = all[0];
    return obj.boneSel;
  }
  setBoneSel(obj: ModelObj, i: number) { obj.boneSel = i; this.ui.bump('values'); }
  boneFlags(obj: ModelObj, i: number): number { return obj.model.userData.boneFlags?.[i] ?? 0; }
  boneValue(obj: ModelObj, i: number): BoneValue { return obj.pose?.get(i) ?? ZERO_BONE; }
  boneNote(obj: ModelObj, i: number) {
    if (obj.anim?.bones.has(i)) return 'このボーンにはキーがあるので、フレームを動かすとキーの値に戻ります (「◆」でキーを打つと残せます)';
    if (obj.animated) return 'モーション再生中は、ここで動かしたボーンがモーションより優先されます';
    return (this.boneFlags(obj, i) & BONE_MOVE) && /ＩＫ|IK/.test(obj.model.skeleton.bones[i].name) ? 'IK を動かすと、つながった骨がついてきます' : '';
  }
  setBone(obj: ModelObj, i: number, key: keyof BoneValue, v: number) {
    obj.pose ??= new Map();
    obj.pose.set(i, { ...(obj.pose.get(i) ?? ZERO_BONE), [key]: v });
    this.solve(obj);
    this.viewport.startTicking();
    this.changed();
  }
  resetPose(obj: ModelObj) {
    obj.pose?.clear();
    this.solve(obj);
    this.changed();
  }
  private changed() {
    this.ui.bump('values');
    this.viewport.requestDraw();
  }

  // 手で動かした値をボーンに当てる (モーションの姿勢を上書きする)
  apply(obj: ModelObj) {
    const bones: THREE.Bone[] = obj.model.skeleton.bones, rest = obj.model.userData.rest;
    for (const [i, v] of obj.pose ?? []) {
      bones[i].quaternion.copy(rest[i].q).multiply(_q.setFromEuler(_e.set(v.rx * DEG, v.ry * DEG, v.rz * DEG, 'YXZ')));
      bones[i].position.set(rest[i].p.x + v.px, rest[i].p.y + v.py, rest[i].p.z + v.pz);
    }
  }
  // モーションのないモデルは、最初の姿勢に戻してから手の値を当て、IK と付与 (連動する骨) を計算し直す。
  // (付与は今の姿勢に足し込む計算なので、毎回最初の姿勢からやり直さないと回り続ける)
  // 物理演算で動く骨はそのままにする
  async solve(obj: ModelObj) {
    if (obj.animated) return; // モーションのあるモデルは、毎フレームのモーションのあとに当てる (update)
    const mesh = obj.model, bones: THREE.Bone[] = mesh.skeleton.bones, rest = mesh.userData.rest;
    const physicsBones = this.physics.dynamicBones(obj);
    bones.forEach((b, i) => {
      if (physicsBones.has(b)) return;
      b.position.copy(rest[i].p);
      b.quaternion.copy(rest[i].q);
    });
    this.apply(obj);
    if (!obj.solvers) {
      const [helper, { CCDIKSolver }] = await Promise.all([this.motion.ensureHelper(), import('../../vendor/three-mmd/CCDIKSolver.js')]);
      obj.solvers = { ik: new CCDIKSolver(mesh, mesh.geometry.userData.MMD.iks), grant: helper.createGrantSolver(mesh) };
    }
    mesh.updateMatrixWorld(true);
    obj.solvers!.ik.update();
    obj.solvers!.grant.update();
    this.viewport.requestDraw();
  }

  // 毎フレーム、モーションのあるモデルに手で動かしたボーン (とキーフレーム) を重ねる
  active() { return this.world.models.some(b => b.animated && b.pose?.size); }
  update() { for (const b of this.world.models) if (b.animated && b.pose?.size) this.apply(b); }
}
