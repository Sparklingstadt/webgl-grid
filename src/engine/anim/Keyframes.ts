import {
  channelKeys, copyKeys, createAnimation, deleteKeys, pasteKeys, type ClipChannel, evaluate, insertKeys, insertMmeKeys, insertPropKeys, isEmpty, keyFrames, moveKeys, PROPS, type BoneKey, type Channel, type Curve, type MorphKey,
} from '../../core/animation';
import { Emitter } from '../../core/events';
import { FPS } from '../../core/constants';
import type { BoneValue } from '../../core/types';
import { t } from '../../core/i18n';
import type { Posing } from '../mmd/Posing';
import type { Viewport } from '../render/Viewport';
import type { CameraSettings } from '../../core/camera';
import type { LightSettings } from '../../core/light';
import { isModel, isShape, type ModelObj, type Obj } from '../types';
import type { UiChannel } from '../UiChannel';
import type { World } from '../world/World';
import { mmeChannel } from './mmeChannels';

// --- キーフレーム (Blender の I キー) ---
// モデルのボーンと表情に、チャンネル (ボーン 1 本・表情 1 つ) ごとにキーを打つ (core/animation.ts)。
// 形・ライト・カメラには、位置 X・位置 Z・回転と、形は大きさ、ライトは強さ・色 (R・G・B)・高さ、カメラは視野角・高さのチャンネルに打つ。
// MME の値 (Obj.mmeValues) には、名前ごとのチャンネル (Obj.mmeChannels の番号。anim/mmeChannels.ts) に打つ。
// キーのあいだは、補間曲線にそって、回転は球面線形補間・位置と表情は線形補間でつなぐ。
// タイムラインでは、キーはフレームごとにまとめて選び・ずらし・消す
// 物にキーを打てる値 (PROPS の番号と、いまの値)
type PropKey = typeof PROPS[number]['key'];
const LIGHT_PROPS: PropKey[] = ['power', 'colorR', 'colorG', 'colorB', 'height'];
export function propApplies(obj: Obj, key: PropKey) {
  if (isModel(obj)) return false;
  if (key === 'x' || key === 'z' || key === 'r') return true;
  if (key === 'scale') return isShape(obj);
  if (key === 'fov') return !!obj.camera;
  if (key === 'height') return !!(obj.light || obj.camera);
  return !!obj.light && LIGHT_PROPS.includes(key);
}
const hexToRgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const rgbToHex = (c: number[]) => `#${c.map(v => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, '0')).join('')}`;
function propValue(obj: Obj, key: PropKey): number {
  switch (key) {
    case 'scale': return obj.scale ?? 1;
    case 'power': return obj.light ? (obj.light.type === 'sun' ? obj.light.strength : obj.light.power) : 0;
    case 'colorR': case 'colorG': case 'colorB': return obj.light ? hexToRgb(obj.light.color)['RGB'.indexOf(key[5])] : 0;
    case 'fov': return obj.camera?.fov ?? 0;
    case 'height': return obj.light?.height ?? obj.camera?.height ?? 0;
    default: return obj[key];
  }
}
// ライト・カメラの設定の値 (強さ・色・視野角・高さ) を当てる (Engine が Lights・Cameras につなぐ)
export interface PropTarget { light(obj: Obj, patch: Partial<LightSettings>): void; camera(obj: Obj, patch: Partial<CameraSettings>): void }

export class Keyframes {
  target: PropTarget | null = null;
  // mmeChanged: キーで MME の値 (Obj.mmeValues) が変わった物 (applyAll で、値が変わったときだけ)
  readonly events = new Emitter<{ mmeChanged: [objs: Obj[]] }>();
  readonly selected = new Set<number>(); // タイムラインで選んだフレーム (選んでいるモデルの)
  expanded = false; // タイムラインに、チャンネルごとの行を出す
  // コピーしたキー (Ctrl+C)。ボーン・表情は名前でも覚え、ほかのモデルにも同じ名前のチャンネルへ貼れる
  private clip: (ClipChannel & { name: string | null })[] | null = null;

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

  // 形・ライトの、いまの位置・回転・大きさをフレームに打つ (Blender の I: 位置・回転・拡大縮小)
  insertTransform(objs: Obj[], frame: number) {
    let n = 0;
    for (const obj of objs) {
      if (isModel(obj)) continue;
      obj.anim ??= createAnimation();
      const values = PROPS.flatMap((p, i) => (propApplies(obj, p.key) ? [[i, propValue(obj, p.key)] as [number, number]] : []));
      n += insertPropKeys(obj.anim, frame, values);
    }
    if (!n) return;
    this.selected.clear();
    this.selected.add(frame);
    this.changed();
    this.ui.toast(t('フレーム {frame} にキーを打ちました ({n} チャンネル)', { frame, n }), 2500);
  }

