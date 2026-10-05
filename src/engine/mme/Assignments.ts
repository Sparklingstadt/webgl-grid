import type * as THREE from 'three';
import { joinPath } from '../../core/fx/source.ts';
import { t } from '../../core/i18n';
import { resolveDefault, type DefaultRule } from '../../core/mme/defaultEffect.ts';
import { sameStageName, type EffectRef, type MmeStage, type ObjectEffects, type SavedSlot } from '../../core/mme/settings.ts';
import { isModel, type Obj } from '../types';
import { nameOf } from '../world/Selection';
import { findFile, type EffectFolder, type EffectStore, type LoadedEffect } from './EffectStore';
import { mmdSourceOf } from './mmdData';
import type { Slot, SlotFor } from './ScenePass';

// --- 物ごと・材質ごとのエフェクトの割り当て (Obj.mme。ステージは場面の値 MmeScene.stage) から、タブ ('Main' かオフスクリーン) で
// 物の材質を何で描くかを決める ---

// 描いている物・オフスクリーンの持ち主: 置いた物か、ステージ (STAGE)。null は物がない (Main・ポストエフェクト)
export const STAGE = 'stage';
export type Owner = Obj | typeof STAGE | null;

// オフスクリーンの DefaultEffect: 規則と、規則のパスの基 (宣言しているエフェクトのエントリーの .fx があるフォルダ。フォルダからの相対)
export interface DefaultsOf { rules: DefaultRule[]; base: string; folder: EffectFolder }

const HIDE: Slot = { kind: 'hide' };

// .pmx のファイル名 (形に登録した .pmx、なければ読み込んだときの File)。分からなければ null
export function pmxName(mesh: { geometry: object; userData: Record<string, unknown> }): string | null {
  const src = mmdSourceOf(mesh.geometry) ?? mesh.userData.sourceFile;
  return src instanceof File ? src.name : null;
}

// ステージの名前 (.pmx のファイル名。ステージの割り当てを当てるかの照らし合わせに使う): 最初の SkinnedMesh (なければ最初の Mesh) のもの。
// ファイル名が分からなければ ''。ステージがない (メッシュがない) なら null
export function stageNameOf(root: { traverse: (f: (o: THREE.Object3D) => void) => void } | null): string | null {
  let skinned: THREE.Mesh | null = null, first: THREE.Mesh | null = null;
  root?.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    first ??= mesh;
    if (!skinned && (mesh as THREE.SkinnedMesh).isSkinnedMesh) skinned = mesh;
  });
  const mesh: THREE.Mesh | null = skinned ?? first;
  return mesh && (pmxName(mesh) ?? '');
}

// DefaultEffect・CONTROLOBJECT と照らす物の名前: MMD モデルは .pmx のファイル名、MME の物はその名前 (ray_controller.pmx・ray.x など)、
// ほかは付けた名前か種類の名前
export function objectName(obj: Obj): string {
  if (obj.mmeObj) return obj.mmeObj.name;
  return (isModel(obj) && pmxName(obj.model)) || nameOf(obj);
}

export class Assignments {
  private warned = new Set<string>(); // 警告を出した、見つからない・コンパイルできない割り当て

  // stage: ステージの割り当て (場面の値。なければ null)。名前 (.pmx のファイル名) が違うステージには当てない
  constructor(private store: EffectStore, private warn: (message: string) => void, private stage: () => MmeStage | null = () => null) {}

  // ステージ (.pmx のファイル名が name。null はステージがない) に当てる割り当て: 名前が合わなければ null (名前が違うステージには当てない)
  stageEffectsFor(name: string | null): ObjectEffects | null {
    const stage = this.stage();
    return stage && name !== null && sameStageName(stage.name, name) ? stage.effects : null;
  }

