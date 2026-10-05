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
  private warned = new Set<string>(); // 警告を出した、見つからない割り当て

  constructor(private store: EffectStore, private warn: (message: string) => void) {}

  // そのタブで物の材質を描くもの: 材質の割り当て → 物の割り当て → DefaultEffect があればその規則 (どれにも合わなければ hide。
  // none は default.fx) → なければ (Main) default.fx。割り当ては呼ぶたびに Obj.mme から読む。
  // 割り当てた .fx が見つからなければ警告を 1 回出して、次の決め方に回す。コンパイルできない .fx は default.fx で描く
  slotFor(tab: string, defaults: DefaultsOf | null, owner: Obj | null): SlotFor {
    const fallback: Slot = { kind: 'effect', effect: this.store.defaultEffect };
    return (obj, mesh, materialIndex) => {
      const effects = obj?.mme?.[tab];
      const own = this.slot(effects?.materials?.[materialIndex]) ?? this.slot(effects?.object);
      if (own) return own;
      if (!defaults) return fallback;
      // (ステージは置いた物ではないので、.pmx のファイル名で照らす)
      const name = obj ? objectName(obj) : pmxName(mesh) ?? '';
      const action = resolveDefault(defaults.rules, name, obj !== null && obj === owner);
      if (!action || action.kind === 'hide') return HIDE;
      if (action.kind === 'none') return fallback;
      return this.slot({ folder: defaults.folder.id, path: joinPath(defaults.base, action.path) }) ?? fallback;
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

  private slot(saved: SavedSlot | undefined): Slot | null {
    if (saved === undefined) return null;
    if (saved === 'hide') return HIDE;
    const e = this.find(saved, true);
    if (!e) return null;
    return { kind: 'effect', effect: e.result.ok ? e : this.store.defaultEffect };
  }

  // 割り当てた .fx (パスは大文字小文字と '\' を無視して探す)。フォルダかファイルがなければ null
  private find(ref: EffectRef, warn: boolean): LoadedEffect | null {
    const folder = this.store.folder(ref.folder);
    const path = folder && findFile(folder, ref.path);
    if (folder && path) return this.store.effect(folder, path);
    const key = `${ref.folder}\n${ref.path}`;
    if (warn && !this.warned.has(key)) {
      this.warned.add(key);
      this.warn(t('{path} が見つからないので、代わりに既定のエフェクトで描きます', { path: folder?.name ? `${folder.name}/${ref.path}` : ref.path }));
    }
    return null;
  }
}
