import {
  channelKeys, createAnimation, deleteKeys, evaluate, insertKeys, isEmpty, keyFrames, moveKeys, type Channel, type Curve,
} from '../../core/animation';
import { FPS } from '../../core/constants';
import { t } from '../../core/i18n';
import type { Posing } from '../mmd/Posing';
import type { Viewport } from '../render/Viewport';
import type { ModelObj } from '../types';
import type { UiChannel } from '../UiChannel';
import type { World } from '../world/World';

// --- キーフレーム (Blender の I キー) ---
// モデルのボーンと表情に、チャンネル (ボーン 1 本・表情 1 つ) ごとにキーを打つ (core/animation.ts)。
// キーのあいだは、補間曲線にそって、回転は球面線形補間・位置と表情は線形補間でつなぐ。
// タイムラインでは、キーはフレームごとにまとめて選び・ずらし・消す
export class Keyframes {
  readonly selected = new Set<number>(); // タイムラインで選んだフレーム (選んでいるモデルの)
  expanded = false; // タイムラインに、チャンネルごとの行を出す

  constructor(private world: World, private posing: Posing, private viewport: Viewport, private ui: UiChannel) {}

  // いまのポーズ (手で動かしたボーン) と表情を、フレームに打つ。only を渡すと、そのボーンだけ
  insert(obj: ModelObj, frame: number, only?: number[]) {
    obj.anim ??= createAnimation();
    const inf: number[] | undefined = obj.model.morphTargetInfluences;
    const n = insertKeys(obj.anim, frame, obj.pose ?? new Map(), inf ?? null, only);
    this.selected.clear();
    this.selected.add(frame);
    this.changed();
    const names = only?.map(i => obj.model.skeleton.bones[i]?.name).join('、');
    this.ui.toast(only ? t('フレーム {frame} に {names} のキーを打ちました', { frame, names: names ?? '' }) : t('フレーム {frame} にキーを打ちました ({n} チャンネル)', { frame, n }), 2500);
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
  setExpanded(on: boolean) { this.expanded = on; this.ui.bump('keysVersion'); }

  // 選んだフレームのキーを delta フレームずらす (重なった先のキーは上書き)
  moveSelected(obj: ModelObj, delta: number, t: number) {
    if (!obj.anim || !delta) return;
    const moved = moveKeys(obj.anim, this.selected, delta);
    this.selected.clear();
    for (const f of moved) this.selected.add(f);
    this.applyAll(t, true);
    this.changed();
  }
  // 選んだフレームのキーを削除する。消したら true
  deleteSelected(obj: ModelObj, time: number) {
    if (!obj.anim || !this.selected.size) return false;
    const n = deleteKeys(obj.anim, this.selected);
    this.selected.clear();
    if (isEmpty(obj.anim)) obj.anim = null;
    this.applyAll(time, true);
    this.changed();
    if (n) this.ui.toast(t('キーを {n} 個削除しました', { n }), 2500);
    return n > 0;
  }
  // フレーム frame にあるキーを削除 (Alt+I)。channel を渡すと、そのチャンネルのキーだけ
  deleteAt(obj: ModelObj, frame: number, time: number, channel?: Channel) {
    if (!keyFrames(obj.anim).includes(frame)) { this.ui.toast(t('フレーム {frame} にはキーがありません', { frame }), 2500); return; }
    if (channel) {
      deleteKeys(obj.anim!, [frame], channel);
      if (isEmpty(obj.anim)) obj.anim = null;
      this.applyAll(time, true);
      this.changed();
      return;
    }
    this.selected.clear();
    this.selected.add(frame);
    this.deleteSelected(obj, time);
  }

  // チャンネルの、フレーム frame のキーの補間曲線 (キーがなければ null)
  curve(obj: ModelObj, channel: Channel, frame: number): Curve | null {
    const k = obj.anim && channelKeys(obj.anim, channel)?.get(frame);
    return k ? k.curve : null;
  }
  setCurve(obj: ModelObj, channel: Channel, frame: number, curve: Curve, t: number) {
    const k = obj.anim && channelKeys(obj.anim, channel)?.get(frame);
    if (!k) return;
    k.curve = [...curve] as Curve;
    this.applyAll(t, true);
    this.changed();
  }

  // 一番後ろのキー (終了フレームを合わせるため)
  lastFrame() {
    let last = 0;
    for (const o of this.world.models) last = Math.max(last, ...keyFrames(o.anim));
    return last;
  }

  // キーのあるモデルを、時刻 t (秒) の姿勢にする。チャンネルのないボーン・表情はそのまま。
  // force でなければ、サイドバーの描き直しは間引く (再生中は毎フレーム呼ばれるので)
  applyAll(t: number, force = false) {
    let any = false;
    for (const obj of this.world.models) {
      if (isEmpty(obj.anim)) continue;
      const { pose, morphs } = evaluate(obj.anim!, t * FPS);
      // 手で動かしたが、まだキーのないボーンは残す (キーを打つまで)
      for (const [b, v] of obj.pose ?? []) if (!obj.anim!.bones.has(b)) pose.set(b, v);
      obj.pose = pose;
      const inf: number[] | undefined = obj.model.morphTargetInfluences;
      if (inf) for (const [m, v] of morphs) inf[m] = v;
      any = true;
      if (!obj.animated) this.posing.solve(obj); // モーションのあるモデルは、毎フレームのモーションのあとに当てる
    }
    if (!any) return;
    if (force) this.ui.bump('values'); else this.ui.bumpValuesThrottled();
    this.viewport.requestDraw();
  }

  private changed() {
    this.ui.bump('keysVersion');
    this.ui.bump('values');
  }
}