  // そのタブで物の材質を描くもの: 材質の割り当て → 物の割り当て → DefaultEffect があればその規則 (どれにも合わなければ hide。
  // none は default.fx) → なければ (Main) default.fx。割り当ては呼ぶたびに Obj.mme (ステージは stage()) から読む。
  // owner: そのオフスクリーンの持ち主 (規則の self に合う物。ステージなら STAGE)。
  // Main: 割り当てた .fx が見つからなければ警告を 1 回出して次の決め方に回し、コンパイルできない .fx は default.fx で描く。
  // オフスクリーンのタブ (defaults がある): 見つからない・コンパイルできない .fx は描かない (hide。警告は 1 回)。
  // G バッファや影のマップに MMD の陰影を書くと絵が壊れるので、default.fx にはしない。
  // 物 (ステージ) のそのタブの割り当てで決まった .fx は assigned (描くときに、その物のパラメータの値を使う。DefaultEffect・default.fx は初期値)
  slotFor(tab: string, defaults: DefaultsOf | null, owner: Owner): SlotFor {
    return (obj, mesh, materialIndex) => {
      // (ステージは置いた物ではないので、.pmx のファイル名で照らす)
      const stageName = obj ? null : pmxName(mesh) ?? '';
      const effects = obj ? obj.mme?.[tab] : this.stageEffectsFor(stageName)?.[tab];
      const name = () => (obj ? objectName(obj) : stageName ?? '');
      return this.resolve(tab, defaults, [effects?.materials?.[materialIndex], effects?.object], name, (obj ?? STAGE) === owner, false);
    };
  }

  // 割り当ての画面の行を既定に戻したら描くもの: 材質の行 (materialIndex) は物の割り当て → 既定、物の行 (null) は既定
  // (DefaultEffect か default.fx)。決め方は slotFor と同じで、警告は出さない。isOwner: 物がそのオフスクリーンの持ち主 (self に合う)
  fallbackFor(tab: string, defaults: DefaultsOf | null, obj: Obj, materialIndex: number | null, isOwner: boolean): Slot {
    const own = materialIndex === null ? [] : [obj.mme?.[tab]?.object];
    return this.resolve(tab, defaults, own, () => objectName(obj), isOwner, true);
  }

  // ステージの行の fallbackFor (name はステージの .pmx のファイル名)
  stageFallbackFor(tab: string, defaults: DefaultsOf | null, name: string, materialIndex: number | null, isOwner: boolean): Slot {
    const own = materialIndex === null ? [] : [this.stageEffectsFor(name)?.[tab]?.object];
    return this.resolve(tab, defaults, own, () => name, isOwner, true);
  }

  // 物の全部のタブで割り当てていて、見つかる .fx (資源を捨てない・読み込みを待つもの)。警告は出さない
  referenced(obj: Obj): LoadedEffect[] {
    return this.referencedIn(obj.mme);
  }

  // ステージ (.pmx のファイル名が name) の全部のタブで割り当てていて、見つかる .fx (referenced と同じ。名前が違えば空)
  referencedStage(name: string | null): LoadedEffect[] {
    return this.referencedIn(this.stageEffectsFor(name) ?? undefined);
  }

  // 保存してある (いまのステージに当たらないものも) ステージの割り当ての、見つかる .fx。当たらなくても保存するファイルに入れる
  storedStage(): LoadedEffect[] {
    return this.referencedIn(this.stage()?.effects);
  }

  private referencedIn(all: ObjectEffects | undefined): LoadedEffect[] {
    const out = new Set<LoadedEffect>();
    for (const effects of Object.values(all ?? {})) {
      for (const saved of [effects.object, ...Object.values(effects.materials ?? {})]) {
        const e = saved && saved !== 'hide' ? this.find(saved, false) : null;
        if (e) out.add(e);
      }
    }
    return [...out];
  }

