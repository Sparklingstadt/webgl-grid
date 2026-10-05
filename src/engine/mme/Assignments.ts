import { joinPath } from '../../core/fx/source.ts';
import { t } from '../../core/i18n';
import { resolveDefault, type DefaultRule } from '../../core/mme/defaultEffect.ts';
import type { EffectRef, SavedSlot } from '../../core/mme/settings.ts';
import { isModel, type Obj } from '../types';
import { nameOf } from '../world/Selection';
import { findFile, type EffectFolder, type EffectStore, type LoadedEffect } from './EffectStore';
import { mmdSourceOf } from './mmdData';
import type { Slot, SlotFor } from './ScenePass';

// --- 物ごと・材質ごとのエフェクトの割り当て (Obj.mme) から、タブ ('Main' かオフスクリーン) で物の材質を何で描くかを決める ---

// オフスクリーンの DefaultEffect: 規則と、規則のパスの基 (宣言しているエフェクトのエントリーの .fx があるフォルダ。フォルダからの相対)
export interface DefaultsOf { rules: DefaultRule[]; base: string; folder: EffectFolder }

const HIDE: Slot = { kind: 'hide' };

// .pmx のファイル名 (形に登録した .pmx、なければ読み込んだときの File)。分からなければ null
function pmxName(mesh: { geometry: object; userData: Record<string, unknown> }): string | null {
  const src = mmdSourceOf(mesh.geometry) ?? mesh.userData.sourceFile;
  return src instanceof File ? src.name : null;
}

// DefaultEffect と照らす物の名前: MMD モデルは .pmx のファイル名、ほかは付けた名前か種類の名前
export function objectName(obj: Obj): string {
  return (isModel(obj) && pmxName(obj.model)) || nameOf(obj);
}

export class Assignments {
  private warned = new Set<string>(); // 警告を出した、見つからない・コンパイルできない割り当て

  constructor(private store: EffectStore, private warn: (message: string) => void) {}

  // そのタブで物の材質を描くもの: 材質の割り当て → 物の割り当て → DefaultEffect があればその規則 (どれにも合わなければ hide。
  // none は default.fx) → なければ (Main) default.fx。割り当ては呼ぶたびに Obj.mme から読む。
  // Main: 割り当てた .fx が見つからなければ警告を 1 回出して次の決め方に回し、コンパイルできない .fx は default.fx で描く。
  // オフスクリーンのタブ (defaults がある): 見つからない・コンパイルできない .fx は描かない (hide。警告は 1 回)。
  // G バッファや影のマップに MMD の陰影を書くと絵が壊れるので、default.fx にはしない
  slotFor(tab: string, defaults: DefaultsOf | null, owner: Obj | null): SlotFor {
    const fallback: Slot = { kind: 'effect', effect: this.store.defaultEffect };
    const offscreen = defaults !== null ? tab : null;
    return (obj, mesh, materialIndex) => {
      const effects = obj?.mme?.[tab];
      const own = this.slot(effects?.materials?.[materialIndex], offscreen) ?? this.slot(effects?.object, offscreen);
      if (own) return own;
      if (!defaults) return fallback;
      // (ステージは置いた物ではないので、.pmx のファイル名で照らす)
      const name = obj ? objectName(obj) : pmxName(mesh) ?? '';
      const action = resolveDefault(defaults.rules, name, obj !== null && obj === owner);
      if (!action || action.kind === 'hide') return HIDE;
      if (action.kind === 'none') return fallback;
      return this.slot({ folder: defaults.folder.id, path: joinPath(defaults.base, action.path) }, offscreen) ?? HIDE;
    };
  }

  // 物の全部のタブで割り当てていて、見つかる .fx (資源を捨てない・読み込みを待つもの)。警告は出さない
  referenced(obj: Obj): LoadedEffect[] {
    const out = new Set<LoadedEffect>();
    for (const effects of Object.values(obj.mme ?? {})) {
      for (const saved of [effects.object, ...Object.values(effects.materials ?? {})]) {
        const e = saved && saved !== 'hide' ? this.find(saved, false) : null;
        if (e) out.add(e);
      }
    }
    return [...out];
  }

  // 出した警告を忘れる (描くときの警告を捨てたあと、また出す)
  clearWarnings(): void {
    this.warned.clear();
  }

  // offscreen: オフスクリーンのタブの名前 (Main は null)
  private slot(saved: SavedSlot | undefined, offscreen: string | null): Slot | null {
    if (saved === undefined) return null;
    if (saved === 'hide') return HIDE;
    const e = this.find(saved, offscreen);
    if (!e) return offscreen === null ? null : HIDE;
    if (e.result.ok) return { kind: 'effect', effect: e };
    if (offscreen === null) return { kind: 'effect', effect: this.store.defaultEffect };
    this.warnOnce(`${offscreen}\n${e.id}`, t('{name} をコンパイルできないので、オフスクリーン {tab} では描きません', { name: e.name, tab: offscreen }));
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
