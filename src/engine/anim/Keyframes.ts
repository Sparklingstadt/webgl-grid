import { FPS } from '../../core/constants';
import { interpolateKeys } from '../../core/keyframeMath';
import type { BoneValue } from '../../core/types';
import type { Posing } from '../mmd/Posing';
import type { Viewport } from '../render/Viewport';
import type { ModelObj } from '../types';
import type { UiChannel } from '../UiChannel';
import type { World } from '../world/World';

// --- キーフレーム (Blender の I キー) ---
// モデルの、いまのポーズ (手で動かしたボーン) と表情を、フレームに記録する。
// キーフレームのあいだは、回転は球面線形補間、位置と表情は線形補間でつなぐ (core/keyframeMath.ts)
export class Keyframes {
  readonly selected = new Set<number>(); // タイムラインで選んだキーフレーム (選んでいるモデルの)

  constructor(private world: World, private posing: Posing, private viewport: Viewport, private ui: UiChannel) {}

  insert(obj: ModelObj, frame: number) {
    const pose = new Map<number, BoneValue>();
    for (const [i, v] of obj.pose ?? []) pose.set(i, { ...v });
    const inf: number[] | undefined = obj.model.morphTargetInfluences;
    obj.keys ??= new Map();
    obj.keys.set(frame, { pose, morphs: inf ? Float32Array.from(inf) : null });
    this.selected.clear();
    this.selected.add(frame);
    this.ui.bump('keysVersion');
    this.ui.bump('values');
    this.ui.toast(`フレーム ${frame} にキーフレームを挿入しました (ボーン ${pose.size} 本と表情)`, 2500);
  }

  // frames を選ぶ。add なら今の選択に足す (選んであるものは外す)
  select(frames: number[], add: boolean) {
    if (!add) this.selected.clear();
    for (const f of frames) {
      if (add && this.selected.has(f)) this.selected.delete(f); else this.selected.add(f);
    }
    this.ui.bump('keysVersion');
  }
  clearSelection() { this.selected.clear(); }

  // 選んだキーフレームを delta フレームずらす (重なった先のキーフレームは上書き)
  moveSelected(obj: ModelObj, delta: number, t: number) {
    const keys = obj.keys;
    if (!keys || !delta) return;
    const moving = [...this.selected].filter(f => keys.has(f)).map(f => [f, keys.get(f)!] as const);
    for (const [f] of moving) keys.delete(f);
    this.selected.clear();
    for (const [f, k] of moving) {
      const nf = Math.max(0, f + delta);
      keys.set(nf, k);
      this.selected.add(nf);
    }
    this.applyAll(t, true);
    this.ui.bump('keysVersion');
  }
  // 選んだキーフレームを削除する。消したら true
  deleteSelected(obj: ModelObj, t: number) {
    const keys = obj.keys;
    if (!keys || !this.selected.size) return false;
    const n = [...this.selected].filter(f => keys.delete(f)).length;
    this.selected.clear();
    if (!keys.size) obj.keys = null;
    this.applyAll(t, true);
    this.ui.bump('keysVersion');
    if (n) this.ui.toast(`キーフレームを ${n} 個削除しました`, 2500);
    return n > 0;
  }
  // フレーム frame にあるキーフレームを削除 (Alt+I)
  deleteAt(obj: ModelObj, frame: number, t: number) {
    if (!obj.keys?.has(frame)) { this.ui.toast(`フレーム ${frame} にはキーフレームがありません`, 2500); return; }
    this.selected.clear();
    this.selected.add(frame);
    this.deleteSelected(obj, t);
  }

  // 一番後ろのキーフレーム (終了フレームを合わせるため)
  lastFrame() {
    let last = 0;
    for (const o of this.world.models) if (o.keys) last = Math.max(last, ...o.keys.keys());
    return last;
  }

  // キーフレームのあるモデルを、時刻 t (秒) の姿勢にする。
  // force でなければ、サイドバーの描き直しは間引く (再生中は毎フレーム呼ばれるので)
  applyAll(t: number, force = false) {
    let any = false;
    for (const obj of this.world.models) {
      if (!obj.keys?.size) continue;
      const { pose, morphs } = interpolateKeys(obj.keys, t * FPS);
      obj.pose = pose;
      const inf: number[] | undefined = obj.model.morphTargetInfluences;
      if (inf && morphs) for (let m = 0; m < inf.length; m++) inf[m] = morphs[m];
      any = true;
      if (!obj.animated) this.posing.solve(obj); // モーションのあるモデルは、毎フレームのモーションのあとに当てる
    }
    if (!any) return;
    if (force) this.ui.bump('values'); else this.ui.bumpValuesThrottled();
    this.viewport.requestDraw();
  }
}