  // DefaultEffect の規則で、names (場面の物とステージの名前) のどれかを描く、見つかる .fx (同じものは 1 つ)。警告は出さない。
  // 名前ごとに最初に合う規則だけを見る (どの物にも使われない規則の .fx は入れない)。self は持ち主が分からないので、
  // 持ち主のとき (self に合う) とそうでないときの両方を入れる
  defaultEffects(defaults: DefaultsOf, names: string[]): LoadedEffect[] {
    const out = new Set<LoadedEffect>();
    for (const name of names) {
      for (const isSelf of [false, true]) {
        const action = resolveDefault(defaults.rules, name, isSelf);
        const e = action?.kind === 'effect' ? this.find({ folder: defaults.folder.id, path: joinPath(defaults.base, action.path) }, false) : null;
        if (e) out.add(e);
      }
    }
    return [...out];
  }

  // 割り当てた .fx (見つからなければ null。警告は出さない)
  effectOf(ref: EffectRef): LoadedEffect | null {
    return this.find(ref, false);
  }

  // 出した警告を忘れる (描くときの警告を捨てたあと、また出す)
  clearWarnings(): void {
    this.warned.clear();
  }

  // own: 先に使う割り当て (材質 → 物の順)。見つかる・描けるものがなければ DefaultEffect の規則 (どれにも合わなければ hide。
  // none は default.fx)、なければ (Main) default.fx。quiet: 警告を出さない
  private resolve(tab: string, defaults: DefaultsOf | null, own: (SavedSlot | undefined)[], name: () => string, isSelf: boolean, quiet: boolean): Slot {
    const offscreen = defaults !== null ? tab : null;
    for (const saved of own) {
      const slot = this.slot(saved, offscreen, quiet, true);
      if (slot) return slot;
    }
    const fallback: Slot = { kind: 'effect', effect: this.store.defaultEffect };
    if (!defaults) return fallback;
    const action = resolveDefault(defaults.rules, name(), isSelf);
    if (!action || action.kind === 'hide') return HIDE;
    if (action.kind === 'none') return fallback;
    return this.slot({ folder: defaults.folder.id, path: joinPath(defaults.base, action.path) }, offscreen, quiet, false) ?? HIDE;
  }

  // offscreen: オフスクリーンのタブの名前 (Main は null)。assigned: 物の割り当て (見つかってコンパイルできれば assigned の slot にする)
  private slot(saved: SavedSlot | undefined, offscreen: string | null, quiet: boolean, assigned: boolean): Slot | null {
    if (saved === undefined) return null;
    if (saved === 'hide') return HIDE;
    const e = this.find(saved, quiet ? false : offscreen);
    if (!e) return offscreen === null ? null : HIDE;
    if (e.result.ok) return assigned ? { kind: 'effect', effect: e, assigned: true } : { kind: 'effect', effect: e };
    if (offscreen === null) return { kind: 'effect', effect: this.store.defaultEffect };
    if (!quiet) this.warnOnce(`${offscreen}\n${e.id}`, t('{name} をコンパイルできないので、オフスクリーン {tab} では描きません', { name: e.name, tab: offscreen }));
    return HIDE;
  }

  // 割り当てた .fx (パスは大文字小文字と '\' を無視して探す)。フォルダかファイルがなければ null。
  // warnIn: 見つからないときの警告 (false は出さない、null は Main の警告、文字列はそのオフスクリーンのタブの警告)
  private find(ref: EffectRef, warnIn: string | null | false): LoadedEffect | null {
    const folder = this.store.folder(ref.folder);
    const path = folder && findFile(folder, ref.path);
    if (folder && path) return this.store.effect(folder, path);
    if (warnIn === false) return null;
    const where = folder?.name ? `${folder.name}/${ref.path}` : ref.path;
    this.warnOnce(`${warnIn ?? ''}\n${ref.folder}\n${ref.path}`, warnIn === null
      ? t('{path} が見つからないので、代わりに既定のエフェクトで描きます', { path: where })
      : t('{path} が見つからないので、オフスクリーン {tab} では描きません', { path: where, tab: warnIn }));
    return null;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message);
  }
}