  // MME の値 (names: チャンネルの名前) の、いま (obj.mmeValues) の値をフレームに打つ。すでにキーがあれば値だけ替える。
  // mmeValues に値のない名前は打たない (呼ぶ側が、先に値を入れておく)
  insertMme(obj: Obj, frame: number, names: string[]) {
    const values = names.flatMap(name => {
      const v = obj.mmeValues?.[name];
      return v === undefined ? [] : [[mmeChannel(obj, name), v] as [number, number]];
    });
    if (!values.length) return;
    obj.anim ??= createAnimation();
    const n = insertMmeKeys(obj.anim, frame, values);
    this.selected.clear();
    this.selected.add(frame);
    this.changed();
    this.ui.toast(t('フレーム {frame} にキーを打ちました ({n} チャンネル)', { frame, n }), 2500);
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
  moveSelected(obj: Obj, delta: number, t: number) {
    if (!obj.anim || !delta) return;
    const moved = moveKeys(obj.anim, this.selected, delta);
    this.selected.clear();
    for (const f of moved) this.selected.add(f);
    this.applyAll(t, true);
    this.changed();
  }
  // 選んだフレームのキーを写す (Ctrl+C)
  copy(obj: Obj) {
    if (!obj.anim || !this.selected.size) { this.ui.toast(t('コピーするキーを選んでください'), 2500); return false; }
    const chans = copyKeys(obj.anim, this.selected);
    this.clip = chans.map(c => ({ ...c, name: this.channelName(obj, c) }));
    const n = chans.reduce((a, c) => a + c.keys.length, 0);
    this.ui.toast(t('キーを {n} 個コピーしました', { n }), 2500);
    return n > 0;
  }
  // 写したキーを、フレーム frame から貼る (Ctrl+V)。ボーン・表情は同じ名前のチャンネルへ、位置・回転・大きさはそのまま。
  // MME の値は、同じ名前のチャンネルか、同じ名前の値 (mmeValues) を持つ物ならチャンネルを足して貼る
  paste(obj: Obj, frame: number, time: number) {
    if (!this.clip) { this.ui.toast(t('先にキーをコピーしてください (Ctrl+C)'), 2500); return false; }
    const clip: ClipChannel[] = [];
    for (const c of this.clip) {
      const index = c.kind === 'prop' ? (PROPS[c.index] && propApplies(obj, PROPS[c.index].key) ? c.index : -1) : this.channelIndex(obj, c.kind, c.name);
      if (index >= 0) clip.push({ ...c, index });
    }
    if (!clip.length) { this.ui.toast(t('この物には、コピーしたキーのチャンネルがありません'), 3000); return false; }
    obj.anim ??= createAnimation();
    const frames = pasteKeys(obj.anim, clip, frame);
    this.selected.clear();
    for (const f of frames) this.selected.add(f);
    this.applyAll(time, true);
    this.changed();
    this.ui.toast(t('キーを {n} 個貼り付けました', { n: clip.reduce((a, c) => a + c.keys.length, 0) }), 2500);
    return true;
  }
  private channelName(obj: Obj, c: ClipChannel) {
    if (c.kind === 'mme') return obj.mmeChannels?.[c.index] ?? null;
    if (!isModel(obj) || c.kind === 'prop') return null;
    return c.kind === 'bone' ? obj.model.skeleton.bones[c.index]?.name ?? null : this.posing.morphs(obj).find(m => m.index === c.index)?.name ?? null;
  }
  private channelIndex(obj: Obj, kind: 'bone' | 'morph' | 'mme', name: string | null) {
    if (kind === 'mme') return name !== null && (obj.mmeChannels?.includes(name) || obj.mmeValues?.[name] !== undefined) ? mmeChannel(obj, name) : -1;
    if (!isModel(obj) || name === null) return -1;
    return kind === 'bone' ? obj.model.skeleton.bones.findIndex((b: { name: string }) => b.name === name) : this.posing.morphs(obj).find(m => m.name === name)?.index ?? -1;
  }

  // 選んだフレームのキーを削除する。消したら true
  deleteSelected(obj: Obj, time: number) {
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
  deleteAt(obj: Obj, frame: number, time: number, channel?: Channel) {
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
  curve(obj: Obj, channel: Channel, frame: number): Curve | null {
    const k = obj.anim && channelKeys(obj.anim, channel)?.get(frame);
    return k ? k.curve : null;
  }
  setCurve(obj: Obj, channel: Channel, frame: number, curve: Curve, t: number) {
    const k = obj.anim && channelKeys(obj.anim, channel)?.get(frame);
    if (!k) return;
    k.curve = [...curve] as Curve;
    this.applyAll(t, true);
    this.changed();
  }

  // キーの値を変える (グラフエディターで点を上下に動かす)。ボーンは comp (rx・px など) の値
  setKeyValue(obj: Obj, channel: Channel, frame: number, comp: keyof BoneValue | null, v: number, time: number) {
    const k = obj.anim && channelKeys(obj.anim, channel)?.get(frame);
    if (!k || !Number.isFinite(v)) return;
    if (channel.kind === 'bone') { if (comp) (k as BoneKey).v = { ...(k as BoneKey).v, [comp]: v }; }
    else (k as MorphKey).v = v;
    this.applyAll(time, true);
    this.changed();
  }

  // グラフエディターでキーを左右に動かす: チャンネルのキーを元の並び (base) に戻してから、from のキーを to へ置く。
  // (ドラッグの途中で別のキーの上を通っても、base に戻すので消えない。離した所に重なったキーは上書き)
  placeChannelKey(obj: Obj, channel: Channel, base: ReadonlyMap<number, BoneKey | MorphKey>, from: number, to: number, time: number) {
    const keys = obj.anim && channelKeys(obj.anim, channel);
    const k = base.get(from);
    if (!keys || !k) return;
    keys.clear();
    for (const [f, key] of base) if (f !== from) keys.set(f, key);
    keys.set(Math.max(0, Math.round(to)), k);
    this.applyAll(time, true);
    this.changed();
  }

  // 一番後ろのキー (終了フレームを合わせるため)
  lastFrame() {
    let last = 0;
    for (const o of this.world.objects) last = Math.max(last, ...keyFrames(o.anim));
    return last;
  }

  // キーのあるモデルを、時刻 t (秒) の姿勢にする。チャンネルのないボーン・表情はそのまま。
  // force でなければ、サイドバーの描き直しは間引く (再生中は毎フレーム呼ばれるので)
  applyAll(t: number, force = false) {
    let any = false, moved = false;
    const mmeChanged: Obj[] = [];
    for (const obj of this.world.objects) {
      if (isEmpty(obj.anim)) continue;
      const { pose, morphs, props, mme } = evaluate(obj.anim!, t * FPS);
      if (mme.size && this.applyMme(obj, mme)) mmeChanged.push(obj);
      // 物の値 (位置・回転・大きさ)、ライト・カメラの設定 (強さ・色・視野角・高さ)
      const light: Partial<LightSettings> = {}, cam: Partial<CameraSettings> = {};
      let rgb: number[] | null = null;
      for (const [p, v] of props) {
        const key = PROPS[p]?.key;
        if (!key || !propApplies(obj, key)) continue;
        if (key === 'scale') obj.scale = v === 1 ? undefined : Math.max(v, 0.05);
        else if (key === 'x' || key === 'z' || key === 'r') obj[key] = v;
        else if (key === 'power') { if (obj.light?.type === 'sun') light.strength = Math.max(v, 0); else light.power = Math.max(v, 0); }
        else if (key === 'fov') cam.fov = v;
        else if (key === 'height') { if (obj.light) light.height = v; else cam.height = v; }
        else { rgb ??= hexToRgb(obj.light!.color); rgb['RGB'.indexOf(key[5])] = v; }
        moved = true;
      }
      if (rgb) light.color = rgbToHex(rgb);
      if (obj.light && Object.keys(light).length) this.target?.light(obj, light);
      if (obj.camera && Object.keys(cam).length) this.target?.camera(obj, cam);
      any = true;
      if (!isModel(obj)) continue;
      // 手で動かしたが、まだキーのないボーンは残す (キーを打つまで)
      for (const [b, v] of obj.pose ?? []) if (!obj.anim!.bones.has(b)) pose.set(b, v);
      obj.pose = pose;
      const inf: number[] | undefined = obj.model.morphTargetInfluences;
      if (inf) for (const [m, v] of morphs) inf[m] = v;
      if (!obj.animated) this.posing.solve(obj); // モーションのあるモデルは、毎フレームのモーションのあとに当てる
    }
    if (moved) {
      // 動かした物は、積み重ねの高さにすぐ置く (落ちてくる動きにしない)
      this.world.settle();
      for (const o of this.world.objects) if (o.anim?.props.size) { o.py = o.y; o.vy = 0; }
    }
    if (mmeChanged.length) this.events.emit('mmeChanged', mmeChanged);
    if (!any) return;
    if (force) this.ui.bump('values'); else this.ui.bumpValuesThrottled();
    this.viewport.requestDraw();
  }
  // MME のチャンネルの値 (番号 → 値) を mmeValues に書く。変わった値があれば true
  private applyMme(obj: Obj, mme: Map<number, number>) {
    let changed = false;
    for (const [ch, v] of mme) {
      const name = obj.mmeChannels?.[ch];
      if (name === undefined) continue;
      const values = obj.mmeValues ??= {};
      if (values[name] !== v) { values[name] = v; changed = true; }
    }
    return changed;
  }

  private changed() {
    this.ui.bump('keysVersion');
    this.ui.bump('values');
  }
}
